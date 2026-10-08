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

// ── 3. cu_act 参数校验 ────────────────────────────────────────────────────
console.log("\n--- cu_act ---");
const act = registered.get("cu_act");
let threw = "";
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
