/**
 * verify-cu-n1.mjs — dsh-cu-n1 插件冒烟测试（不启动 dsh，mock 附件服务）。
 *
 * ★ 两处关键设计：
 *   1. **cu_run_code 已被整个删除**。所以本文件不再测它，
 *      并且**显式断言它不存在** —— 防止它哪天被误加回来。
 *   2. 导入的是**本目录这一份**（相对路径），不硬编码 ~/.dsh 下的线上路径。
 *      若指向线上路径，测的就是线上插件、不是你手上这份，很容易自欺。
 *
 * 覆盖：
 *   1. 插件可导入、apply 不抛、注册**正好 4 个**工具；
 *   2. cu_run_code 不存在；
 *   3. cu_screenshot 真跑 cu-grab.py(Python/PIL) 截屏 + saveImage(mock)，render 产出 text+image 块；
 *   4. som:true 时并行跑 UIA 枚举并返回元素清单（依赖真机前台窗口）；
 *   5. cu_act 参数校验分支（缺参数/未知动作必须报错）；
 *   6. cu_probe 只读查询能跑通；
 *   7. cu_wait 等条件能跑通（超时必须返回 ok:false 而不是抛错）。
 *
 * 运行：node verify-cu-n1.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, mkdirSync, openSync, closeSync, mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = pathToFileURL(path.join(HERE, "lib", "index.js")).href;
// 必须覆盖 workDir / auditPath —— 默认值指向 ~/.dsh，在受限环境里写不了。
// 产物一律写系统临时目录，**绝不落在仓库内** —— 本脚本跑一次就会产出含本机
// 绝对路径的审计日志 + 真实桌面截图，落在 test/ 里等于发布前的隐私事故。
const VERIFY_TMP = mkdtempSync(path.join(os.tmpdir(), "cu-verify-"));
const WORK = path.join(VERIFY_TMP, "work");
const AUDIT = path.join(VERIFY_TMP, "_verify-audit.jsonl");
mkdirSync(WORK, { recursive: true });

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -- " + String(extra).slice(0, 200) : ""}`);
  if (!cond) failures++;
};

// ── spawn 兼容垫片（只在需要时装）──────────────────────────────────────────
// dsh 自己的沙箱下，Node 的**管道 stdio** 会 EPERM（文档化边界），但**文件 fd** 可以。
// 所以在受限环境里跑这个测试时自动垫一层；在普通环境里**不装**（保持原样）。
const require = createRequire(import.meta.url);
const cpcjs = require("node:child_process");
const realSpawn = cpcjs.spawn;
const shimDir = mkdtempSync(path.join(os.tmpdir(), "cu-verify-"));
let shimN = 0;
let shimmed = false;

function installShim() {
  cpcjs.spawn = function shimmedSpawn(cmd, args, opts = {}) {
    const id = ++shimN;
    const of = path.join(shimDir, `o${id}.txt`);
    const ef = path.join(shimDir, `e${id}.txt`);
    const ofd = openSync(of, "w");
    const efd = openSync(ef, "w");
    const child = realSpawn(cmd, args, { ...opts, stdio: ["ignore", ofd, efd] });
    const out = new EventEmitter();
    const err = new EventEmitter();
    // 常驻 UIA 管理器会调 setEncoding；假流要跟真流一样提供它
    out.setEncoding = () => {};
    err.setEncoding = () => {};
    child.stdout = out;
    child.stderr = err;
    child.on("close", () => {
      try { closeSync(ofd); } catch { /* ignore */ }
      try { closeSync(efd); } catch { /* ignore */ }
      let o = ""; let e = "";
      try { o = readFileSync(of, "utf8"); } catch { /* ignore */ }
      try { e = readFileSync(ef, "utf8"); } catch { /* ignore */ }
      if (o) out.emit("data", Buffer.from(o, "utf8"));
      if (e) err.emit("data", Buffer.from(e, "utf8"));
    });
    return child;
  };
  shimmed = true;
}

// 探一次：管道 stdio 能不能用？
await new Promise((resolve) => {
  try {
    const c = realSpawn(process.execPath, ["-e", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    c.on("error", (e) => { if (e?.code === "EPERM") { installShim(); } resolve(); });
    c.on("close", resolve);
    c.stdout?.on("data", () => {});
    c.stderr?.on("data", () => {});
  } catch (e) { if (e?.code === "EPERM") installShim(); resolve(); }
});
console.log(shimmed
  ? "[i] 检测到管道 stdio 被拒（受限环境）→ 已装文件 fd 垫片\n"
  : "[i] 管道 stdio 可用（普通环境）→ 未装垫片\n");

// ── 1. 导入与注册 ─────────────────────────────────────────────────────────
const plugin = (await import(PLUGIN)).default;
check("插件可导入", plugin?.name === "dsh-cu-n1" && Array.isArray(plugin.inject) && typeof plugin.apply === "function");

const registered = new Map();
const saved = [];
const mockAttachments = {
  async saveImage({ data, mediaType, name }) {
    saved.push({ data, mediaType, name });
    return { attachmentId: "att-test-0001", mediaType, bytes: data.length, width: 640, height: 400 };
  },
};
const ctx = {
  tools: { register: (t) => { registered.set(t.name, t); return () => {}; } },
  get: (service) => (service === "attachments" ? mockAttachments : undefined),
  effect: () => {},
  logger: () => ({ warn: () => {} }),
};
plugin.apply(ctx, { workDir: WORK, auditPath: AUDIT, defaultTimeoutMs: 30000 });

const names = [...registered.keys()];
console.log("注册的工具: " + names.join(", "));
check("注册了 4 个工具", registered.size === 4, `实际 ${registered.size}: ${names.join(",")}`);
check("★ cu_run_code 不存在", !registered.has("cu_run_code"));
for (const t of ["cu_screenshot", "cu_act", "cu_wait", "cu_probe"]) check(`有 ${t}`, registered.has(t));

const exec = { agent: { session: { id: "verify-session" } } };

// ── 2. cu_screenshot ──────────────────────────────────────────────────────
console.log("\n--- cu_screenshot ---");
const shot = registered.get("cu_screenshot");
const shotValue = await shot.execute({}, exec);
check("返回 path", typeof shotValue.path === "string" && shotValue.path.endsWith(".png"), shotValue.path);
check("返回 image 引用", shotValue.image?.attachmentId === "att-test-0001");
check("saveImage 收到 PNG 字节", saved[0]?.mediaType === "image/png" && saved[0]?.data?.[0] === 0x89 && saved[0]?.data?.[1] === 0x50);
const blocks = shot.output.render({}, shotValue);
check("render 首块是 text", blocks[0]?.type === "text" && blocks[0].text.includes("<path>"));
check("render 第二块是 image", blocks[1]?.type === "image" && blocks[1].attachment?.attachmentId === "att-test-0001");

// --- cu_screenshot 降采样（新增）-----------------------------------------
// ★ 为什么要有这一组：实测不主动降采样就一定吃满 provider 单图 token 上限，
//   降到 1024 宽只剩 418（按 16:10 屏算；早期写的 340 是按 2:1 算的，换宽高比要重算）。但**只有插件自己先降才有用** —— harness 会把图投到
//   "刚好用满 provider 单图 token 上限"的尺寸，不主动降就一定吃满上限。
//   所以「默认降」这件事必须有断言守着，否则哪天被改回不降，成本会悄悄翻倍。
const shotDflt = await shot.execute({}, exec);
check("★ 截图默认降采样（不再默认发全分辨率）",
  shotDflt.downsampled === true, `downsampled=${shotDflt.downsampled} 尺寸=${shotDflt.width}x${shotDflt.height}`);
check("降采样后宽度 <= 默认 1280", shotDflt.width <= 1280, `实际宽 ${shotDflt.width}`);
check("降采样时报告 screen 物理分辨率（供坐标换算）",
  typeof shotDflt.screen?.width === "number" && shotDflt.screen.width > shotDflt.width,
  `screen=${shotDflt.screen?.width} 图=${shotDflt.width}`);
check("降采样 render 带换算提示", /乘以|缩小展示/.test(shot.output.render({}, shotDflt)[0]?.text ?? ""));

const shotFull = await shot.execute({ maxWidth: 0 }, exec);
check("maxWidth:0 = 不降采样（拿原分辨率）",
  shotFull.downsampled === undefined, `downsampled=${shotFull.downsampled} 尺寸=${shotFull.width}x${shotFull.height}`);
// ★ 注意：mock 的 saveImage 固定回报 640x400，所以**不能**拿返回值宽度去断言真实分辨率。
//   要看真实抓屏尺寸，得读 PNG 头（IHDR）—— 那才是 cu-grab.py 实际写出的像素。
const pngSize = (p) => {
  const b = readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const fullPx = pngSize(shotFull.path);
check("★ maxWidth:0 时 PNG 真的是物理分辨率", fullPx.w === shotFull.screen.width,
  `PNG ${fullPx.w}x${fullPx.h} vs screen ${shotFull.screen.width}x${shotFull.screen.height}`);
const dfltPx = pngSize(shotDflt.path);
check("★ 默认档 PNG 真的被降到了 <=1280", dfltPx.w <= 1280 && dfltPx.w < fullPx.w,
  `默认 ${dfltPx.w}x${dfltPx.h} vs 原图 ${fullPx.w}x${fullPx.h}`);
check("降采样保比例（不拉伸变形）",
  Math.abs((dfltPx.w / dfltPx.h) - (fullPx.w / fullPx.h)) < 0.02,
  `比例 ${(dfltPx.w / dfltPx.h).toFixed(3)} vs ${(fullPx.w / fullPx.h).toFixed(3)}`);

const shotSmall = await shot.execute({ maxWidth: 800 }, exec);
const smallPx = pngSize(shotSmall.path);
check("maxWidth:800 生效", smallPx.w <= 800 && shotSmall.downsampled === true, `实际宽 ${smallPx.w}`);
check("★ 降采样不放大（原图更窄时保持原样）", smallPx.w <= fullPx.w, `${smallPx.w} <= ${fullPx.w}`);

let threw = "";
try { await shot.execute({ maxWidth: -5 }, exec); } catch (e) { threw = String(e.message); }
check("★ 非法 maxWidth 被拒（不静默用默认值）", /maxWidth/.test(threw), threw);

// --- cu_screenshot som 路径 ---
// ★ 这里的断言分两档，因为 "elements 非空" 是**环境条件**、不是代码正确性：
//   UIA 枚举的是**前台窗口**的可交互元素。如果前台窗口本身没有（比如焦点在某
//   个没有 UIA 元素的东西上），就会得到 elements: [] —— 这不是 bug。
//   实测（受限环境）：somDegraded **没有**被置位，说明 PowerShell/UIA 那条路
//   真的跑通了、JSON 也解析了，只是前台窗口没元素。
//   ⇒ 所以：
//     · 「somDegraded 未置位」= 硬断言（它一旦置位就说明 UIA 这条路坏了）
//     · 「elements 非空 + 结构正确」= 有元素时才断言，否则打印 SKIP 和前台窗口是谁
const somValue = await shot.execute({ som: true }, exec);
check("som 返回 elements 是数组", Array.isArray(somValue.elements), JSON.stringify(somValue.elements)?.slice(0, 80));
check("★ som 未降级（PowerShell/UIA 那条路真的跑通了）",
  somValue.somDegraded === undefined, `somDegraded=${somValue.somDegraded}`);
if (somValue.elements?.length > 0) {
  check("som 元素带 i/name/x/y", (() => { const e = somValue.elements[0]; return e && e.i >= 1 && typeof e.name === "string" && typeof e.x === "number" && typeof e.y === "number"; })(), JSON.stringify(somValue.elements[0]).slice(0, 120));
  check("som render 含元素清单文本", shot.output.render({}, somValue)[0]?.text.includes("som_elements"));
} else {
  let fg = "(取不到)";
  try {
    const f = await registered.get("cu_probe").execute({ kind: "windows", foreground_only: true }, exec);
    fg = f.windows?.[0] ? `"${f.windows[0].title}" (${f.windows[0].exe}, class=${f.windows[0].class})` : "(没有前台窗口)";
  } catch { /* 取不到就算了，只是说明用 */ }
  console.log(`SKIP  som 元素清单为空 —— 当前前台窗口 ${fg} 里 UIA 找不到可交互元素。`);
  console.log("      这不是失败：somDegraded 未置位已证明 UIA 那条路是通的。");
  console.log("      在普通桌面（前台是记事本/浏览器等）重跑，这两条会变成 PASS。");
}

// --- cu_screenshot scope（新增：枚举范围 foreground / taskbar / desktop）----
// ★ 为什么要有这一组：以前枚举范围只有"前台窗口"一种，而**编码 bug 会让它静默
//   退化成整个桌面**（编码 bug，已修）。现在范围是**显式参数**：
//   点任务栏图标用 taskbar，常规用 foreground，兜底用 desktop。
//   非法值必须报错，不能静默用默认值 —— 否则模型以为换了范围、其实没换。
threw = "";
try { await shot.execute({ som: true, scope: "nonsense" }, exec); } catch (e) { threw = String(e.message); }
check("★ 非法 scope 被拒（不静默用默认值）", /scope/.test(threw), threw);

const shotTb = await shot.execute({ som: true, scope: "taskbar" }, exec);
check("scope=taskbar 能跑通（未降级）", shotTb.somDegraded === undefined, `somDegraded=${shotTb.somDegraded}`);
if (shotTb.scopeDesc) {
  check("scope=taskbar 时 scopeDesc 指明任务栏", /taskbar/.test(String(shotTb.scopeDesc)), String(shotTb.scopeDesc));
} else {
  console.log("SKIP  scopeDesc —— 受限环境下 UIA 拿不到元素（见上方 SKIP 说明）。");
}
// 截断必须**可见**：枚举数 > 收录数时，render 里必须明说共多少个
if (shotTb.truncated === true) {
  const t = shot.output.render({}, shotTb)[0]?.text ?? "";
  check("★ 截断时 render 明说「本范围共 N 个」", /本范围共\s*\d+\s*个/.test(t), t.slice(-160));
  check("截断时 totalInteractive > 收录条数", shotTb.totalInteractive > shotTb.elements.length,
    `total=${shotTb.totalInteractive} 收录=${shotTb.elements.length}`);
} else {
  console.log(`SKIP  截断标记 —— 本次 taskbar 范围共 ${shotTb.totalInteractive ?? "?"} 个、未触发截断。`);
}

// --- cu_screenshot find（新增：按名字过滤元素清单）------------------------
// ★ 为什么要有它：som 的元素清单文字（60 条约 800 token）几乎和图片一样贵。
//   模型常常只是"想找某个东西"，这时把清单过滤到匹配项，能把 800 token 压到几十。
//   两个必须守住的点：① 过滤后清单**只能**含匹配项；② 没匹配到要**如实报 0**，
//   不能让模型以为"这东西不存在"（所以 matched 字段必须回传）。
threw = "";
try { await shot.execute({ som: true, find: 123 }, exec); } catch (e) { threw = String(e.message); }
check("★ find 非字符串被拒（不静默当空串）", /find/.test(threw), threw);
threw = "";
try { await shot.execute({ find: "搜索" }, exec); } catch (e) { threw = String(e.message); }
check("★ 不带 som 就传 find 被拒（防静默忽略）", /som/.test(threw), threw);
threw = "";
try { await shot.execute({ scope: "taskbar" }, exec); } catch (e) { threw = String(e.message); }
check("★ 不带 som 就传 scope 被拒（防静默忽略）", /som/.test(threw), threw);

const shotFind = await shot.execute({ som: true, scope: "taskbar", find: "搜索" }, exec);
check("find 能跑通（未降级）", shotFind.somDegraded === undefined, `somDegraded=${shotFind.somDegraded}`);
if (shotFind.find !== undefined) {
  check("find 回传 find 与 matched", shotFind.find === "搜索" && typeof shotFind.matched === "number",
    `find=${shotFind.find} matched=${shotFind.matched}`);
  check("★ find 过滤后清单只含匹配项",
    (shotFind.elements ?? []).every((e) => String(e.name).includes("搜索")),
    JSON.stringify((shotFind.elements ?? []).map((e) => e.name)).slice(0, 140));
  const noMatch = await shot.execute({ som: true, scope: "taskbar", find: "zzz绝对不存在zzz" }, exec);
  check("★ 无匹配时 matched=0、清单为空、且不谎报截断",
    noMatch.matched === 0 && (noMatch.elements ?? []).length === 0 && noMatch.truncated !== true,
    `matched=${noMatch.matched} 条数=${(noMatch.elements ?? []).length} truncated=${noMatch.truncated}`);
  check("★ 无匹配时 render 明确说「一个都没匹配到」",
    /一个都没匹配到/.test(shot.output.render({}, noMatch)[0]?.text ?? ""),
    (shot.output.render({}, noMatch)[0]?.text ?? "").slice(-160));
} else {
  console.log("SKIP  find 断言 —— 受限环境下 UIA 拿不到元素（见上方 SKIP 说明）。");
}

// ── 3. cu_act 参数校验 ────────────────────────────────────────────────────
console.log("\n--- cu_act ---");
const act = registered.get("cu_act");
threw = "";
try { await act.execute({ action: "bogus" }, exec); } catch (e) { threw = String(e.message); }
check("拒绝未知动作", threw.includes("未知动作"), threw);
threw = "";
try { await act.execute({ action: "click" }, exec); } catch (e) { threw = String(e.message); }
check("click 缺坐标报错", threw.includes("缺参数"), threw);
threw = "";
try { await act.execute({ action: "click", element: 999 }, exec); } catch (e) { threw = String(e.message); }
check("未知 SoM 编号报错", threw.includes("找不到 SoM 编号"), threw);
threw = "";
try { await act.execute({ actions: [] }, exec); } catch (e) { threw = String(e.message); }
check("批量空数组报错", threw.includes("必须是非空数组"), threw);
threw = "";
try { await act.execute({ actions: [{ action: "bogus" }] }, exec); } catch (e) { threw = String(e.message); }
check("批量里不合法要带下标且整批未执行", threw.includes("actions[0]") && threw.includes("整批未执行"), threw);

// --- cu_act find_text（新增：按名字点；找不到就返回"没找到"，不抛错）------
// ★ 为什么要有它：模型经常"知道它叫微信，但不知道坐标"。以前只能
//   先 cu_probe(kind="find") 再自己决定要不要点 —— 那个"决定"是模型做的，
//   插件管不着；实测过模型会拿**上一次的 SoM 编号**去点（旧位置），点错地方。
//   现在 find_text 把"找 → 点"合成一步。
// ★ 语义（2026-10-16 按用户要求定）：**零匹配不抛错** —— 返回一条 ok:false 的
//   "没找到"结果，把情况讲清楚（没点任何东西 + 三条下一步建议），由模型自己决定。
//   **参数不合法**才抛错（那是写错了，不是"没找到"）。
// ⚠️ 受限环境（沙箱 / 低权限）下 UIA 常常拿不到元素 ⇒ 命中路径无法真跑，只断言"没找到"这一侧。
threw = "";
try { await act.execute({ action: "click", find_text: "   " }, exec); } catch (e) { threw = String(e.message); }
check("★ find_text 空串被拒（不静默当没给）", /不能是空字符串/.test(threw), threw);
threw = "";
try { await act.execute({ action: "type", text: "a", find_text: "微信" }, exec); } catch (e) { threw = String(e.message); }
check("★ find_text 用在不需要坐标的动作上被拒", /只对需要坐标的动作/.test(threw), threw);
threw = "";
try { await act.execute({ action: "click", find_text: "微信", element: 1 }, exec); } catch (e) { threw = String(e.message); }
check("★ find_text 与 element 同时给被拒", /不能同时给/.test(threw), threw);
threw = "";
try { await act.execute({ action: "click", find_text: "微信", find_scope: "nope" }, exec); } catch (e) { threw = String(e.message); }
check("★ find_scope 非法被拒", /find_scope 必须是/.test(threw), threw);

// ★ 最关键的一条：找不到 → **不抛错**，而是回一条讲清楚的"没找到"
threw = "";
let nf = null;
try { nf = await act.execute({ action: "double_click", find_text: "zzz绝对不存在zzz" }, exec); } catch (e) { threw = String(e.message); }
check("★ find_text 零匹配 → 不抛错（是结果，不是异常）", threw === "", threw.slice(0, 140));
check("★ 零匹配 → ok:false + notFound:true", nf?.ok === false && nf?.notFound === true, JSON.stringify(nf).slice(0, 140));
check("★ 零匹配说明里明说「没有点任何东西」", /没有点任何东西/.test(nf?.error ?? ""), (nf?.error ?? "").slice(0, 150));
check("★ 零匹配给出下一步建议（换关键词/换范围/截图看）",
  /换个关键词/.test(nf?.error ?? "") && /find_scope/.test(nf?.error ?? "") && /cu_screenshot/.test(nf?.error ?? ""),
  (nf?.error ?? "").slice(-120));
check("★ 零匹配时 render 不摆成报错", /没执行/.test(act.output.render({}, nf)[0]?.text ?? ""), act.output.render({}, nf)[0]?.text?.slice(0, 90));

// ★ 批量：某条没找到 → 该条标 notFound、其后标"未执行"（默认遇错即停），**整批不抛异常**
threw = "";
let bnf = null;
try {
  bnf = await act.execute({ actions: [
    { action: "click", find_text: "zzz绝对不存在zzz" },
    { action: "click", x: 5, y: 5 },
  ] }, exec);
} catch (e) { threw = String(e.message); }
check("★ 批量里 find_text 零匹配 → 不抛错", threw === "", threw.slice(0, 140));
check("★ 批量：该条 notFound、其后 skipped、下标完整",
  bnf?.steps?.[0]?.notFound === true && bnf?.steps?.[1]?.skipped === true && bnf.steps.length === 2,
  JSON.stringify(bnf?.steps).slice(0, 200));

// 给了 x/y 时 find_text 不该参与解析（x/y 优先，与 element 同款语义）。
// ⚠️ 故意用"缺 y"的调用：这样能证明**解析没发生**（报的是缺参数，不是"没找到"），
//    同时又绝不会真执行任何动作 —— 冒烟测试不该动用户的鼠标。
threw = "";
try { await act.execute({ action: "click", x: 4, find_text: "zzz绝对不存在zzz" }, exec); } catch (e) { threw = String(e.message); }
check("给了 x 时 find_text 不参与解析（报缺参数而非没找到）",
  /缺参数 y/.test(threw) && !/没找到/.test(threw), threw);

// ★ 旧编号残留（2026-10-16 修，实测抓到的静默点错）：
//   空清单/降级时若不**清掉**上一张截图的编号表，cu_act(element=N) 会命中
//   上一张截图的旧坐标 —— 模型以为点的是刚看到的东西，实际点的是旧位置。
//   实测复现过：som+find 零匹配后 element=1 仍解析成上一次截图的旧坐标并点了出去。
//   这里断言"零匹配之后旧编号必须失效"。受限环境 UIA 常为 0 个元素，正好走这条路径。
threw = "";
try { await act.execute({ action: "click", element: 1 }, exec); } catch (e) { threw = String(e.message); }
check("★ 零匹配/空清单后旧 SoM 编号失效（不再点到上一张截图的坐标）",
  /找不到 SoM 编号/.test(threw), threw);

// ── 4. cu_probe ───────────────────────────────────────────────────────────
console.log("\n--- cu_probe ---");
const probe = registered.get("cu_probe");
const scr = await probe.execute({ kind: "screen" }, exec);
check("screen 查询通过", scr.ok === true && scr.width > 0 && scr.height > 0, `${scr.width}x${scr.height}`);
check("screen 是物理像素（DPI 感知已设）", scr.dpiAware === true, `dpiAware=${scr.dpiAware}`);
const dirV = await probe.execute({ kind: "dir", path: path.join(HERE, "lib"), pattern: "*.py" }, exec);
check("dir 查询通过", dirV.ok === true && Array.isArray(dirV.entries), `${dirV.entries?.length} 项`);
threw = "";
try { await probe.execute({ kind: "nonsense" }, exec); } catch (e) { threw = String(e.message); }
check("拒绝未知 kind", threw.includes("未知 kind"), threw);

// --- cu_probe clickable（新增：悬停式可点击性探针）------------------------
// ★ 为什么要有它：实测连查 7 个窗口（含 Chromium 类、文件资源管理器），UIA 可交互
//   元素**全部为 0**，而插件跑时同类窗口能拿到 60 个 —— 「靠 UIA 知道哪儿能点」
//   时灵时不灵。悬停探针不依赖 UIA，直接问系统"鼠标悬在能点的东西上吗"。
// ★ 断言分两档：**光标读取**是硬断言（纯读，任何环境都该成）；
//   **鼠标移动**是环境条件（受限令牌/沙箱下 SetCursorPos 被静默拒绝），
//   所以只断言"即使动不了也必须诚实报告 moved:false + 拒绝给结论"，不断言一定能动。
const ro = await probe.execute({ kind: "clickable" }, exec);
check("clickable 只读模式通过", ro.ok === true && ro.mode === "read-only", JSON.stringify(ro).slice(0, 140));
check("★ 只读模式真的没动鼠标", ro.moved === false, `moved=${ro.moved}`);
check("读出了光标形态", typeof ro.cursor?.type === "string" && ro.cursor.type.length > 0,
  `type=${ro.cursor?.type} @ (${ro.cursor?.x},${ro.cursor?.y})`);
check("只读模式给出 verdict", typeof ro.verdict === "string", `verdict=${ro.verdict}`);

const hov = await probe.execute({ kind: "clickable", x: 10, y: 10 }, exec);
check("clickable 悬停模式通过", hov.ok === true && hov.mode === "hover", JSON.stringify(hov).slice(0, 140));
check("报告了目标结果数组", Array.isArray(hov.targets) && hov.targets.length === 1, `${hov.targets?.length} 个`);
check("结果带光标/噪声/净信号字段", (() => {
  const t = hov.targets?.[0];
  return t && typeof t.cursor === "string" && typeof t.noisePct === "number"
    && typeof t.hoverChangedPct === "number" && typeof t.signalPct === "number";
})(), JSON.stringify(hov.targets?.[0]));
check("★ 报告鼠标是否还原（诚实报告，不假设成功）", typeof hov.restored === "boolean", `restored=${hov.restored}`);

// ★ 最关键的一条：鼠标动不了时**必须拒绝给结论**，不能拿"鼠标原来那个位置"的光标形态
//   冒充目标位置的结论（这个坑实测踩过：verdict 曾报成 text-input）。
if (hov.moved === false) {
  check("★ 鼠标没动成时一律 unknown（不编结论）",
    hov.targets.every((t) => t.verdict === "unknown" && t.confidence === "无"),
    hov.targets.map((t) => `${t.verdict}/${t.confidence}`).join(","));
  check("★ 鼠标没动成时带明确告诫", /没能移动|不可信/.test(hov.note ?? ""), (hov.note ?? "").slice(0, 90));
  console.log("SKIP  鼠标移动本身（当前环境 SetCursorPos 被拒）—— 悬停那半边留待真机验证。");
} else {
  check("鼠标移动成功时给出结论", hov.targets.every((t) => typeof t.verdict === "string"));
}

const multi = await probe.execute({ kind: "clickable", targets: [{ x: 5, y: 5 }, { x: 20, y: 20 }] }, exec);
check("targets 批量（多目标）通过", multi.ok === true && multi.targets?.length === 2, `${multi.targets?.length} 个`);

const roForce = await probe.execute({ kind: "clickable", x: 10, y: 10, move: false }, exec);
check("move:false 强制只读（给了坐标也不动鼠标）",
  roForce.mode === "read-only" && roForce.moved === false, `mode=${roForce.mode}`);

threw = "";
try { await probe.execute({ kind: "clickable", x: 99999, y: 10 }, exec); } catch (e) { threw = String(e.message); }
check("★ clickable 越界坐标被拒", /越界/.test(threw), threw);

threw = "";
try { await probe.execute({ kind: "clickable", targets: "nope" }, exec); } catch (e) { threw = String(e.message); }
check("clickable targets 非数组被拒", /targets/.test(threw), threw);

// --- cu_probe find（新增：按名字找元素，**不发图**）------------------------
// ★ 为什么要有它：cu_screenshot(som=true) 每次都要发一张图（≈642 token），
//   而"这东西在哪"往往只需要坐标。find 复用同一个 UIA 后端但**不截屏、不回图**。
//   两条底线：① 结果里**不能**出现图片/路径字段（否则"不发图"就是空话）；
//             ② 名字必填（不给名字等于"倒整份清单"，那该走 screenshot 那条路）。
threw = "";
try { await probe.execute({ kind: "find" }, exec); } catch (e) { threw = String(e.message); }
check("★ find 缺 text 被拒（不给名字不许倒清单）", /text/.test(threw), threw);
threw = "";
try { await probe.execute({ kind: "find", text: "x", scope: "nope" }, exec); } catch (e) { threw = String(e.message); }
check("★ find 非法 scope 被拒", /scope/.test(threw), threw);

const findR = await probe.execute({ kind: "find", text: "搜索", scope: "taskbar" }, exec);
check("find 能跑通（或明确报错，不抛异常）",
  findR.ok === true || typeof findR.error === "string", JSON.stringify(findR).slice(0, 160));
check("★ find 结果里没有图片/截图路径字段（确实不发图）",
  findR.image === undefined && findR.path === undefined && findR.mediaType === undefined,
  Object.keys(findR).join(","));
if (findR.ok === true) {
  check("find 回传 matched 与 elements", typeof findR.matched === "number" && Array.isArray(findR.elements),
    `matched=${findR.matched}`);
  if (findR.matched === 0) {
    console.log("SKIP  find 命中项 —— 受限环境下 UIA 拿不到元素（见上方 SKIP 说明）。");
  } else {
    check("★ find 只回匹配项", findR.elements.every((e) => String(e.name).includes("搜索")),
      JSON.stringify(findR.elements.map((e) => e.name)).slice(0, 140));
  }
}

// ── 5. cu_wait ────────────────────────────────────────────────────────────
console.log("\n--- cu_wait ---");
const wait = registered.get("cu_wait");
const hit = await wait.execute({ condition: "file", path: path.join(HERE, "lib", "index.js"), timeout_ms: 3000 }, exec);
check("file 条件命中即返回", hit.ok === true, JSON.stringify(hit).slice(0, 140));
const miss = await wait.execute({ condition: "file", path: path.join(WORK, "NOPE.txt"), timeout_ms: 600 }, exec);
check("★ 超时返回 ok:false（不抛错）", miss.ok === false && /超时/.test(miss.error ?? ""), JSON.stringify(miss).slice(0, 140));
threw = "";
try { await wait.execute({ condition: "bogus", timeout_ms: 1000 }, exec); } catch (e) { threw = String(e.message); }
check("拒绝未知 condition", threw.includes("未知 condition"), threw);

// ★ timeout_ms 现在是**必填**（工具参数声明里本来就是 required: true；
//   "默认 5000" 是实现时自作主张加的），而且校验取严 ——
//   原来 `Number(x) || 5000` 会把 0 **静默变成 5000**，调用方以为说了 0 却等了 5 秒。
threw = "";
try { await wait.execute({ condition: "file", path: path.join(HERE, "lib", "index.js") }, exec); } catch (e) { threw = String(e.message); }
check("★ 缺 timeout_ms 被拒（必填）", /timeout_ms/.test(threw) && /required|必填/.test(threw), threw);
threw = "";
try { await wait.execute({ condition: "file", path: path.join(HERE, "lib", "index.js"), timeout_ms: 0 }, exec); } catch (e) { threw = String(e.message); }
check("★ timeout_ms=0 被拒（不再静默变成 5000）", /timeout_ms/.test(threw), threw);
threw = "";
try { await wait.execute({ condition: "pixel", x: 1, y: 1, expect: "red", timeout_ms: 1000 }, exec); } catch (e) { threw = String(e.message); }
check("★ expect 格式错立刻被拒（不再白等满超时）", /expect/.test(threw), threw);
// 像素越界：原来 PIL 返回黑边 ⇒ 静默 #000000（模型会以为那里真是黑的）
threw = "";
try { await registered.get("cu_probe").execute({ kind: "pixel", x: 99999, y: 99999 }, exec); } catch (e) { threw = String(e.message); }
check("★ cu_probe pixel 越界被拒（不再静默 #000000）", /越界/.test(threw), threw);

// ── 6. 交付完整性 ─────────────────────────────────────────────────────────
console.log("\n--- 交付完整性 ---");
check("★ cu-guard-boot.py 已删除（它只服务已删的 cu_run_code）",
  !existsSync(path.join(HERE, "lib", "cu-guard-boot.py")));
check("cu-guard.py 在（cu_act 的输入目标护栏要用）", existsSync(path.join(HERE, "lib", "cu-guard.py")));
check("cu-guard.policy.json 在", existsSync(path.join(HERE, "lib", "cu-guard.policy.json")));
const actSrc = readFileSync(path.join(HERE, "lib", "cu-act.py"), "utf8");
check("cu-act.py 已装输入目标护栏", actSrc.includes("install_gui_only"));
check("cu-act.py 的护栏是 fail-closed 的", actSrc.includes("sys.exit(3)"));

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
