#!/usr/bin/env node
/**
 * install-precompaction.mjs —— 把 dsh-precompaction 装进 DSH（带断言的脚本，不许手改配置）
 *
 * 用法：
 *   node install-precompaction.mjs --dry-run              # 只演算，不写任何东西（默认）
 *   node install-precompaction.mjs --apply                # 真装（生产参数 400k）
 *   node install-precompaction.mjs --apply --test         # 真装，但用低触发点（8000）供功能验证
 *   node install-precompaction.mjs --revert               # 从最近一次备份还原 patch 文件
 *
 * 可选：
 *   --patch <路径>      指定要改的 cordis.patch.yml（默认 <DSH_HOME>/profiles/desktop/cordis.patch.yml）
 *                       也接受 --patch=<路径>。非 desktop profile 的用户必须显式传它。
 *
 * 它做四件事（顺序固定，任一步断言不过就**停手不写盘**）：
 *   1. 备份 profiles\desktop\cordis.patch.yml → <DSH_HOME>\patch-staging\backup\<时间戳>-precompaction\
 *   2. 复制插件（lib/index.js + package.json）→ <DSH_HOME>\plugins\dsh-precompaction\
 *   3. 建目录联接 <插件>\node_modules\@deepseek-ai → <DSH_HOME>\profiles\node_modules\@deepseek-ai
 *   4. 把 patch-snippet.yml 追加到 patch 文件末尾（带 4 条断言）
 *
 * 片段 name 行里的 `@@ENTRY@@` 会被**自动替换**成
 *   file:///<你的 DSH_HOME>/plugins/dsh-precompaction/lib/index.js
 * ⇒ 你不需要手工改任何路径，脚本按当前机器的 DSH_HOME 生成。
 *
 * 断言（写盘前）：
 *   A1 patch 文件存在，且当前**没有** precompaction 条目（幂等护栏）
 *   A2 片段文件存在、无 BOM、行尾为 LF，且 name 行的 @@ENTRY@@ 恰好 1 个
 *   A3 patch 文件末尾的换行符形态已探明（按文件自己末尾的字节判定，不假设）
 *   A4 追加后大小 == 追加前大小 + 片段字节数(+补的换行)
 * 断言（写盘后，只读复核）：
 *   B1 新文件大小与预期一致  B2 precompaction 条目恰好 1 条  B3 4 个参数都在
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, symlinkSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.USERPROFILE ?? process.env.HOME;
const dsh = process.env.DSH_HOME ?? path.join(home, '.dsh');

const die = (msg, ev) => { console.error(`\n❌ 停手：${msg}`); if (ev) console.error(`   ${ev}`); console.error('   （未写入任何东西）\n'); process.exit(1); };

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const useTest = argv.includes('--test');
const revert = argv.includes('--revert');
const mode = revert ? 'revert' : apply ? (useTest ? 'apply(test)' : 'apply(prod)') : 'dry-run';

/** `--patch <path>` / `--patch=<path>`；未给则用 desktop profile 的默认 patch。 */
function argValue(flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  if (i >= 0) {
    const v = argv[i + 1];
    if (!v || v.startsWith('-')) die(`${flag} 后面缺少路径`);
    return v;
  }
  return null;
}
const patchArg = argValue('--patch');

/** 匹配一条 `- id: precompaction`（任意缩进）。 */
const ENTRY_LINE_RE = /^[ \t]*-[ \t]+id:[ \t]*precompaction[ \t]*$/;

/**
 * 找出所有 `- id: precompaction`，并区分它挂在哪：
 *   · **host 平面**：直属顶层 `- insert:`（本脚本写的就是这种）
 *   · **嵌套**：藏在预设的 `plugins:` 里（computer-use 预设里就有一条）
 *
 * 不能用「缩进是否为零」判定 —— host 条目本身缩进 4 空格（`- insert:` 的列表项），
 * 零缩进的从来不是 id 行。所以从条目往上找**缩进更小**的第一条结构行：
 * 遇到 `- insert:` ⇒ host；遇到 `plugins:` ⇒ 嵌套。
 */
function scanEntries(text) {
  const lines = text.split(/\r?\n/);
  const all = [];
  const host = [];
  lines.forEach((line, i) => {
    if (!ENTRY_LINE_RE.test(line)) return;
    all.push(i);
    const indent = (line.match(/^[ \t]*/) ?? [''])[0].length;
    for (let j = i - 1; j >= 0; j -= 1) {
      const l = lines[j];
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const ind = (l.match(/^[ \t]*/) ?? [''])[0].length;
      if (ind >= indent) continue;
      if (/^-\s*insert\s*:/.test(t)) { host.push(i); break; }
      if (/^plugins\s*:/.test(t)) break;
      // 同级/父级条目继续往上找（`- id:` / `config:` / `name:` …）
    }
  });
  return { all, host, lines };
}

const patchPath = patchArg ? path.resolve(patchArg) : path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml');
const snippetPath = path.join(here, useTest ? 'patch-snippet-test.yml' : 'patch-snippet.yml');
const pluginSrc = here; // 仓库根就是插件包：lib/index.js 与 package.json 都在这一层
const pluginDst = path.join(dsh, 'plugins', 'dsh-precompaction');
const linkPath = path.join(pluginDst, 'node_modules', '@deepseek-ai');
const linkTarget = path.join(dsh, 'profiles', 'node_modules', '@deepseek-ai');
const backupRoot = path.join(dsh, 'patch-staging', 'backup');

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const log = (...a) => console.log(...a);

log(`\n模式：${mode}`);
log(`DSH_HOME = ${dsh}`);
log(`patch    = ${patchPath}`);
log(`片段     = ${snippetPath}\n`);

// ── revert ──────────────────────────────────────────────────────────────────
if (revert) {
  if (!existsSync(backupRoot)) die(`没有备份目录：${backupRoot}`);
  const dirs = readdirSync(backupRoot).filter((d) => d.endsWith('-precompaction')).sort();
  if (dirs.length === 0) die(`备份目录下没有 *-precompaction 备份`);
  const latest = path.join(backupRoot, dirs[dirs.length - 1]);
  const src = path.join(latest, 'cordis.patch.yml');
  if (!existsSync(src)) die(`备份里没有 cordis.patch.yml：${src}`);
  log(`将用备份还原：${src}`);
  log(`  备份 sha256 = ${sha(src)}`);
  log(`  当前 sha256 = ${sha(patchPath)}`);
  if (!apply) { log('\n（dry-run：没写。要真还原请加 --apply）\n'); process.exit(0); }
  copyFileSync(patchPath, path.join(latest, `cordis.patch.yml.replaced-${Date.now()}`));
  copyFileSync(src, patchPath);
  log(`\n✅ 已还原。新 sha256 = ${sha(patchPath)}`);
  log('⚠️ 记得重启桌面端；并跑 node verify-install.mjs 复核（条目应恢复为 0 条）。\n');
  process.exit(0);
}

// ── A1 patch 现状 ───────────────────────────────────────────────────────────
if (!existsSync(patchPath)) die(`patch 文件不存在：${patchPath}`);
const before = readFileSync(patchPath);
const beforeText = before.toString('utf8');
const existing = scanEntries(beforeText);
if (existing.all.length > 0) {
  const where = existing.host.length > 0
    ? `其中 host 平面顶层 insert ${existing.host.length} 条`
    : '**全部在预设的 `plugins:` 里**（嵌套条目）';
  die(`patch 里已经有 precompaction 条目了（共 ${existing.all.length} 条，${where}）`,
    '脚本不做重复追加：再插一条 host 平面 insert 会让插件被加载两次。要改参数请先 --revert，或手工删掉旧条目');
}
log(`A1 ✅ patch 现状：${before.length} 字节，sha256 ${sha(patchPath).slice(0, 16)}…，无 precompaction 条目`);

// ── A2 片段 ─────────────────────────────────────────────────────────────────
if (!existsSync(snippetPath)) die(`片段文件不存在：${snippetPath}`);
const snip = readFileSync(snippetPath);
const isBom = snip.length >= 3 && snip[0] === 0xef && snip[1] === 0xbb && snip[2] === 0xbf;
if (isBom) die('片段带 BOM（patch 文件无 BOM，必须一致）');
const snipCrlf = (snip.toString('binary').match(/\r\n/g) ?? []).length;
if (snipCrlf > 0) die(`片段含 ${snipCrlf} 个 CRLF（本 patch 以 LF 为主，片段必须全 LF）`);
// 入口路径占位符：只认 name 行里的那一个（注释里也会提到 @@ENTRY@@，不算数）
const snipText = snip.toString('utf8');
const holders = [...snipText.matchAll(/^[ \t]*name:[ \t]*'@@ENTRY@@'[ \t]*$/gm)].length;
if (holders !== 1) die(`片段 name 行的 @@ENTRY@@ 占位符应恰好 1 个，实际 ${holders} 个`);
const entryUrl = pathToFileURL(path.join(pluginDst, 'lib', 'index.js')).href;
// ★ 用**函数型替换**：字符串替换串里的 `$&`/`$1` 会被当反向引用展开，
//   而 Windows 用户名里完全可能出现 `$`；`'` 还会提前闭合 YAML 单引号。
//   函数返回值不参与 `$` 展开；单引号按 YAML 规则写成两个。
const snipFinal = Buffer.from(snipText.replace(
  /^([ \t]*name:[ \t]*)'@@ENTRY@@'[ \t]*$/m,
  (_match, prefix) => `${prefix}'${entryUrl.replace(/'/g, "''")}'`,
), 'utf8');
log(`A2 ✅ 片段：${snip.length} 字节，无 BOM，全 LF；入口占位符 1 个 → ${entryUrl}`);

// ── A3 末尾换行形态 ─────────────────────────────────────────────────────────
const lastByte = before[before.length - 1];
let eol = '';
let needEol = false;
if (lastByte === 0x0a) {
  eol = before.length >= 2 && before[before.length - 2] === 0x0d ? '\r\n' : '\n';
  log(`A3 ✅ patch 末尾已有换行（${eol === '\r\n' ? 'CRLF' : 'LF'}），直接追加，不补换行`);
} else {
  needEol = true;
  // 末尾无换行：按文件里出现更多的行尾补一个（不假设）
  const text = before.toString('binary');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  eol = crlf > lf ? '\r\n' : '\n';
  log(`A3 ✅ patch 末尾没有换行 → 将补一个（按文件多数派判定为 ${eol === '\r\n' ? 'CRLF' : 'LF'}；CRLF=${crlf} LF=${lf}）`);
}
const expectedSize = before.length + (needEol ? Buffer.byteLength(eol, 'binary') : 0) + snipFinal.length;

// ── 备份 ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupDir = path.join(backupRoot, `${stamp}-precompaction`);
log(`\n备份目录：${backupDir}`);
if (!apply) log('（dry-run：不会真的建）');
else {
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(patchPath, path.join(backupDir, 'cordis.patch.yml'));
  writeFileSync(path.join(backupDir, 'sha256.txt'),
    `${sha(patchPath)}  cordis.patch.yml\n${sha(snippetPath)}  ${path.basename(snippetPath)}\n`, 'utf8');
  log(`  ✅ 已备份，sha256 记录在 ${path.join(backupDir, 'sha256.txt')}`);
}

// ── 复制插件 ────────────────────────────────────────────────────────────────
log(`\n插件目标：${pluginDst}`);
for (const rel of ['lib/index.js', 'package.json']) {
  const s = path.join(pluginSrc, rel), d = path.join(pluginDst, rel);
  log(`  ${rel}: ${existsSync(s) ? `${readFileSync(s).length} 字节 sha256 ${sha(s).slice(0, 16)}…` : '【源缺失!】'} → ${d}`);
  if (!existsSync(s)) die(`源文件缺失：${s}`);
  if (apply) { mkdirSync(path.dirname(d), { recursive: true }); copyFileSync(s, d); }
}

// ── 目录联接 ────────────────────────────────────────────────────────────────
log(`\n联接：${linkPath}\n  → ${linkTarget}`);
if (existsSync(linkPath)) {
  const st = lstatSync(linkPath);
  log(`  已存在（isSymbolicLink=${st.isSymbolicLink()}），跳过创建`);
} else if (apply) {
  mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    symlinkSync(linkTarget, linkPath, 'junction');
    log(`  ✅ 已创建 junction`);
  } catch (e) {
    console.error(`\n❌ 建目录联接失败：${e.code ?? ''} ${e.message}`);
    console.error('   这一步是**运行必需**的（没有它插件加载会 ERR_MODULE_NOT_FOUND）。');
    console.error('   本脚本**没有**改动 patch 文件 —— 现在只差这个联接。请按顺序试：');
    console.error('     ① 用更宽的权限重跑本脚本（沙箱会拒建联接：EPERM / Access is denied，实测）');
    console.error('     ② 请用户手工跑这一条（PowerShell 里必须带 cmd /c —— mklink 是 cmd 内部命令）：');
    console.error(`        cmd /c mklink /J "${linkPath}" "${linkTarget}"`);
    console.error('     ③ 仍不行就**停手报告** —— 不要用「复制实体目录」代替（会把 @deepseek-ai 下的包实体整个拷进来，且升级不跟随）');
    console.error('   做完 ①② 之后重跑本脚本（脚本会跳过已存在的联接，幂等）。\n');
    process.exit(1);
  }
} else log('  （dry-run：不会真的建）');

// ── A4 + 写盘 ───────────────────────────────────────────────────────────────
log(`\nA4 预期：追加后 ${expectedSize} 字节（追加前 ${before.length} + 补换行 ${needEol ? Buffer.byteLength(eol, 'binary') : 0} + 片段 ${snipFinal.length}）`);
if (!apply) { log('\n（dry-run 结束：以上全部演算完毕，未写入任何东西。要真装请加 --apply）\n'); process.exit(0); }

writeFileSync(patchPath, Buffer.concat([before, needEol ? Buffer.from(eol, 'binary') : Buffer.alloc(0), snipFinal]));

// ── B 组：写盘后只读复核 ────────────────────────────────────────────────────
const after = readFileSync(patchPath);
const afterText = after.toString('utf8');
const checks = [];
checks.push(['B1 大小一致', after.length === expectedSize, `${after.length} vs 预期 ${expectedSize}`]);
// 只认 **host 平面**条目：嵌套在预设 plugins 里的同名条目不算本脚本写入的。
const found = scanEntries(afterText);
const nested = found.all.length - found.host.length;
checks.push(['B2 host 平面 precompaction 条目恰好 1 条', found.host.length === 1,
  nested > 0 ? `host 平面 ${found.host.length} 条，另有嵌套 ${nested} 条（不是本脚本写的）` : `host 平面 ${found.host.length} 条`]);
const vals = {};
for (const k of ['triggerTokens', 'dangerTokens', 'keepTokens', 'overlapTokens']) {
  const m = afterText.match(new RegExp(`^\\s*${k}:\\s*(\\d+)\\s*$`, 'm'));
  vals[k] = m ? Number(m[1]) : null;
}
checks.push(['B3 4 个参数都在', Object.values(vals).every((v) => v !== null), JSON.stringify(vals)]);

log('');
let failed = 0;
for (const [name, good, ev] of checks) { log(`  ${good ? '✅' : '❌'} ${name} —— ${ev}`); if (!good) failed++; }
log(`\n新 sha256 = ${sha(patchPath)}`);
if (failed) {
  log(`\n⚠️ 有 ${failed} 条复核不过。回滚：node install-precompaction.mjs --revert --apply\n`);
  process.exit(1);
}
log('\n下一步：');
log('  1) 重启桌面端（配置是开机读取的）');
log('  2) 跑 node verify-install.mjs   → 应 7/7 通过');
log('  3) 做功能验证（低触发点那次），完了用 --revert 还原生产参数');
log(`  回滚：node install-precompaction.mjs --revert --apply\n`);
