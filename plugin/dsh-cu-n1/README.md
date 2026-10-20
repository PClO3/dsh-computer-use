# dsh-cu-n1 · computer-use 四件套

给 dsh 一双眼睛和一双手(Windows 桌面路径)。靠 **SoM 编号定位**绕开模型的 grounding 短板(模型说"点几号"，不猜像素坐标)；模型侧用任意具备视觉能力的模型即可，本项目针对 DeepSeek / GLM 系列做过调优。

> **兼容性**：基于 **dsh `0.2.0-rc.2`**（`dsh-tools` / `dsh-attachment` 同版本）开发与验证；其他 dsh 版本未验证，升级后请先跑 `verify-cu-n1.mjs`。

| 工具 | 作用 | 要点 |
|---|---|---|
| `cu_screenshot` | 截主屏，PNG 直接回传模型(走 dsh attachments 服务，同内置 `read_image` 机制) | `som:true` 同时枚举可交互元素(UIA)，叠加编号徽章并返回清单;**枚举范围由 `scope` 决定**：`foreground`(默认，前台窗口) / `taskbar`(任务栏——点开始菜单、任务栏图标用这个) / `desktop`(整个桌面，兜底)。**`find` 按名字过滤清单**（如 `find="保存"`，把 ~800 token 的清单压到几十；**一个都没匹配到会如实报 0**，不会假装清单本来就空）。**扫描上限 5000（安全阀）、输出上限 60；被截断时会明说「本范围共 N 个」，并提示"没编号的元素图上看得见，可直接看图估位置点击"**;UIA 失败/太慢自动降级普通截图(somDegraded)。**默认降采样到 1280 宽**(`maxWidth` 可调，传 0 = 原分辨率)：主动降采样通常能省三成左右的图像 token（比例随屏幕宽高比变化，请在自己机器上核一次）——**不主动降就一定吃满 provider 的单图 token 上限**，理由见 `lib/cu-grab.py` 顶部注释。**枚举范围的静默降级 bug 已于 2026-10-15 修复**，并新增 `scope` 参数与可见截断 |
| `cu_act` | 一次鼠标/键盘动作:click / double_click / right_click / type / key / scroll / move / drag / **focus_dsh** | 坐标用物理像素;`element:N` 自动取 SoM 编号中心;**`find_text:"微信"` = 按名字找目标再点它（见下）**;中文 type 走剪贴板粘贴;每次移动类动作后自检鼠标真实到位(防受限令牌静默失败);`focus_dsh` 把 dsh 主界面带回前台(汇报前必调) |
| `cu_probe` | **只读**查询（唯一例外：`clickable` 传坐标会移动鼠标悬停、结束还原）:`windows`(窗口清单/标题/进程/位置) / `processes` / `screen` / `pixel` / `file_tail` / `dir` / **`clickable`** / **`find`** | 用它替代"为了看一眼而写一段 Python";⚠️受限令牌下进程枚举会被系统过滤，返回里带告诫字段。**`find` 按名字找可点击元素，不截图、不发图，只回坐标**（见下） |
| `cu_wait` | 等条件成立(pixel 变色 / window 出现 / file 出现消失)，替代写死 `time.sleep` 干等 | 轮询在 Python 侧**一次进程内**完成，不反复起进程;命中即返回，超时返回 `ok:false` 而不抛错;`timeout_ms` **必填** 1~120000 |
| **（护栏）** | `lib/cu-guard.py` + `cu-guard.policy.json`:cu_act 注入前的**输入目标护栏** + **全局热键黑名单** | 管理员窗口/任务管理器/终端/设置等一律不许碰;热键拦 `win+r/l/x/i`、`ctrl+shift+esc`、`ctrl+shift+enter`、`ctrl+alt+del`;**装不上就拒绝执行**(fail-closed) |

### `cu_act(find_text="微信")` — 按名字点，**找不到就说"没找到"**（2026-10-16 新增）

**解决什么**：模型经常"知道它叫微信，但不知道坐标"。以前只能
`cu_probe(kind="find")` 先查、再由**模型自己决定**要不要点 —— 那个"决定"插件管不着，
实测出现过模型拿**上一次的 SoM 编号**去点（旧位置）的静默点错。

现在把"找 → 点"合成一步：

```jsonc
cu_act(action="double_click", find_text="微信")                       // 找到就双击它
cu_act(action="click", find_text="保存", find_scope="taskbar")        // 在任务栏范围里找
cu_act(actions=[{action:"click", find_text:"开始"},
                {action:"type", text:"记事本"}])                      // 批量里也能混用
```

**行为（都有断言守着）**：

| 情形 | 行为 |
|---|---|
| 找到了 | 用**元素中心坐标**执行，返回里回传 `foundText` / `foundType` / `foundAt`（重名时这是唯一能发现点错的地方） |
| **一个都没找到** | **不抛错** —— 返回 `ok:false` + `notFound:true`，说明里写清「**没有点任何东西**」并给三条下一步建议（换关键词／换 `find_scope`／`cu_screenshot` 看一眼）。**绝不退回坐标乱点。** |
| 批量里某条没找到 | 该条标 `notFound`；默认（遇错即停）其后的标 `skipped`；传 `stop_on_error:false` 则跳过它、后面继续跑。**整批不抛异常**，每条的去向都在结果里 |
| **参数写错**（空串、用在 `type` 上、与 `element` 同给、`find_scope` 非法） | **仍然抛错** —— 那是"写错了"，不是"没找到"，两者必须分开 |
| 同一次调用里同一个名字出现多次 | 只起 **1 次** UIA 枚举（缓存），不会 N 倍开销 |
| 同时给了 `x`/`y` 或 `element` | 以它们为准，`find_text` 不参与解析（与 `element` 同款语义） |

**代价与边界**：
- 每次解析要起一次 UIA 枚举，约 **1~2 秒**（实测 `cu-shot.ps1` 单跑 1.0~1.2s；其中进程启动就占 ~0.5~0.7s）。
- 只在需要坐标的动作上有效（`click` / `double_click` / `right_click` / `move` / `drag`）。
- **重名时点的是 UIA 树序第一个** —— 插件替你选的。返回里会说明点的是哪个，不对就换更精确的关键词或改用 `x`/`y`。
- 解析出来的坐标**照样过 `cu-guard` 护栏**（管理员窗口/终端类仍然拦），这条路径不绕过安全层。
- **省 token**：这条路不发图、也不发元素清单 ⇒ 对"我知道它叫什么、只想点它"的任务，模型可以**完全不截图**。
- UIA 只列**当前可见**的可交互元素 ⇒ "没找到"不等于"这东西不存在"（可能要先滚动/切窗口）。说明里已写明这一点。

---

### `cu_probe(kind="find")` — 按名字找元素，**不发图**
**为什么要有它**：`cu_screenshot(som=true)` 每次都要发一张图（默认 1280 宽 ≈ **642 视觉 token**），
而"这东西在哪"往往只需要**坐标**。`find` 复用同一个 UIA 枚举后端（`cu-shot.ps1`），
但**不截屏、不产出图片**，成本只剩几十 token。

```jsonc
cu_probe(kind="find", text="微信")                        // 默认在前台窗口里找
cu_probe(kind="find", text="保存", scope="foreground")    // 同上，写全
cu_probe(kind="find", text="开始", scope="taskbar")       // 找任务栏/开始菜单里的东西
cu_probe(kind="find", text="记事本", scope="desktop")      // 整个桌面兜底
```

返回 `matched`（匹配几个）、`totalInteractive`（本范围共几个可交互元素）、`elements`（**只含匹配项**，带坐标）。
坐标就是屏幕物理像素，与 `cu_act` 完全一致，**不用换算** —— 直接 `cu_act(x=…, y=…)` 点。

**两条底线（都有断言守着）**：
1. **结果里绝不能出现图片或截图路径** —— 否则"不发图"就是空话。
2. **一个都没匹配到时要如实报 0**，并明确写「别据此断定这东西不存在」——
   模型很容易把"没搜到"当成"没有"，那比不搜还危险。

**什么时候不该用它**：只想"看一眼现在什么样"时仍应走 `cu_screenshot` —— `find` 没有图，
模型看不到画面；而且它要多起一次 PowerShell（约 0.3~1.5s）。

---

### `cu_probe(kind="clickable")` — 悬停式可点击性探针

**为什么要有它**：UIA 枚举经常**拿不到**可交互元素。实测在同一台机器上连查 7 个窗口
（含 dsh 自己的 Chromium 窗口、文件资源管理器等），可交互元素**全部为 0**；
而插件跑的时候同一类窗口能拿到 60 个 —— 也就是说「靠 UIA 知道哪儿能点」这条路**时灵时不灵**。
悬停探针不依赖 UIA，它直接问系统「鼠标现在悬在一个能点的东西上吗」。

> ⚠️ **2026-10-15 更正：上面这条立项理由已被推翻。**
> 那 7 个窗口的「全 0」是在**受限令牌／沙箱环境**里测出来的假象。在普通（非沙箱）环境实测，
> 同一台机器上记事本、dsh 窗口、浏览器等窗口都能枚举出上百到上千个后代，插件自己也能拿满
> **60** 个元素（`{"elements":60}`）⇒ **UIA 在真机上工作正常**，
> 「时灵时不灵」不成立。
> 悬停探针**仍有独立价值**（它回答的是另一个问题：**某个具体坐标**能不能点，完全不依赖 UIA），
> 但它的立项理由需要重写。

两种用法：

```jsonc
// ① 纯只读：读当前鼠标位置的光标形态，不动鼠标
cu_probe(kind="clickable")

// ② 悬停：把鼠标移过去探一下，读完还原
cu_probe(kind="clickable", x=1440, y=600)
cu_probe(kind="clickable", targets=[{x:1440,y:600},{x:2136,y:1534}])  // 最多 8 个
cu_probe(kind="clickable", x=1440, y=600, move=false)                // 强制不动鼠标
```

**判据**（按证据强度排序）：

| 证据 | 结论 | 把握 |
|---|---|---|
| 光标变 `hand`（手形） | `clickable` | 高 |
| 光标变 `ibeam`（文本） | `text-input` | 中 |
| 悬停区域变化**显著高于本底噪声** | `likely-clickable` | 中 |
| 动到了、无变化、光标也不是手 | `not-clickable` | 中 |
| 鼠标**没能移动** | `unknown` | 无（什么都没测到，不编结论） |

**三个已踩过的坑（都在代码里处理了）**：

1. **必须扣本底噪声。** 实测：鼠标**没动**的情况下，同一块区域两次抓图也能差 **29%**
   （时钟、光标闪烁、视频、加载动画）。不扣噪声就会把「这块地方自己在动」误判成「悬停有反馈」。
   所以每次都先做一次「鼠标不动、连抓两次」的对照，报出 `noisePct`，只有
   `signalPct = hoverChangedPct − noisePct` 才算证据。
2. **鼠标没动成时必须拒绝给结论。** 那时读到的光标形态是**鼠标原来那个位置**的，
   与目标坐标毫无关系 —— 按它给结论等于凭空编一个答案。所以 `moved=false` 一律 `unknown`。
3. **鼠标原位落在目标框里时，必须先挪开再取基准**（2026-10-15 修）。
   否则：原位那个元素本来是**悬停高亮态**，「悬停前」的基准图带着高亮；鼠标移到目标后它灭了
   —— 两张一比"有变化"，**原位的反应被算成目标点的反应**（误报"可能能点"）。
   反向亦然：目标点就是鼠标当前位置时，两张图完全一样 ⇒ 误报"不能点"。
   现在只要原位落在框内（±60×±36），就先把鼠标挪到中立点再取基准；
   返回里的 `originMovedFirst` 字段如实报告是否触发了这一步。
   > 类比：想知道"按这盏灯会不会亮"，可你拍照时手正压在**另一盏**灯的开关上；
   > 等你走过去按目标那盏，原来那盏灭了 —— 两张照片一比"有变化"，你就以为目标那盏亮了。

> ⚠️ **只读性边界**：`kind="clickable"` 给了坐标时**会移动鼠标**（`SetCursorPos`），
> 这是 `cu-probe.py` 里唯一一处改变系统状态的操作。边界是：**绝不点击、绝不按键**，
> 且结束时**把鼠标还原原位**（返回 `restored` 字段如实报告还原成功与否）。
> 不传坐标则完全不动鼠标。受限令牌/沙箱下 `SetCursorPos` 会被静默拒绝，
> 此时返回 `moved:false` + 明确告诫，不会给出假结论。


> **`cu_run_code`（跑任意 Python 代码）已整个删除，不留开关。**
> 删掉之后「分析」由 `cu_probe` / `cu_wait` / `cu_screenshot` 接盘，「批量」由 `cu_act(actions:[…])` 接盘。
> **恢复只能整份回滚到删除前的版本，没有「拨开关」这条路。**

## 文件

- `lib/index.js` — 插件主体(cordis 插件，default export `{name, inject, apply}`)
- `lib/cu-grab.py` — Python/PIL 抓屏 + som 徽章绘制（截图主路径；等 UIA 输出最多 12s，超时自动降级）
- `lib/cu-shot.ps1` — UIA 元素枚举(可交互元素 + 顶层窗口清单;属性逐元素 `.Current` 读取 —— CacheRequest 批量取属性实测读到空属性，**已回退**)。**⚠️ 本文件必须保存为 UTF-8「带 BOM」**：无 BOM 时 Windows PowerShell 5.1 按 ANSI 读，GBK 解码会吞掉中文注释后面的换行，曾使 `$host_el` 赋值行被并进注释、**前台窗口枚举静默降级为整个桌面**（2026-10-15 已修）；**上限 60 本身仍是硬上限**——截断现在**可见**了（会明说「本范围共 N 个」），但超出的元素拿不到编号，只能用坐标或 `find`；扫描上限是 5000（安全阀）。不带 `-NoCapture` 时保留旧 GDI+ 截屏能力
- `lib/cu-uia.ps1` — UIA 枚举的公共实现，被 `cu-shot.ps1` 与 `cu-uia-serve.ps1` 点源（**承重文件，缺了 UIA 枚举直接报错**）
- `lib/cu-uia-serve.ps1` — UIA 常驻服务，插件启动后复用同一个进程做枚举（免去每次起 PowerShell 的开销）
- `lib/cu-act.py` — 动作执行(pyautogui,FAILSAFE 开启)。`cu_act(find_text=…)` 的**按名字解析**在 JS 侧完成（复用 `cu-probe.py` 的 `find`），解析出的坐标照样过护栏
- `lib/cu-probe.py` — `cu_probe` / `cu_wait` 的共用后端(只读，永不改状态；唯一例外是 `clickable` 传坐标时会移动鼠标悬停、结束还原)。`file_tail` **拒读凭证类文件**（`.credentials*` / `.env*` / `.npmrc` / 私钥 / `*.pem` / `.ssh`、`.gnupg` 下的文件），避免一句「帮我看看那个凭证文件」把密钥读进模型上下文
- `lib/cu-guard.py` + `lib/cu-guard.policy.json` — 输入目标护栏 + 全局热键黑名单(上表「护栏」那一行的实现；策略取值在 json 里可调)
- `advisor/cu-advisor.py` — **可选副模型(异步顾问)**，见下方「副模型(可选)」
- `advisor/advisor.local.gateway.example.json` — 副模型网关配置模板(改名 `advisor.local.json` 生效)
- `verify-cu-n1.mjs` — 冒烟测试(mock 附件服务):`node verify-cu-n1.mjs`。**产物写系统临时目录**(`%TEMP%\cu-verify-*`)，不落在仓库内。
  > ⚠️ **跑之前必须先有依赖联接**，否则会直接 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools` ——
  > 因为仓库**不含 `node_modules`**。按上面「依赖」一节建好 junction 后再跑。
  > 这也是「陌生用户克隆下来跑不起来」的根因之一（见上「依赖」一节）。
- `test/cu-test.patch.yml` — 真机测试用 --patch 覆盖层(零改动)
- `package.json` / `LICENSE` / `THIRD_PARTY_NOTICES.md`

## 副模型（可选，默认关闭）

`advisor/` 是**可选**的「副模型预判」通道：截屏后把当前任务与最近动作交给一个便宜的小模型，请它提前说出「下一步最可能出什么风险」，供主模型参考。**不装、不配就完全不启用**（`advisor/advisor.local.json` 不存在 = 副模型关闭，`lib/index.js` 不发起任何调用）。

> ⚠️ **数据外发提示（启用前请读）**：启用后，`advisor/cu-advisor.py` 会把**即将等待的条件与时长、上一个动作及其结果、最近一次截图的 SoM 元素清单文字（前 800 字）**发送到你配置的模型网关（默认 `https://api.deepseek.com`，模型默认 `deepseek-chat`），用的是你自己 `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY`。
> **不发送屏幕截图**（发的是元素清单文字，不是图像）；**live 通道不发送你的任务描述**（prompt 第一行是固定占位，只有手动 `replay` 才从历史里取任务文本）；凭证只读不打印。
> 不想外发数据就别建 `advisor.local.json`，一切照常。

启用方式：把 `advisor/advisor.local.gateway.example.json` 复制为同目录的 `advisor.local.json`，按注释改成你的网关与模型；依赖多一个 `pip install pyyaml`。

## 安装

1. 把 `plugin/dsh-cu-n1/` 整个目录放到 `~/.dsh/plugins/dsh-cu-n1/`（或你的 `DSH_HOME` 所指向的目录下）。
2. 在 profile 的 `cordis.patch.yml` 里登记插件行；预设源稿见 `preset/computer-use/agent.cordis.yml`。
   **`name:` 里的插件入口路径必须按本机替换**——把源稿占位符里的 `<你的用户名>` 换成你自己的 Windows 用户名，或整条换成你的实际绝对路径。
3. **`auditPath` / `workDir` 无需配置**：插件按 `DSH_HOME`（未设置则 `~/.dsh`）自解析到 `~/.dsh/storages/cu-n1/`。

## 依赖

- `node_modules/@deepseek-ai` → junction 指向 `profiles/node_modules/@deepseek-ai`
- **Python**:`pythonPath` 默认按序探测 `~/AppData/Local/Python/bin/python.exe`（Python 官方安装器的用户级路径）→ dsh runtime python；都探测不到就退回 PATH 上的 `python.exe`。**装在别处请显式配 `pythonPath`**。
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
