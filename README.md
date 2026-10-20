# dsh computer-use 预设与插件（dsh-cu-n1）

给 dsh（DeepSeek Harness）装上「一双眼睛和一双手」的预设与插件：模型自己截屏看屏幕、按编号定位点击、敲键盘，完成 Windows 桌面上的操作任务。

**给谁用**：想让 dsh 代自己操作 Windows 桌面应用的使用者；想把「截图 → 决策 → 执行 → 核对」这个循环接进 dsh 的插件作者。

> **兼容性**：本项目基于 **dsh `0.2.0-rc.2`** 开发与验证（`@deepseek-ai/dsh` 及 `dsh-tools` / `dsh-attachment` / `dsh-compaction` / `dsh-llm` / `dsh-session` / `dsh-token-meter` 同为 `0.2.0-rc.2`）。dsh 仍在 RC 阶段，内部契约与源码行号可能随版本变化；**其他版本未验证**，升级 dsh 后请先跑 `verify-cu-n1.mjs` 与 `verify-precompaction.mjs`。

> 本仓库另附一个**独立可用**的插件 [`plugin/dsh-precompaction/`](plugin/dsh-precompaction/README.md)：让 dsh 的上下文压缩**不再卡住主循环**。它与 computer-use 无耦合，可以只装它、不装 computer-use —— 见 §七。

---

## 一、仓库结构

| 目录 | 是什么 |
|---|---|
| `plugin/dsh-cu-n1/` | **插件本体**。cordis 插件 + Python 辅助脚本，负责工具注册与实际执行。 |
| `preset/computer-use/` | **预设源稿**。定义 computer-use 人格与操作纪律，登记进 profile 后生效。 |
| `plugin/dsh-precompaction/` | **附带插件（可选、独立）**。上下文预压缩后端：40 万 token 时后台算摘要，主循环不停。有自己的 README / NOTICE / 安装脚本。 |

前两者是配套关系：**插件提供能力，预设决定模型怎么用它**。只装插件不登记预设，模型不会按 computer-use 的方式工作。

第三个与它们**互不依赖**：装不装 computer-use 都能单独装它。

> **两个包谁是权威？** `plugin/dsh-precompaction/` 在本包内是**副本**，权威源是独立包 `_发布包-20261018-precompaction-standalone/`（它整包就是这个插件）。
> 因此**改预压缩必须两边一起改，且两份 `lib/index.js` 要字节相同** —— 核对方法：`(Get-FileHash "<本包>\plugin\dsh-precompaction\lib\index.js").Hash -eq (Get-FileHash "<独立包>\lib\index.js").Hash`，返回 `True` 才算同步。


插件里的 `advisor/` 是**可选**的副模型预判组件，**默认关闭**；启用后会把**等待条件、上一步动作与最近截图的元素清单文字**发到你配置的模型网关（默认 DeepSeek API，**不发截图、不发任务描述**）—— 数据外发说明见 [`NOTICE.md`](NOTICE.md) 第 2.5 节。

本 README 只讲**定位与安装**；工具要点、护栏细节、文件清单见 [`plugin/dsh-cu-n1/README.md`](plugin/dsh-cu-n1/README.md)。**完整的参数取值以 `plugin/dsh-cu-n1/lib/index.js` 里的工具 schema 为准**——插件 README 只给速览，不逐参数展开。

### 工具一览

| 工具 | 一句话作用 |
|---|---|
| `cu_screenshot` | 截屏回传模型；`som:true` 时叠加编号徽章，模型说「点几号」即可定位（`scope` 选范围：前台窗口／任务栏／整个桌面；`find` 只回匹配的元素）。 |
| `cu_act` | 执行一次鼠标／键盘动作（click / type / key / scroll / drag 等）。 |
| `cu_probe` | 只读查询窗口／进程／屏幕／文件（唯一例外：`clickable` 传坐标会移动鼠标悬停、结束还原）；`file_tail` 拒读凭证类文件；其中 **`find` 可按名字找可点击元素，不截图、不发图，只回坐标**。 |
| `cu_wait` | 等条件成立（像素变色／窗口出现／文件出现），替代写死等待。 |

> 以上仅为定位用的速览。**参数取值、护栏与降级行为的完整说明在插件 README**，此处不重复。

---

## 二、安装

### 1. 放插件

把 `plugin/dsh-cu-n1/` 整个目录复制到 dsh 的插件目录下：

```
<DSH_HOME>\plugins\dsh-cu-n1\
```

`<DSH_HOME>` 默认是 `~/.dsh`（Windows 上即 `%USERPROFILE%\.dsh`）；若你设过环境变量 `DSH_HOME`，以它为准。

### 2. 登记预设

> **实测确认**：预设**不再走 `.agent-presets/` 目录扫描**，而是在 profile 的 patch 文件里声明。

打开 `profiles\<你的 profile 名>\cordis.patch.yml`，把 `preset/computer-use/agent.cordis.yml` 里的 **`insert:` 条目**加进去。

该文件里有**两条** `insert:`，别搞混：

| | 是什么 | 要不要 |
|---|---|---|
| 第 1 条 | computer-use 预设本体（persona + `cu-n1` 插件） | **必加** |
| 第 2 条 | `dsh-precompaction` 预压缩插件（**顶层 insert**，带 `onlyPresets`） | **可选**，且**只在走 §七 路线 B（手工安装）时**才粘 |

> **为什么不把预压缩塞进预设的 `plugins:` 里**：那条路**没验证过**（预压缩 README §六 第 2 条：跑挂的表现是**整个预设加载报错**），而且只有顶层 insert 才写得了 `onlyPresets` —— 否则它会对你所有预设生效。

### 3. 改哪一行（**必做，不改会加载失败**）

你**实际粘进去**的那几条 `insert` 里，每一处 `name:` 都带 `<你的用户名>` 占位符（上方的注释也写着提醒），都要改：

```yaml
name: file:///C:/Users/<你的用户名>/.dsh/plugins/dsh-cu-n1/lib/index.js          # 第 1 条，必改
name: file:///C:/Users/<你的用户名>/.dsh/plugins/dsh-precompaction/lib/index.js  # 第 2 条，粘了才改
```

**把 `<你的用户名>` 替换成你自己的 Windows 用户名**（即 `%USERPROFILE%` 的最后一段）。

> 没粘第 2 条就不用管它。**粘了却没装插件 → 预设会加载失败**；不想用预压缩就整段删掉。
> 走 §七 路线 A（安装脚本）的话，第 2 条由脚本自己生成，**不要手粘**。

### 4. `auditPath` 无需配置

审计日志路径由插件按 `DSH_HOME` → `~/.dsh` 自动解析。**不要**在预设里手写 `auditPath`。

---

## 三、依赖安装

本仓库**只含自有源码，不打包任何第三方依赖**，依赖请自行安装。

**Python 侧**：

```
pip install pyautogui pillow pyyaml
```

**Node 侧**：插件需要 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-attachment`。把它们接进插件的 `node_modules` 下；真实安装形态是给插件目录做一个**目录联接**（junction），指向 `<DSH_HOME>\profiles\node_modules\@deepseek-ai`（下面这条在 cmd 和 PowerShell 里都能直接跑）：

```
cmd /c mklink /J "<DSH_HOME>\plugins\dsh-cu-n1\node_modules\@deepseek-ai" "<DSH_HOME>\profiles\node_modules\@deepseek-ai"
```

> ⚠️ **打包插件目录前必须先摘掉这个联接。** 这条 `mklink /J` 指向的是 dsh 的整个 `@deepseek-ai` 作用域（实测约 250 个包）。**目录联接会被部分打包工具跟随**（`xcopy /E`、`tar`、部分压缩软件），一旦照做，这 250 个包会被**实体复制**进你的分发物 —— 那就构成对它们的**再分发**，须逐一保留各自的 LICENSE（多为 MIT，与本项目声明不冲突，但义务转到你身上）。
> 要打包发布，先摘联接再打包：`rmdir "<DSH_HOME>\plugins\dsh-cu-n1\node_modules\@deepseek-ai"`（只删联接本体，不影响源目录）。

---

## 四、长期路线：发布到 npm 之后（暂时还没做）

若本插件发布到 npm，预设里的 `name:` **可以直接写包名**（例如 `@用户名/dsh-cu-n1`），届时**不再需要占位符**，第 3 步的替换也就省掉了。

**但有两个前提，必须都满足：**

1. **包要装在 profile 的 `node_modules` 里。** 官方做法：
   ```
   dsh plugin --profile <profile 名> add <包名>
   ```
2. **装到全局 `npm\node_modules` 里不行。** 这是实测结论：放进全局目录会报 `failed to import`。

---

## 五、许可与安全

- **许可证**：本项目自有代码以 **Apache-2.0** 授权，正文见 [`plugin/dsh-cu-n1/LICENSE`](plugin/dsh-cu-n1/LICENSE)。
- **第三方与免责**：第三方组件清单（含 **MouseInfo GPLv3+** 的特别说明）、安全声明与免责、许可合规速查表，见 [`NOTICE.md`](NOTICE.md)；逐组件清单另见 [`plugin/dsh-cu-n1/THIRD_PARTY_NOTICES.md`](plugin/dsh-cu-n1/THIRD_PARTY_NOTICES.md)。
- **预压缩插件**（`plugin/dsh-precompaction/`）的许可与数据流声明**单独一份**：见 [`plugin/dsh-precompaction/NOTICE.md`](plugin/dsh-precompaction/NOTICE.md) —— 它同样以 Apache-2.0 授权，但**没有** GPL 依赖，且有一条必须知道的数据流说明（启用后会话内容会发给模型）。

**安全提示（一句话）**：本项目是通用桌面自动化工具，**仅供学习与合法用途**；护栏已尽力落实，但**不保证 AI 一定不越权**——「已知限制」里记了一条：护栏是减速带、不是安全边界，详见 [`NOTICE.md`](NOTICE.md) §3.2；请谨慎处理权限、风险自负。
---

## 六、使用建议（以 DeepSeek v4.1 Flash 为例）

- 建议使用 `low` 档的思考强度，均衡操作速度与准确度。`off` 档的思考强度会导致模型乱点屏幕，`high` 或 `max` 档的思考强度会导致思考时间过长。

---

## 七、附带插件：`dsh-precompaction`（上下文预压缩）

**它做什么**：dsh 官方的 `dsh-compaction-basic` 到触发线时会 `await` 摘要调用、**主循环停几十秒**。本插件在 **400,000 token** 时就在**后台**把旧历史压成摘要，主循环一秒不停，摘要在下一个 `agent/pre-step` 开头**同步原子替换**；官方那条线原样保留当兜底。

**与 computer-use 的关系**：**没有关系**。可以只装它。

**怎么装 —— 两条路，只能选一条（选错了会重复加载，或脚本直接拒绝执行）：**

**路线 A（推荐）：用安装脚本** —— 它带备份、写前断言、写后复核、装后自检、回滚。

```
cd plugin/dsh-precompaction
node install-precompaction.mjs --dry-run     # 先演算，不写任何东西
node install-precompaction.mjs --apply       # 真装：复制插件 + 建目录联接 + 追加 host 平面 insert
node verify-install.mjs                      # 装后自检（含条目数断言）
```

> **非 `desktop` profile 必须显式指定 patch 文件**，否则脚本会去写 `profiles\desktop\cordis.patch.yml`：
> `node install-precompaction.mjs --apply --patch "<DSH_HOME>\profiles\<profile>\cordis.patch.yml"`

> ⚠️ **走这条路线，就不要把 §二 的第 2 条 `insert` 粘进 patch。** 脚本会自己追加一条 host 平面条目；
> 若 patch 里已经有 `dsh-precompaction` 条目（**包括**藏在预设 `plugins:` 里的），脚本会**直接报错退出**
> —— 那句"会让插件被加载两次"是故意的护栏，不是装坏了。
> 报错后想改参数：先用 `--revert --apply` 撤掉旧条目，再重装。

> **提示：脚本追加的条目只有 §二 那 4 个参数，不带 `onlyPresets`** —— 因此它**对所有预设生效**，不只是 computer-use。
> 只想让它管 computer-use：装完后在 patch 里那段 `config:` 下补一行 `onlyPresets: [ 'computer-use' ]`，再重启桌面端。

**路线 B：手工安装**（想自己改参数、或不信任脚本时用）

1. 把 `plugin/dsh-precompaction/lib/index.js` 与 `package.json` 复制到 `<DSH_HOME>\plugins\dsh-precompaction\`；
2. 建目录联接（缺了会 `ERR_MODULE_NOT_FOUND`；`mklink` 是 cmd 内部命令，PowerShell 里要经 `cmd /c`）：
   `cmd /c mklink /J "<DSH_HOME>\plugins\dsh-precompaction\node_modules\@deepseek-ai" "<DSH_HOME>\profiles\node_modules\@deepseek-ai"`
3. 把 §二 的**第 2 条 `insert`** 粘进 patch，改掉里面的 `<你的用户名>`（**不要**再跑路线 A 的脚本）；
4. 回到包目录跑自检：`cd plugin/dsh-precompaction`，再 `node verify-install.mjs` 复核。

**⚠️ 装之前请先读它自己的 README 的 §六** —— 那里逐条列了**明确没有验证过**的 8 件事（其中「400k 长任务」「摘要质量」仍未验；「预设内挂载」那一条本版已避开，改为顶层 insert）。完整文档：[`plugin/dsh-precompaction/README.md`](plugin/dsh-precompaction/README.md)。

---

## 八、安装执行清单（给 `<DSH_HOME>` 里的 Agent，或你自己照做）

> 这一节是「照着做就行」的版本：步骤 + 判据 + 红线。
> **本包不含任何真实本机路径**（`C:\Users\<真名>` 这类）—— 别从旧包里抄带用户名的说明（那份已废弃）。
> 下文 `<包>` = 本包根目录，`<DSH_HOME>` = 你的 dsh 家目录（默认 `%USERPROFILE%\.dsh`）。

### 8.0 四条红线

1. **改 `<DSH_HOME>` 下任何文件前先备份**，放 `<DSH_HOME>\patch-staging\backup\<日期>-cu-n1\`，备份后核一遍 SHA256。
2. **只追加、不重排**：往 `cordis.patch.yml` 里加条目，不要动别人的段落、不要全局查找替换。
3. **不要把 `node_modules` 一起复制/打包**：`plugins\dsh-cu-n1\node_modules\@deepseek-ai` 是**目录联接**，跟随它会实体复制约 250 个第三方包（见 §三）。
4. **不要提交 git**：装的是运行环境，不是仓库。

### 8.1 装插件

```powershell
$pkg = "<包>\plugin\dsh-cu-n1"
$dst = "<DSH_HOME>\plugins\dsh-cu-n1"

# 只复制这三个目录 + 五个顶层文件；**不要复制 node_modules**
Copy-Item -Recurse -Force "$pkg\lib"     "$dst\lib"
Copy-Item -Recurse -Force "$pkg\advisor" "$dst\advisor"
Copy-Item -Recurse -Force "$pkg\test"    "$dst\test"
Copy-Item -Force "$pkg\README.md","$pkg\package.json","$pkg\LICENSE","$pkg\THIRD_PARTY_NOTICES.md","$pkg\verify-cu-n1.mjs" $dst

# 依赖联接（已存在会报错，属正常，跳过即可）
# mklink 是 cmd 内部命令，PowerShell 里必须经 cmd /c 调用
cmd /c mklink /J "$dst\node_modules\@deepseek-ai" "<DSH_HOME>\profiles\node_modules\@deepseek-ai"
```

### 8.2 装预设

按 §二 选**一条**路线：

- **用安装脚本装预压缩** → 只粘 §二 的**第 1 条** `insert`；
- **手工装预压缩** → 第 1 条 + 第 2 条都粘（第 2 条见 §七 路线 B）。

无论哪条，`name:` 里的 `<你的用户名>` 都要换成实际值。

### 8.3 验收（两条全过才算装好）

```powershell
# ① 三个 .ps1 必须带 BOM —— 丢了会让 UIA 枚举静默降级
Get-ChildItem "<DSH_HOME>\plugins\dsh-cu-n1\lib\*.ps1" | ForEach-Object {
  $b = [System.IO.File]::ReadAllBytes($_.FullName)
  "{0,-20} BOM={1}" -f $_.Name, ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
}

# ② 装进去的和包里逐文件一致
$pkg="<包>\plugin\dsh-cu-n1"; $dst="<DSH_HOME>\plugins\dsh-cu-n1"; $bad=@()
Get-ChildItem $pkg -Recurse -File | Where-Object { $_.FullName -notlike "*node_modules*" } | ForEach-Object {
  $rel=$_.FullName.Substring($pkg.Length+1); $t=Join-Path $dst $rel
  if (-not (Test-Path $t)) { $bad+="缺失 $rel" }
  elseif ((Get-FileHash $_.FullName).Hash -ne (Get-FileHash $t).Hash) { $bad+="不一致 $rel" }
}
if ($bad) { $bad } else { "插件同步：全部一致" }
```

**判据**：① 三行都是 `BOM=True`；② 输出 `插件同步：全部一致`。

### 8.4 重启后的人工验证（**用户本人**做）

1. `cu_probe(kind="find", text="开始", scope="taskbar")` → 应命中任务栏「开始」；
2. `cu_screenshot(som=true)` → 应返回 elements；超过 60 个应看到 `truncated: true`；
3. `cu_act(action="double_click", find_text="开始", find_scope="taskbar")` → 应命中并点击。
