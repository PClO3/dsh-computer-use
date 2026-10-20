#!/usr/bin/env node
/**
 * verify-install.mjs —— 安装后自检（dsh-precompaction）
 *
 * 纯 Node，无第三方依赖，只读。逐条打印原始证据，最后给 PASS/FAIL 汇总。
 * 用法：  node verify-install.mjs
 *        node verify-install.mjs --patch "<自定义 patch 路径>"     # 默认 profiles\desktop\cordis.patch.yml
 *
 * 判据（7 条）：
 *   1 插件文件已就位，且 sha256 与本包内的副本一致
 *   2 package.json 存在且 "type":"module"（ESM 显式声明）
 *   3 目录联接已建，且指向 <DSH_HOME>\profiles\node_modules\@deepseek-ai
 *   4 从**已安装位置**动态 import 成功，导出 name/apply/inject 正确（证明联接真的解决了裸包名）
 *   5 desktop patch 里 **host 平面** precompaction 条目恰好 1 条（嵌套在预设 plugins 里的不算）
 *   6 该条目的 4 个参数存在且为数字
 *   7 该条目的 name 入口路径指向**已安装**的那份插件文件（防手抄路径写错）
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, lstatSync, statSync, readlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.USERPROFILE ?? process.env.HOME;
const dsh = process.env.DSH_HOME ?? path.join(home, '.dsh');

const argv = process.argv.slice(2);
const patchEq = argv.find((a) => a.startsWith('--patch='));
const patchIdx = argv.indexOf('--patch');
const patchPath = patchEq
  ? path.resolve(patchEq.slice('--patch='.length))
  : patchIdx >= 0 && argv[patchIdx + 1]
    ? path.resolve(argv[patchIdx + 1])
    : path.join(dsh, 'profiles', 'desktop', 'cordis.patch.yml');

/** 匹配一条 `- id: precompaction`（任意缩进）。 */
const ENTRY_LINE_RE = /^[ \t]*-[ \t]+id:[ \t]*precompaction[ \t]*$/;

/**
 * 区分「host 平面」与「预设内嵌套」条目（规则同 install-precompaction.mjs）：
 * 从条目往上找缩进更小的第一条结构行 —— `- insert:` ⇒ host，`plugins:` ⇒ 嵌套。
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
    }
  });
  return { all, host, lines };
}

const installed = path.join(dsh, 'plugins', 'dsh-precompaction');
const results = [];
const ok = (n, msg, ev) => { results.push([true, n, msg]); console.log(`  ✅ ${n} ${msg}${ev ? `\n       ${ev}` : ''}`); };
const bad = (n, msg, ev) => { results.push([false, n, msg]); console.log(`  ❌ ${n} ${msg}${ev ? `\n       ${ev}` : ''}`); };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

console.log(`\nDSH_HOME = ${dsh}`);
console.log(`patch    = ${patchPath}\n`);

// ── 1 插件文件 + 哈希 ────────────────────────────────────────────────────────
const srcFile = path.join(here, 'lib', 'index.js');
const dstFile = path.join(installed, 'lib', 'index.js');
if (!existsSync(dstFile)) bad('1', `插件文件不存在：${dstFile}`);
else {
  const a = sha(srcFile), b = sha(dstFile);
  if (a === b) ok('1', `插件文件已就位，sha256 与本包一致（${b.slice(0, 16)}…，${readFileSync(dstFile).length} 字节）`);
  else bad('1', '插件文件存在但 sha256 与本包**不一致**', `本包 ${a}\n       已装 ${b}`);
}

// ── 2 package.json ──────────────────────────────────────────────────────────
const pj = path.join(installed, 'package.json');
if (!existsSync(pj)) bad('2', `package.json 不存在：${pj}`);
else {
  try {
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    if (j.type === 'module') ok('2', `package.json 存在且 "type":"module"（name=${j.name}, main=${j.main}）`);
    else bad('2', `package.json 存在但 type=${JSON.stringify(j.type)}（应为 "module"）`);
  } catch (e) { bad('2', `package.json 解析失败：${e.message}`); }
}

// ── 3 目录联接 ──────────────────────────────────────────────────────────────
const link = path.join(installed, 'node_modules', '@deepseek-ai');
const expectTarget = path.join(dsh, 'profiles', 'node_modules', '@deepseek-ai');
if (!existsSync(link)) bad('3', `目录联接不存在：${link}`, '没有它，插件里的 @deepseek-ai/* 裸包名解析不了（实测 ERR_MODULE_NOT_FOUND）');
else {
  const st = lstatSync(link);
  let target = '';
  try { target = readlinkSync(link); } catch { /* junction 常常读不出来，见下 */ }
  const norm = (s) => String(s).replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\Global\\/, '').replace(/[\\/]+$/, '').toLowerCase();
  // ⚠️ 2026-10-18 实测修正：Windows 上由 PowerShell/dsh 工具建的 junction，
  //    lstatSync().isSymbolicLink() 会是 false、readlinkSync 会抛 EINVAL —— 用它们判断会**误报失败**。
  //    可靠办法是 realpathSync.native()（它会把 junction 解析到真实目标）。
  let resolved = '';
  try { resolved = realpathSync.native(link); } catch { /* ignore */ }
  let sameIno = false;
  try { const a = statSync(link), b = statSync(expectTarget); sameIno = a.ino === b.ino && a.dev === b.dev; } catch { /* ignore */ }
  const isLink = st.isSymbolicLink() || target !== '' || sameIno;
  if (isLink && (norm(resolved) === norm(expectTarget) || norm(target) === norm(expectTarget) || sameIno)) {
    ok('3', `目录联接存在且指向正确`,
      `realpath=${resolved || '(未解析)'}｜readlink=${target || '(读不出)'}｜ino/dev 与目标一致=${sameIno}`);
  } else if (isLink) {
    bad('3', '联接存在但指向不是 profiles\\node_modules\\@deepseek-ai', `realpath ${resolved}\n       readlink ${target}\n       期望 ${expectTarget}`);
  } else {
    bad('3', '路径存在但**不是联接**（可能是实体目录或复制过来的）', `mode=${st.mode} isSymbolicLink=${st.isSymbolicLink()}`);
  }
}

// ── 4 从已安装位置真的 import 一次 ──────────────────────────────────────────
try {
  const mod = await import(pathToFileURL(dstFile).href);
  const problems = [];
  if (mod.name !== 'dsh-precompaction') problems.push(`name=${JSON.stringify(mod.name)}`);
  if (typeof mod.apply !== 'function') problems.push('apply 不是函数');
  if (JSON.stringify(mod.inject) !== JSON.stringify(['llm', 'tokenMeter'])) problems.push(`inject=${JSON.stringify(mod.inject)}`);
  if (problems.length === 0) ok('4', `从已安装位置 import 成功；name/apply/inject 均正确（inject=${JSON.stringify(mod.inject)}）`);
  else bad('4', `import 成功但导出不对：${problems.join('; ')}`);
} catch (e) {
  bad('4', `从已安装位置 import **失败**：${e.code ?? ''} ${e.message}`, '多半是联接没建好或指向不对');
}

// ── 5/6 patch 条目 ──────────────────────────────────────────────────────────
if (!existsSync(patchPath)) bad('5', `patch 文件不存在：${patchPath}`);
else {
  const text = readFileSync(patchPath, 'utf8');
  const found = scanEntries(text);
  const nested = found.all.length - found.host.length;
  if (found.host.length === 1) ok('5', `patch host 平面 precompaction 条目恰好 1 条${nested ? `（另有嵌套 ${nested} 条，不计）` : ''}`);
  else if (found.host.length === 0 && nested > 0) {
    bad('5', `只有 ${nested} 条**嵌套**条目（在预设 plugins 里），缺 host 平面 insert`,
      '两处都挂会让插件加载两次；请删掉一处后重跑安装脚本，或确认你走的是「预设内挂载」那条路');
  } else bad('5', `patch host 平面 precompaction 条目 ${found.host.length} 条（应为 1）`);

  const grab = (k) => { const m = text.match(new RegExp(`^\\s*${k}:\\s*(\\d+)\\s*$`, 'm')); return m ? Number(m[1]) : null; };
  const vals = { triggerTokens: grab('triggerTokens'), dangerTokens: grab('dangerTokens'), keepTokens: grab('keepTokens'), overlapTokens: grab('overlapTokens') };
  const missing = Object.entries(vals).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length === 0) ok('6', `4 个参数都在：${JSON.stringify(vals)}`);
  else bad('6', `缺少参数：${missing.join(', ')}`, `实际 ${JSON.stringify(vals)}`);

  // ── 7 入口路径指向已安装的插件文件 ────────────────────────────────────────
  const entryIdx = found.host[0];
  const nameLine = entryIdx === undefined
    ? null
    : found.lines.slice(entryIdx + 1, entryIdx + 8)
      .map((l) => l.match(/^[ \t]*name:[ \t]*'?([^'\r\n]+?)'?[ \t]*$/))
      .find(Boolean);
  if (!nameLine) bad('7', '在 host 平面 precompaction 条目里找不到 name 行');
  else {
    let entryPath = nameLine[1];
    try { if (entryPath.startsWith('file://')) entryPath = fileURLToPath(entryPath); } catch { /* 保持原样 */ }
    const normP = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normP(entryPath) === normP(dstFile)) ok('7', `入口路径指向已安装插件：${nameLine[1]}`);
    else bad('7', '入口路径与已安装位置不一致', `patch 里 ${entryPath}\n       期望   ${dstFile}`);
  }
}

const failed = results.filter(([good]) => !good).length;
console.log(`\n${'═'.repeat(64)}`);
console.log(`结果：通过 ${results.length - failed} ｜ 失败 ${failed}`);
console.log(`${'═'.repeat(64)}\n`);
process.exit(failed === 0 ? 0 : 1);
