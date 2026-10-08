# 第三方组件与开源许可声明（THIRD PARTY NOTICES）

本文件列明 `dsh-cu-n1` 所使用、引用或参考的第三方组件及其许可情况。
本仓库**仅分发本项目自有源代码**；第三方组件由使用者自行安装，详见第 3 节。

---

## 1. 代码运行时直接依赖

| 组件 | 版本 | 许可证 | 用途 | 证据 |
|---|---|---|---|---|
| `@deepseek-ai/dsh-tools`（`defineTool`） | **0.2.0-rc.2**（随 dsh 0.2） | **MIT**（⚠️ 0.1.0-rc.2 之前自报 BSD-3-Clause，npm `latest` 为 0.0.1-rc.1 ⇒ **安装须锁版本**） | 工具注册 API | 包内 LICENSE 原文 |
| `@deepseek-ai/dsh-attachment`（`AttachmentId`） | **0.2.0-rc.2**（随 dsh 0.2） | **MIT**（同上，须锁 ≥0.1.0-rc.2） | 截图附件回传 | 包内 LICENSE 原文 |
| dsh 本体（运行宿主） | 0.2.0-rc.2 | **MIT** | 插件运行环境 | 包根 LICENSE 原文 |
| PyAutoGUI | 0.9.54 | **BSD-3-Clause** | 键鼠操作（`cu-act.py`；`cu-guard.py` 只做目标护栏，**不依赖 PyAutoGUI**） | 包内 `licenses/LICENSE.txt` 正文 + 上游 LICENSE |
| ├ PyGetWindow / PyMsgBox / PyRect / PyPerclip | 0.0.9 / 2.0.1 / 0.2.0 / 1.11.0 | **BSD-3-Clause**（PyMsgBox 元数据自相矛盾，见表下说明） | 随 PyAutoGUI 引入；**其中 PyPerclip 实为 MouseInfo 的依赖**（pyautogui 自身不依赖它） | PyRect / PyPerclip / PyMsgBox：包内 `licenses/LICENSE.txt` 正文 + 上游 LICENSE；**PyGetWindow 包内无许可证正文**（`dist-info` 下无 LICENSE 文件、METADATA 无 `License-File` 字段），证据仅到上游 LICENSE + 元数据 |
| ├ PyTweening / PyScreeze | 1.2.0 / 1.0.1 | **BSD-3-Clause**（⚠️ pip 元数据误标 MIT） | 随 PyAutoGUI 引入 | 包内 `licenses/LICENSE.txt` 正文 + 上游 LICENSE（元数据写 MIT，以正文为准） |
| └ **MouseInfo** | 0.1.3 | **GPLv3+** ⚠️ | 随 PyAutoGUI 默认安装引入；**可选组件，运行不强制**（**按许可证正文判定的唯一传染型许可，见第 4 节**） | `pip show` + PyPI 分类器 + 源码实测 |
| Pillow | 12.3.0 | **MIT-CMU** | 截图 / SoM 徽章绘制 | `pip show`（License-Expression） |
| **PyYAML** | 6.x | **MIT** | 读 `~/.dsh/.credentials.yaml` 取副模型凭证（`advisor/cu-advisor.py`）；**仅启用副模型时需要** | `pip show` + PyPI |
| Node.js 内置模块 / Python 标准库 / PowerShell + .NET（随 Windows） | — | 无许可负担 | 其余全部代码 | — |

> **⚠️ PyMsgBox 的许可证元数据自相矛盾，特此披露**：包内 `licenses/LICENSE.txt`、上游 `LICENSE.txt`、以及 `METADATA` 的 `License:` 字段（实测 1694 字符，是**整篇 BSD-3 许可证全文**，以版权行 `Copyright (c) 2014, Al Sweigart` 开头 —— 因上游写的是 `license = { file = "LICENSE.txt" }`，被构建工具把整份正文灌了进去）**三处均为 BSD-3-Clause**；
> 唯独 `Classifier` 标 **GPLv3+** —— 即 **Classifier 单挑其余三处**，不是"三处各不相同"。另：PyMsgBox 的 `LICENSE.txt` 与 PyRect 的一样，第 3 条款里 `{organization}` 占位符**未替换**。
> 若按 Classifier 口径，第 4 节「唯一传染型许可」的结论便不再唯一。两种口径并存，故相关表述一律限定为「**按许可证正文判定**」。
> 本项目对 PyMsgBox 的功能**零调用**（仅作为 PyAutoGUI 的链条成员被导入），风险敞口有限。

---

## 2. 仅参考思想或模式、未复制任何代码

以下内容仅作为设计思路或方法参考，**不包含任何受版权保护的代码片段**：

- **GPT-6 computer-use 调研知识包** —— 行业同构的"截图 → 决策 → 执行 → 验证"循环模式。
- **SoM（Set-of-Mark，编号定位）** —— 学术公开方法，思想本身不受版权保护；本项目的编号徽章由自研 PIL 代码实现，未使用第三方实现。
- **dsh 内置 `read_image` 的"工具结果携带图片块"模式** —— 阅读官方源码学习其 API 用法，实现为本项目原创。

## 3. 明确未使用的第三方项目

OmniParser、CogAgent、UI-TARS、OmegaUse、MAI-UI、playwright-mcp（浏览器路径已砍）。本项目不包含、不依赖上述任何项目。

---

## 4. GPLv3+ 依赖特别说明（MouseInfo）

> 本节是本仓库许可安排中最需要使用者注意的一点，请务必阅读。

**事实**：PyAutoGUI 的 pip 元数据（`Requires-Dist`）把 `MouseInfo`（0.1.3）列为安装依赖，`pip install pyautogui` 默认会一并装上；其许可证为 **GPLv3+**（GNU 通用公共许可证第 3 版或更高版本）。

**事实（源码 + 实测核实）**：`pyautogui/__init__.py` 在模块级 `import mouseinfo`，但该 import 被 `try/except ImportError` 包住（第 245–264 行），属**可选导入** —— 依赖链真实存在，但运行时并不强制。实测（人为让 `import mouseinfo` 抛 ImportError）：PyAutoGUI 照常导入，`click` / `write` / `size` / `position` 全部正常；只有 `pyautogui.mouseInfo()`（一个调试小窗，本项目从不调用）会抛 `PyAutoGUIException`。

**⇒ 可以使用 MouseInfo，但运行起来不强制需要它**：本项目对 MouseInfo 的功能**零调用**（全仓无 `mouseInfo` 调用点）。使用者可自选：留着（pip 默认行为，对功能无影响）；或 `pip uninstall mouseinfo`／`pip install pyautogui --no-deps` 后按第 1 节清单逐个安装 BSD/MIT 依赖——**运行不受任何影响**。

**但请注意**：以上只是**技术事实**，不改变下述 GPL 义务边界——义务在「分发含 GPL 代码的组合」时才产生；装与不装是使用者的自由，红线（勿连 `site-packages` 打包分发）依然有效。

**GPL 的义务边界（通俗表述）**：GPL 并不禁止"使用"，它约束的是"**分发**"——谁把包含 GPL 代码的**组合作品**分发出去，该组合作品整体就须按 GPL 条款提供。

**本仓库采取的安排**：

1. 本仓库只包含本项目自有源代码，通过依赖清单（`requirements` / 安装说明）声明所需依赖，**不打包、不分发** `MouseInfo` 或其他第三方代码；
2. 依赖实际安装发生在**使用者自己的机器上**，组合行为不属于本仓库的对外分发行为；
3. 因此，本仓库自有代码采用 Apache-2.0 许可，与使用者自行安装的 GPLv3+ 依赖**不构成冲突**。

**对使用者的重要提示**：

- 🔴 **请勿制作或分发"连同依赖（`site-packages`）一起打包"的一键安装包。** 该行为会构成组合作品的对外分发，届时整个组合须按 **GPLv3+** 条款提供。
- 如需打包分发，可采用的兼容做法是：**打包版标注 GPLv3+，源码仓库保持 Apache-2.0**（Apache-2.0 允许被并入 GPLv3 作品，进退无损）。
- 若使用者希望彻底消除 GPL 链，**只需不安装 / 卸载 MouseInfo**（运行不受影响，见上）；卸载后 PyPerclip 会成为无用残留（**pip 不级联卸载**），可另行 `pip uninstall pyperclip`。只有想做到"零第三方键鼠依赖"时，才需要以等价的系统 API 调用替换 PyAutoGUI。

---

## 5. 本项目自有代码的许可

除第三方组件外，本仓库所有源代码均为原创，著作权归本项目作者所有，以 **Apache-2.0 许可证**授权，详见 `plugin/dsh-cu-n1/LICENSE`。
选用 Apache-2.0 的理由：与 MIT 同为宽松许可且相互兼容，并额外包含明确的专利授权条款，对使用者与二次开发者更清晰。

---

## 6. 声明与免责

本项目为通用自动化工具，仅供学习与合法用途。禁止用于任何违反法律法规、侵犯他人权益的场景。使用者需自行承担一切后果。

本项目已尽力落实拦截与权限收敛设计（输入目标护栏、全局热键黑名单、危险操作 fail-closed 拒绝等，详见 `README.md`），但**不保证 AI 一定不越权**。本项目大量使用 AI 生成代码，可能存在未知的高风险漏洞；AI 的失误也可能导致使用者出现损失。请谨慎处理相关权限，风险自负。

---

*本文件随依赖变化需同步更新。*
*本文件不构成法律意见。*
