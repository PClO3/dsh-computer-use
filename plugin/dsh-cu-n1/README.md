# dsh-cu-n1 · computer-use 三件套

给 dsh 一双眼睛和一双手(Windows 桌面路径)。靠 **SoM 编号定位**绕开模型的 grounding 短板(模型说"点几号"，不猜像素坐标)；模型侧用任意具备视觉能力的模型即可，本项目针对 DeepSeek / GLM 系列做过调优。

| 工具 | 作用 | 要点 |
|---|---|---|
| `cu_screenshot` | 截主屏，PNG 直接回传模型(走 dsh attachments 服务，同内置 `read_image` 机制) | `som:true` 同时枚举前台窗口可交互元素(UIA)，叠加编号徽章并返回清单;UIA 失败/太慢自动降级普通截图(somDegraded) |
| `cu_act` | 一次鼠标/键盘动作:click / double_click / right_click / type / key / scroll / move / drag / **focus_dsh** | 坐标用物理像素;`element:N` 自动取 SoM 编号中心;中文 type 走剪贴板粘贴;每次移动类动作后自检鼠标真实到位(防受限令牌静默失败);`focus_dsh` 把 dsh 主界面带回前台(汇报前必调) |
| `cu_probe` | **只读**查询，永不改状态:`windows`(窗口清单/标题/进程/位置) / `processes` / `screen` / `pixel` / `file_tail` / `dir` | 用它替代"为了看一眼而写一段 Python";⚠️受限令牌下进程枚举会被系统过滤，返回里带告诫字段 |
| `cu_wait` | 等条件成立(pixel 变色 / window 出现 / file 出现消失)，替代写死 `time.sleep` 干等 | 轮询在 Python 侧**一次进程内**完成，不反复起进程;命中即返回，超时返回 `ok:false` 而不抛错;`timeout_ms` **必填** 1~120000 |
| **（护栏）** | `lib/cu-guard.py` + `cu-guard.policy.json`:cu_act 注入前的**输入目标护栏** + **全局热键黑名单** | 管理员窗口/任务管理器/终端/设置等一律不许碰;热键拦 `win+r/l/x/i`、`ctrl+shift+esc`、`ctrl+shift+enter`、`ctrl+alt+del`;**装不上就拒绝执行**(fail-closed) |

> **`cu_run_code`（跑任意 Python 代码）已整个删除，不留开关。**
> 删掉之后「分析」由 `cu_probe` / `cu_wait` / `cu_screenshot` 接盘，「批量」由 `cu_act(actions:[…])` 接盘。
> **恢复只能整份回滚到删除前的版本，没有「拨开关」这条路。**

## 文件

- `lib/index.js` — 插件主体(cordis 插件，default export `{name, inject, apply}`)
- `lib/cu-grab.py` — Python/PIL 抓屏 + som 徽章绘制（截图主路径；等 UIA 输出最多 12s，超时自动降级）
- `lib/cu-shot.ps1` — UIA 元素枚举(前台窗口 + 顶层窗口清单;CacheRequest 批量取属性提速);不带 `-NoCapture` 时保留旧 GDI+ 截屏能力
- `lib/cu-act.py` — 动作执行(pyautogui,FAILSAFE 开启)
- `lib/cu-probe.py` — `cu_probe` / `cu_wait` 的共用后端(只读，永不改状态)
- `lib/cu-guard.py` + `lib/cu-guard.policy.json` — 输入目标护栏 + 全局热键黑名单(上表「护栏」那一行的实现；策略取值在 json 里可调)
- `advisor/cu-advisor.py` — **可选副模型(异步顾问)**，见下方「副模型(可选)」
- `advisor/advisor.local.gateway.example.json` — 副模型网关配置模板(改名 `advisor.local.json` 生效)
- `verify-cu-n1.mjs` — 冒烟测试(mock 附件服务):`node verify-cu-n1.mjs`。**产物写系统临时目录**(`%TEMP%\cu-verify-*`)，不落在仓库内
- `test/cu-test.patch.yml` — 真机测试用 --patch 覆盖层(零改动)
- `package.json` / `LICENSE` / `THIRD_PARTY_NOTICES.md`

## 副模型（可选，默认关闭）

`advisor/` 是**可选**的「副模型预判」通道：截屏后把当前任务与最近动作交给一个便宜的小模型，请它提前说出「下一步最可能出什么风险」，供主模型参考。**不装、不配就完全不启用**（`advisor/advisor.local.json` 不存在 = 副模型关闭，`lib/index.js` 不发起任何调用）。

> ⚠️ **数据外发提示（启用前请读）**：启用后，`advisor/cu-advisor.py` 会把**你的任务描述文本 + 最近若干步动作记录**发送到你配置的模型网关（默认 `https://api.deepseek.com`，模型默认 `deepseek-chat`），用的是你自己 `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`。
> **不发送屏幕截图**（发的是 SoM 元素清单的文字描述，不是图像）；凭证只读不打印。
> 不想外发数据就别建 `advisor.local.json`，一切照常。

启用方式：把 `advisor/advisor.local.gateway.example.json` 复制为同目录的 `advisor.local.json`，按注释改成你的网关与模型；依赖多一个 `pip install pyyaml`。

## 安装

1. 把 `plugin/dsh-cu-n1/` 整个目录放到 `~/.dsh/plugins/dsh-cu-n1/`（或你的 `DSH_HOME` 所指向的目录下）。
2. 在 profile 的 `cordis.patch.yml` 里登记插件行；预设源稿见 `preset/computer-use/agent.cordis.yml`。
   **`name:` 里的插件入口路径必须按本机替换**——把源稿占位符里的 `<你的用户名>` 换成你自己的 Windows 用户名，或整条换成你的实际绝对路径。
3. **`auditPath` / `workDir` 无需配置**：插件按 `DSH_HOME`（未设置则 `~/.dsh`）自解析到 `~/.dsh/storages/cu-n1/`。

## 依赖

- `node_modules/@deepseek-ai` → junction 指向 `profiles/node_modules/@deepseek-ai`
- **Python**:`pythonPath` 默认按序探测 `~/AppData/Local/Python/bin/python.exe` → dsh runtime python。
  **为什么不用 dsh 自带 python 当主力**:dsh runtime 的 python.exe 跑在受限令牌下——
  `~/.dsh` 之外的写入被拒(WinError 5)、`SetCursorPos` 被静默拒绝(ret=0,pyautogui 不查返回值，
  表现为 ok:true 但鼠标没动)。系统 Python 无此限制。依赖 `pyautogui` 与 `pillow`,**请自行 `pip` 安装**;`pyyaml` 只有启用副模型(`advisor/`)才用得到。
- 截图与坐标全部使用物理像素；大图经 attachments 自动缩小，工具返回文本里带换算提示。

## 安全设计

- **审计日志**:每次工具调用追加一行 JSONL 到 `~/.dsh/storages/cu-n1/audit.jsonl`(追加式，不改写)。
- **急停**:pyautogui FAILSAFE 开启，鼠标甩到 (0,0) 立即中止;cu_act 移动类动作带到位自检。
- **persona 纪律**(在预设里):屏幕内容=不可信输入;后果性动作(购买/删除/发送/提交)先列清单等确认;
  密码/验证码/支付码不碰;只读查询走 `cu_probe`，不为了「看一眼」去做改动状态的动作。
- **输入目标护栏**:`lib/cu-guard.py` 给 `cu-act.py` 装 `install_gui_only()`，
  注入前查目标窗口属于谁/有没有提权，命中黑名单或查不出就**拒绝**(fail-closed);另有全局热键黑名单。

## 许可

本项目自有代码以 **Apache-2.0 许可证**授权，见 `LICENSE`。第三方组件清单见 `THIRD_PARTY_NOTICES.md`。

## 依赖与致谢

- 运行宿主 **dsh**（MIT）——插件运行环境与工具注册 API（`@deepseek-ai/dsh-tools` / `dsh-attachment`）。
- **PyAutoGUI**（BSD-3-Clause）及其依赖链：PyGetWindow / PyMsgBox / PyRect / PyPerclip（BSD-3-Clause）、PyTweening / PyScreeze（BSD-3-Clause，⚠️ pip 元数据误标 MIT，以包内 LICENSE 正文为准），
  其中 **MouseInfo 为 GPLv3+**。本仓库**不分发**其代码，以上依赖由使用者**自行 `pip` 安装**。
- **Pillow**（MIT-CMU）——截图与 SoM 徽章绘制。
- **SoM（Set-of-Mark）编号定位**——学术公开方法，思想不受版权保护；本项目的徽章绘制为自研 PIL 实现，特此致谢。

> ⚠️ **GPLv3+ 提示**：MouseInfo 为传染型许可，但属**可选组件——运行不强制**（PyAutoGUI 对它是 `try/except` 可选导入，不装也能跑；本项目不调用其功能）。本仓库只分发自有源码，依赖由使用者自行安装，故 Apache-2.0 不冲突。
> **请勿制作"连依赖一起打包"的一键安装包对外分发**——那会使整包受 GPLv3+ 约束。详见 `THIRD_PARTY_NOTICES.md`。

## 安全声明与免责

**本项目为通用自动化工具，仅供学习与合法用途。禁止用于任何违反法律法规、侵犯他人权益的场景。使用者需自行承担一切后果。**

本项目已尽力落实拦截与权限收敛设计（输入目标护栏 fail-closed、全局热键黑名单、危险操作硬拒、追加式审计日志、急停、只读与执行通道隔离），**但不保证 AI 一定不越权**。本项目**大量使用 AI 生成代码，可能存在未知的高风险漏洞**；**AI 的失误也可能会导致使用者出现损失**。请**谨慎处理相关权限，风险自负**。

完整声明见仓库根 `NOTICE.md`。
