# dsh computer-use 预设与插件（dsh-cu-n1）

给 dsh（DeepSeek Harness）装上「一双眼睛和一双手」的预设与插件：模型自己截屏看屏幕、按编号定位点击、敲键盘，完成 Windows 桌面上的操作任务。

**给谁用**：想让 dsh 代自己操作 Windows 桌面应用的使用者；想把「截图 → 决策 → 执行 → 核对」这个循环接进 dsh 的插件作者。

---

## 一、仓库结构

| 目录 | 是什么 |
|---|---|
| `plugin/dsh-cu-n1/` | **插件本体**。cordis 插件 + Python 辅助脚本，负责工具注册与实际执行。 |
| `preset/computer-use/` | **预设源稿**。定义 computer-use 人格与操作纪律，登记进 profile 后生效。 |

两者是配套关系：**插件提供能力，预设决定模型怎么用它**。只装插件不登记预设，模型不会按 computer-use 的方式工作。

插件里的 `advisor/` 是**可选**的副模型预判组件，**默认关闭**；启用后会把**任务描述文本**发到你配置的模型网关（默认 DeepSeek API，不发截图）—— 数据外发说明见 [`NOTICE.md`](NOTICE.md) 第 2.5 节。

本 README 只讲**定位与安装**；工具要点、护栏细节、文件清单见 [`plugin/dsh-cu-n1/README.md`](plugin/dsh-cu-n1/README.md)。**完整的参数取值以 `plugin/dsh-cu-n1/lib/index.js` 里的工具 schema 为准**——插件 README 只给速览，不逐参数展开。

### 工具一览

| 工具 | 一句话作用 |
|---|---|
| `cu_screenshot` | 截屏回传模型；`som:true` 时叠加编号徽章，模型说「点几号」即可定位。 |
| `cu_act` | 执行一次鼠标／键盘动作（click / type / key / scroll / drag 等）。 |
| `cu_probe` | 只读查询窗口／进程／屏幕／文件，永不改状态。 |
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

打开 `profiles\<你的 profile 名>\cordis.patch.yml`，把 `preset/computer-use/agent.cordis.yml` 里 `insert:` 那一整条加进去。

### 3. 改哪一行（**必做，不改会加载失败**）

`preset/computer-use/agent.cordis.yml` 中，`cu-n1` 插件那一块的 **`name:` 行**带占位符（该行上方已有一句同样的提醒注释）：

```yaml
name: file:///C:/Users/<你的用户名>/.dsh/plugins/dsh-cu-n1/lib/index.js
```

**把其中的 `<你的用户名>` 替换成你自己的 Windows 用户名**（即 `%USERPROFILE%` 的最后一段）。

### 4. `auditPath` 无需配置

审计日志路径由插件按 `DSH_HOME` → `~/.dsh` 自动解析。**不要**在预设里手写 `auditPath`。

---

## 三、依赖安装

本仓库**只含自有源码，不打包任何第三方依赖**，依赖请自行安装。

**Python 侧**：

```
pip install pyautogui pillow pyyaml
```

**Node 侧**：插件需要 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-attachment`。把它们接进插件的 `node_modules` 下；真实安装形态是给插件目录做一个**目录联接**（junction），指向 `<DSH_HOME>\profiles\node_modules\@deepseek-ai`：

```
mklink /J "<DSH_HOME>\plugins\dsh-cu-n1\node_modules\@deepseek-ai" "<DSH_HOME>\profiles\node_modules\@deepseek-ai"
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

**安全提示（一句话）**：本项目是通用桌面自动化工具，**仅供学习与合法用途**；护栏已尽力落实，但**不保证 AI 一定不越权**，请谨慎处理权限、风险自负 —— 完整声明见 [`NOTICE.md`](NOTICE.md)。
