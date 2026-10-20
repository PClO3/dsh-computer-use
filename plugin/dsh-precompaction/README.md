# dsh-precompaction — 上下文预压缩后端

给 [dsh（DeepSeek Harness）](https://github.com/deepseek-ai) 装**第二条上下文压缩线**：上下文到 40 万 token 时，**在后台**把旧历史压成摘要；主循环一秒都不停，摘要在下一个 `agent/pre-step` 开头**同步原子替换**。

**给谁用**：跑长任务、被官方压缩的几十秒停顿打断过的 dsh 用户；想给 dsh 加压缩后端、或想知道 `compaction/*` 那套契约怎么用的插件作者。

> **状态**：39 条断言全绿（真实 `Session` + 替身 LLM，不联网、不调模型）；
> **已在真实 dsh 进程里加载并实际压缩过 3 次（2026-10-18，三连顺序全对）**。
> **仍未验的**逐条列在 §六（主要是预设内挂载、400k 长任务、摘要质量），请先读那节再决定装不装。

> **兼容性**：本包基于 **dsh `0.2.0-rc.2`** 开发与验证（`dsh-compaction` / `dsh-llm` / `dsh-session` / `dsh-token-meter` 同为 `0.2.0-rc.2`）。dsh 仍在 RC 阶段，`compaction/*` 契约可能随版本变化；**其他版本未验证**，升级 dsh 后请先跑 `verify-precompaction.mjs`。

---

## 一、它解决什么

dsh 自带的 `@deepseek-ai/dsh-compaction-basic` 到触发线时会**在事务里 `await` 摘要调用**，整个主循环停在那里等模型返回 —— 实测单次几十秒（随上下文长度与模型速度变化）。

本插件把「算」和「写」拆开：

| | 官方 `dsh-compaction-basic` | 本插件 |
|---|---|---|
| 什么时候动 | 越过触发线 | 越过 `triggerTokens`（默认 **400,000**） |
| 摘要怎么算 | 事务里 `await`，**主循环停住** | **后台** job 里算，主循环照跑 |
| 什么时候落地 | 算完当场 | 下一个 `agent/pre-step` 的**最开头**，同步原子替换 |
| 兜底 | — | **官方那条线原样保留**，两条并存 |

```
官方：  越过触发线 → await summarize() → 主循环停几十秒
本插件：越过 400,000 → 后台 summarize() → 主循环照跑 → 下一个 pre-step 同步替换
```

正常情况下永远走不到官方那条线 —— 它是**兜底**，不是被替换掉的东西。

---

## 二、安装

### 2.1 一键（推荐）

```
node install-precompaction.mjs --dry-run     # 先演算，不写任何东西（默认行为）
node install-precompaction.mjs --apply       # 真装
```

> 非 `desktop` profile 请显式指定 patch：`node install-precompaction.mjs --apply --patch "<DSH_HOME>\profiles\<profile>\cordis.patch.yml"`（也接受 `--patch=<路径>`）。不传时默认 `profiles\desktop\cordis.patch.yml`。

它按固定顺序做四件事，**任一条写前断言不过就停手、不写盘**：

1. 备份 `profiles\<profile>\cordis.patch.yml` → `<DSH_HOME>\patch-staging\backup\<时间戳>-precompaction\`
2. 复制插件（`lib/index.js` + `package.json`）→ `<DSH_HOME>\plugins\dsh-precompaction\`
3. 建目录联接 `<插件>\node_modules\@deepseek-ai` → `<DSH_HOME>\profiles\node_modules\@deepseek-ai`
4. 把 `patch-snippet.yml` 追加到 patch 文件末尾

装完自检：

```
node verify-install.mjs        # 7 条，逐条打印原始证据
```

**装完必须重启桌面端**（配置是启动时读的）。

### 2.2 手工（不想跑脚本时）

1. 把 `lib/index.js` 与 `package.json` 复制到 `<DSH_HOME>\plugins\dsh-precompaction\`
2. 建联接（**必需**，不是可选；`mklink` 是 cmd 内部命令，PowerShell 里要经 `cmd /c`）：
   ```
   cmd /c mklink /J "<DSH_HOME>\plugins\dsh-precompaction\node_modules\@deepseek-ai" "<DSH_HOME>\profiles\node_modules\@deepseek-ai"
   ```
   插件的三行裸包名 import（`@deepseek-ai/dsh-compaction` / `dsh-llm` / `dsh-session`）在**没有**这个联接的位置会直接 `ERR_MODULE_NOT_FOUND`；而 `<DSH_HOME>\node_modules` 与 `<DSH_HOME>\plugins\node_modules` 通常都不存在，所以只能靠插件目录自己的联接。
3. 把 `patch-snippet.yml` 追加到 `profiles\<profile>\cordis.patch.yml` 末尾，**并把 `@@ENTRY@@` 换成你的真实入口路径**（形如 `file:///C:/Users/<你的用户名>/.dsh/plugins/dsh-precompaction/lib/index.js`）—— 一键脚本会自动做这一步，手工做就得自己填。

### 2.3 为什么是顶层 `insert`

片段用**顶层 `insert`**（host 平面），不塞进 `id: compaction` 组。原因：桌面 patch 里可能有**多个** `- id: compaction`（官方内置预设与自建预设各一份），而 dsh 的 patch 引擎（`dsh-app-boot/lib/index.js` L64-88）用 **Map** 索引 id、**后写覆盖先写** ⇒ `insert` 到 `id: compaction` 会**静默落进某一个**预设。顶层 insert 则对所有预设生效。

> ✅ **已实测（2026-10-18）**：`agent/pre-step` 确实送得到 host 平面监听器；未验的是「挂进预设内部」那条路，见 §六 第 2 条。

---

## 三、参数

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（回滚用，见 §七） |
| `auto` | `true` | 自动触发开关 |
| `onlyPresets` | `[]` | **只在这些预设（agent preset）的会话里动作**；空 = 不限制。名单非空但读不到预设 ⇒ 一律不动作（安全默认） |
| `triggerTokens` | `400000` | 预压缩触发点 |
| `dangerTokens` | `480000` | 超过它就放弃后台路线、让位官方（见 §四 第 10 条） |
| `keepTokens` | `16000` | 「纯保留」近期预算 |
| `overlapTokens` | `4000` | 额外回带的重叠量，保上下文连续 |
| `summarizationProvider` / `summarizationModel` | `''` | 空 = 用最近路由；**必须成对设置** |
| `maxSummaryTokens` | `65536` | 摘要输出上限（与官方 `compaction-basic` 默认一致） |
| `cooldownMs` | `60000` | 良性失败后的冷却 |
| `maxJobMs` | `600000` | 单个后台 job 的硬上限（超时 abort） |

`dangerTokens` 必须大于 `triggerTokens`，provider/model 必须成对 —— 配置校验不过会直接报错。

---

## 四、设计要点（每条都有官方源码出处）

| # | 决定 | 为什么 |
|---|---|---|
| 1 | 摘要后台算，**提交同步写** | 官方在事务里 `await summarize()`（`dsh-compaction-basic/lib/index.js` L478）—— 这就是阻塞源。拆开它。 |
| 2 | **`compaction/start` 是提交块的第一条，且整个块无 await** | `dsh-compaction/lib/types/types.d.ts` L17-19：start「holds the lock until `compaction/end`」；`lib/invariant.js` L54-62：带 `compact-checkpoint` 的替换消息落地时必须已存在 compactionId 相同的未闭合 start。**反过来（先检查点后 start）会破坏契约；把锁拉长到几十秒会让官方后端与 `/compact` 全程 `busy`**（`dsh-compaction-basic` L536-548）。 |
| 3 | `summary` 与替换消息**紧邻** | `types.d.ts` L30-33：「That adjacency is contractual」。 |
| 4 | 改模型可见内容只走 `session.append` + `surfaceOp: replace` | `dsh-agent/lib/types/runtime-types.d.ts` L318-319：`agent/request` 不能改 messages。 |
| 5 | 工具配对校验**用官方导出的函数** | `dsh-compaction/lib/index.js` L175 的公开导出面含 `toolPairingBalancedBefore` / `After`。不手写。 |
| 6 | 提交前查**四道复核** | 见下。只查「seq 还在表层」不够 —— `compaction/prune` 与官方压缩都是**原地 replace 同一个 seq**：seq 在、内容变了。 |
| 7 | 摘要输入带 `toolHistory` | 官方 `summarizeWithLlm` L316 传它，注释说是为了暖前缀复用。 |
| 8 | 用 `ctx.llm.stream()`，**不用 subagent** | 若你的环境用插件包装了 subagent，它可能无条件覆盖模型、吃预算、写审计；且「不阻塞」的关键是**不 await**，不是谁去跑。 |
| 9 | 后台 job **不用 turn 的 signal** | turn 的 signal 在 turn 结束时 abort，而 job 需要跨 turn 存活。用自己的 `AbortController` + `maxJobMs` 兜底。 |
| 10 | 压力 ≥ `dangerTokens` 时**主动放弃** | 此时后台压完之前就可能撞官方线，让位给官方同步压缩反而更稳。 |

### 提交前的四道复核

| # | 查什么 | 拦住什么 |
|---|---|---|
| 0 | `surface.contentGeneration` 是否前进 | 消息投影类变更（形状不变的改写） |
| 1 | `[startSeq, endSeq]` 是否仍是同一串 seq | 官方压缩抢先跑 / 工具结果修剪（形状变了） |
| 2 | 每个节点的**消息指纹**是否一致 | 形状没变但内容被换掉 |
| 3 | 两端是否仍是工具配对平衡切点 | 被别的东西改成了不平衡边界 |
| 4 | 摘要是否**比原文小** | 官方 L600-601 同款保护 |

任一条不过 = **良性失败**：记日志、丢弃摘要、进冷却，**绝不写 `compaction/start`**。

---

## 五、验证：39 条断言

```
node verify-precompaction.mjs     →  结果：通过 39 ｜ 失败 0
```

**自包含，不需要 dsh 运行时**：脚本自己用 `module.registerHooks` 把 `@deepseek-ai/*` 解析到 `%DSH_HOME%\profiles\node_modules`，**不需要给插件目录做联接**（正好避开 §二 那个「打包时把包实体复制进去」的坑）。**不联网、不调模型**（`ctx.llm.stream` 是替身）。

| 组 | 覆盖 |
|---|---|
| A (5) | 系统提示词永不入选 / 无系统头时可从 0 起 / **不切开工具调用对** / 重叠生效 / 没东西可压返回 null |
| B (1) | 摘要输入：系统提示词第一位 + 被压区域 |
| C (3) | **检查点前置条件**（记录运行时是否拦截；未加载不变量组件时不拦，属观测项不是强制项）／正常提交后表层真的变小且检查点被 `deriveMessages` 渲染 / **`foldSurface` 重放结果与在线表层逐位一致** |
| D (5) | 同一时刻只有一个 job / 摘要失败不影响主循环 / 低于触发点不动 / danger 让位 / 开关关闭时完全不动 |
| E (6) | 内容被换 → 拒绝 / 工具结果被修剪 → 拒绝 / 范围失效 → 拒绝 / 摘要过大 → 拒绝 / **各路径下 start 与 end 数量恒相等** / **replace 落地失败时仍补带 error 的 end（锁不漏）** |
| F (5) | 配置校验（danger>trigger、provider/model 成对、默认值 = 400000/16000/4000）／**`onlyPresets` 校验（非空字符串数组、不许重复、trim、freeze；6 种非法输入必须抛错）**／**`readAgentPreset` 三级回退链（8 种情况，含模拟 cordis「未 inject 就抛错」）** |
| G (3) | `COMPACTION_INSTRUCTION` 与官方**逐字**一致 / `CHECKPOINT_PREAMBLE` 逐字一致 / `frameSummary` 等价 |
| H (6) | `apply()` 注册监听器 / 遵守 waterfall 契约 / 后端抛错也放行 `next()` / dispose 生效 / signal 已 abort 时直接返回 / **`inject` 仍是 `['llm','tokenMeter']`** |
| I (5) | **闸门语义**：名单非空且预设不在名单 ⇒ 不起 job、写 0 条 start、**只记一次日志**／名单命中 ⇒ 正常起 job／**读不到预设 ⇒ 一律不动作**（安全默认）／名单为空 ⇒ 与旧版一致／**只挡「起新 job」、不挡提交**（中途换预设，已算好的摘要仍落地） |

**关键：C 组的 `Session` 是官方真货** —— `session.append(...)` 的 surface 校验、`deriveMessages()` 的重派生、官方 `toolPairingBalanced*` 全走真实代码路径，不是 mock。只替身了两样：`ctx.llm.stream()`（免得真花钱）与 `ctx.tokenMeter.measure`（免得起 cordis 服务）。

---

## 六、⚠️ 明确**没有**验证的东西

**装之前请读完这节。**

> **2026-10-18 已确认的部分**：真实 dsh 进程里**加载成功**、`inject` 解析正常、`agent/pre-step` **确实送得到 host 平面**、并**实际压缩过 3 次**（三连顺序全对）。下表列的是**仍未验**的部分。

| # | 没验的 | 为什么重要 |
|---|---|---|
| 1 | **`ctx.tokenMeter.measure()` 真实值** | 测试用的是官方启发式估算器（`estimateMessage`）自算的等价物。真机上 `measure()` 还会用 provider usage 做锚点，**触发时机可能与测试不同** |
| 2 | **预设内挂载**（旧写法：把插件塞进 computer-use 预设的 `plugins`；**本版已改为顶层 insert + `onlyPresets`**，见 §二） | 已验证的是 **host 平面 + `onlyPresets`** 那条路；挂进预设内部**没跑过** —— 若失败，表现为该预设加载报错。**本包不再走这条路，此条留作历史记录** |
| 3 | **`purpose: 'compaction'` 对适配器的影响** | 搜遍 `dsh-llm-pi-ai` / `dsh-llm` / `dsh-deepseek-llm-api-extensions`，`purpose` **没有被任何代码读取**。是类型层的预留字段 |
| 4 | **同会话并发两个模型请求** | 官方压缩时主循环是停的（全程一个请求）；本插件主循环照跑 ⇒ 同一 sessionId 上同时两个请求。网关是否允许/限流，**未知** |
| 5 | **真实长任务里 400k 触发、无停顿** | 需要真机长任务 |
| 6 | **摘要质量**（模型能否接着干） | 需要真机 |
| 7 | **官方后端与预压缩的实际交互** | 只有源码级推理 + 单测模拟 |
| 8 | **profile 是否加载了不变量组件** | 查过 `dsh-base` / `dsh-web-app` / desktop 三层 patch 与全部 `/invariant` 导入，**零命中**。所以第 2 条契约**今天不会当场报错** —— 但它官方文档化，且锁的副作用（L536-548）是**会**当场生效的 |

### 想自己验「钩子真的会响」

用低触发点装一次，随便聊两轮就会触发（官方线远高于短会话的上下文，所以短会话里出现的 compaction 一定是本插件干的）：

```
node install-precompaction.mjs --apply --test     # 触发点压到 8000（别用 2000：一步就跨过去了）
# 重启桌面端，聊两轮，确认出现 compaction 事件
node install-precompaction.mjs --revert --apply   # 还原
```

`check-compaction-events.py` 可以直接在会话日志上复算压缩事件：

```
python check-compaction-events.py
```

---

## 七、回滚

两种，任选：

- **软关**：在 patch 的 `config:` 下加一行 `enabled: false` —— 插件仍加载，但不做任何动作。
- **整段撤**：`node install-precompaction.mjs --revert --apply` —— 从最近一次备份逐字节还原 patch 文件。

**两种都要重启桌面端。**

---

## 八、许可与第三方

- **自有代码**：**Apache-2.0**，正文见 [`LICENSE`](LICENSE)。
- **第三方**：本仓库**只含自有源码，不打包任何第三方依赖**。运行期需要 dsh 自带的 `@deepseek-ai/dsh-compaction` / `dsh-llm` / `dsh-session`（MIT）；验证脚本另会解析 `@deepseek-ai/dsh-token-meter` —— 全部由你本机的 dsh 安装提供，本仓库不分发。
- 详细声明与免责见 [`NOTICE.md`](NOTICE.md)。

---

## 九、三行头（自证口径）

- **统计口径**：契约与常量全部为**官方包源码实读**（`dsh-session` / `dsh-compaction` / `dsh-compaction-basic` / `dsh-agent` / `dsh-llm` / `dsh-token-meter`，逐条标行号）；验证为 `verify-precompaction.mjs` 的 **39 条断言**（真实 `Session` + 替身 LLM）。
- **最严重的一条**：`compaction/start` 的**写入时机** —— 它既是官方契约要求的「检查点前置条件」（`dsh-compaction/lib/invariant.js` L54-62），又是官方后端的**锁**（`dsh-compaction-basic/lib/index.js` L536-548）。本实现把它压进一个**无 await 的同步四连写**，两个要求同时满足；单测 E4/E5 守着「任何路径下 start 与 end 数量恒相等」。
- **未核实**：见 §六 全部 8 条。
