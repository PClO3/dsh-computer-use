# -*- coding: utf-8 -*-
"""cu-guard.py — computer-use 权限硬护栏（独立设计）

═══════════════════════════════════════════════════════════════════
一句话：这是一副「只拦手、不降权限」的镣铐。
═══════════════════════════════════════════════════════════════════

【为什么不能靠「降权限」来解决】（实测环境：Windows + CPython）
  把进程降到低完整性级别(Low IL)或套受限令牌，会因为 UIPI 让合成键鼠输入
  失效：实测 SetCursorPos 返回 FALSE 且 GetLastError=0（静默失败），
  mouse_event 也不动光标。⇒ 键鼠能力直接报废。
  所以唯一可行路线是：**保留完整令牌，在调用点拦下来**。

【拦在哪一层】（每一条都有实测依据）
  1. CPython 审计钩子 sys.addaudithook —— 装上无法移除，在 OS 调用之前抛异常。
  2. 危险 Win32 API 走 ctypes 的，在**符号解析阶段**(ctypes.dlsym)就拦死。
     实测：ctypes 会把解析到的符号缓存在 DLL 对象的 __dict__ 里，
     所以必须在第一次解析时就拦（本模块另有 _purge_cached_symbols 兜底）。
  3. _winapi 虽然在护栏之前就已加载，但它有审计事件
     （_winapi.OpenProcess / _winapi.TerminateProcess / _winapi.CreateProcess），
     按事件拦即可。
  4. psutil / pywin32 / cffi 这类 C 扩展直接在 C 里调 Win32，**没有审计事件**，
     只能在 import 层拦。（实测：pyautogui 的依赖栈里没有任何模块 import psutil，
     所以拦它不误伤键鼠能力。）
  5. `import subprocess` **绝对不能拦**——pyautogui 自己就 import subprocess，
     拦了它 pyautogui 当场废掉（实测多个用例当场 FAIL）。只拦 subprocess.Popen 动作。
  6. stdlib 的 platform.win32_ver() 会 `cmd /c ver` 起子进程，由引导器在装护栏
     **之前**预热掉（结果带 lru_cache），避免误伤 pyautogui.size()。

【关于「杀进程」的口径】
  设计上不反对「关掉某个程序」，怕的是**误杀 explorer.exe 这类系统关键进程**
  —— 这类进程一死，整个桌面跟着崩。
  但 ctypes 那层只拿得到句柄、拿不到目标 PID，做不到「只放行非保护进程」。
  ⇒ 取舍：Python 层**一律不许**杀进程；要关程序请点窗口的关闭按钮
     （cu_act 不提供杀进程通道）。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import sys
import time

# ══════════════════════════════════════════════════════════════════
# 策略默认值（可被外部 policy.json 覆盖；缺项一律取这里的保守值）
# ══════════════════════════════════════════════════════════════════
DEFAULT_POLICY = {
    "version": 1,
    # 提权：硬拦
    "elevation": "deny",
    # 开子进程：硬拦（含 os.system / os.exec* / os.startfile / subprocess.Popen）
    "spawn": "deny",
    # 杀/挂起进程：Python 层硬拦（要关程序请点窗口的关闭按钮）
    "processKill": "deny",
    # 注册表写入 / 改系统设置 / 关机重启：硬拦
    "registryWrite": "deny",
    "systemSettings": "deny",
    "shutdown": "deny",
    # 联网：标准档放行（严格档可改 "loopback-only"）
    "network": "allow",
    # ★ 反绕过：禁止构造 code 对象。
    #   实测依据：types.CodeType(...) 会触发 code.__new__ 事件，且「造任意字节码 →
    #   改掉审计钩子链表头」是 CPython 官方承认的已知绕过（0CTF 2020 PyAuCalc）。
    #   实测确认：拦掉 code.__new__ 之后 compile()/exec() 照常可用，不误伤正常的代码执行。
    "blockCodeNew": True,
    # paranoid 档 / 精确档：拦 marshal.loads（它能反序列化出 code 对象）。
    # 默认 "user-code-only"：**只拦从用户代码发起的调用**。
    #   实测依据：标准库 .pyc 的加载走 <frozen importlib._bootstrap_external> 的
    #   _compile_bytecode，用户代码发起的执行走另一条路 —— 调用方帧可以精确区分，
    #   所以既能堵住造 code 对象这条路，又不会让"护栏装好后再 import 新模块"失败。
    # 可选值："user-code-only"（默认）| "always"（连 import 一起禁，会误伤延迟导入）| false
    "blockMarshalLoads": "user-code-only",
    # 拦「给函数换 __code__/__globals__/__closure__/__defaults__/__kwdefaults__」。
    #   实测依据：2000 次普通属性赋值触发 0 次 object.__setattr__ 事件，
    #   而 f.__code__ = ... 恰好 1 次 —— 拦它几乎零成本、不误伤普通代码。
    "blockCodeAttrAssignment": True,
    # 文件写入：workdir-only（最稳）| deny-destructive | allow
    "fileWrites": "workdir-only",
    # 点鼠标/敲键盘的目标窗口护栏
    "guiGuard": {
        "enabled": True,
        # 这些进程的窗口：鼠标和键盘都不许碰
        "denyMouseAndKeyboard": [
            "consent.exe",              # UAC 弹窗本体
            "taskmgr.exe",              # 任务管理器（点「结束任务」= 杀进程）
            "procexp.exe", "procexp64.exe", "processhacker.exe",
            "systeminformer.exe", "autoruns.exe", "autorunsc.exe",
            "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe",
            "windowsterminal.exe", "wt.exe", "openconsole.exe",
            "bash.exe", "wsl.exe", "wslhost.exe", "mintty.exe",
            "alacritty.exe", "wezterm-gui.exe", "conemu64.exe", "conemu.exe",
            "cscript.exe", "wscript.exe", "mshta.exe", "rundll32.exe",
            "regedit.exe", "mmc.exe", "gpedit.msc", "taskschd.msc",
            "services.msc", "diskmgmt.msc", "eventvwr.exe",
            "systemsettings.exe",       # 系统设置（与 Win+I 热键拦截配套）
        ],
        # 这些进程的窗口：只禁键盘、鼠标照常（堵「地址栏执行命令」「Win+R 运行框」）
        "denyKeyboardOnly": [
            "explorer.exe",             # 资源管理器地址栏能执行命令；开始菜单/Run 框也是它
            "startmenuexperiencehost.exe",
            "searchexperiencehost.exe", "searchhost.exe",
            "shellexperiencehost.exe", "textinputhost.exe", "sihost.exe",
            "mstsc.exe",                # 远程桌面连接（敲进去的键会穿透到远端）
        ],
        # 目标窗口属于**已提权**进程 → 一律不许碰（鼠标键盘都禁）
        "denyElevatedWindows": True,
        # 查不出目标进程提权状态时怎么办：deny（默认，保守）/ allow。
        # 实测：查不出的典型原因就是 OpenProcess 被拒 —— 而那正是"对方防护更高"的信号，
        # 所以默认按 deny。早期实现这里是 fail-open（未知当放行），属高危，已改为 deny。
        "elevatedUnknown": "deny",
        # 命中时是否抛异常（False = 只记审计放行；调试用）
        "enforce": True,
    },
    # 审计日志
    "auditPath": None,
    "debug": False,
}

# ══════════════════════════════════════════════════════════════════
# 黑名单：ctypes 符号名（子串匹配，跨所有 DLL）
# ══════════════════════════════════════════════════════════════════
DENY_SYMBOL_SUBSTR = (
    # ── 提权 / 身份 ──
    "ShellExecute", "CreateProcess", "WinExec", "LogonUser", "LsaLogonUser",
    "AdjustTokenPrivileges", "ImpersonateLoggedOnUser", "SetThreadToken",
    "DuplicateToken", "OpenProcessToken", "OpenThreadToken", "SetTokenInformation",
    "CreateRestrictedToken", "SaferComputeTokenFromLevel", "AllocateLocallyUniqueId",
    "LookupPrivilegeValue", "LookupPrivilegeName", "CreateProcessWithLogon",
    "CreateProcessAsUser", "CreateProcessWithToken",
    # ── 进程终止 / 挂起 / 内存注入 ──
    "TerminateProcess", "TerminateJobObject", "OpenProcess", "SuspendThread",
    "ResumeThread", "OpenThread", "NtTerminate", "ZwTerminate", "NtOpenProcess",
    "ZwOpenProcess", "NtSuspendProcess", "NtResumeProcess", "DebugActiveProcess",
    "SetThreadContext", "GetThreadContext", "Wow64SetThreadContext",
    "CreateRemoteThread", "VirtualAllocEx", "VirtualProtectEx", "VirtualFreeEx",
    "WriteProcessMemory", "ReadProcessMemory", "QueueUserAPC", "SetWindowsHookEx",
    "NtWriteVirtualMemory", "NtReadVirtualMemory", "RtlCreateUserThread",
    "CreateToolhelp32Snapshot", "Process32First", "Process32Next", "Process32",
    "EnumProcesses", "EnumProcessModules", "K32EnumProcesses",
    "AssignProcessToJobObject", "SetInformationJobObject", "CreateJobObject",
    # ── 动态解析符号（自己找符号 = 绕黑名单）──
    #    注意：GetModuleFileName **故意不在**这里 —— pyautogui 导入时会解析
    #    kernel32!GetModuleFileNameW，拦了它会把键鼠能力做废（本模块 selfcheck() 就是
    #    用来自动发现这种冲突的）。查自己 exe 路径本身也不构成权限。
    "GetProcAddress", "LoadLibrary", "LoadPackagedLibrary", "LdrLoadDll",
    "LdrGetProcedureAddress", "GetModuleHandle",
    # ── 服务 / 计划任务 / 系统 ──
    "OpenSCManager", "CreateService", "ChangeServiceConfig", "StartService",
    "DeleteService", "ControlService", "OpenService",
    "NetUserAdd", "NetUserSetInfo", "NetLocalGroupAddMembers", "NetShareAdd",
    "InitiateSystemShutdown", "ExitWindowsEx", "NtShutdownSystem",
    "SetSystemTime", "SetLocalTime", "SetComputerName", "SetLocaleInfo",
    "SystemParametersInfo", "SetSystemFileCacheSize", "LockWorkStation",
    # ── 注册表写入 ──
    "RegSetValue", "RegCreateKey", "RegDeleteKey", "RegDeleteValue",
    "RegSaveKey", "RegRestoreKey", "RegLoadKey", "RegUnLoadKey",
    "RegConnectRegistry", "RegReplaceKey", "RegRenameKey",
    # ── 软关窗 / 控窗（绕过「点 X」的替代路线）──
    "PostMessage", "SendMessage", "PostThreadMessage", "EndTask",
    "NtUserPostMessage", "NtUserSendInput",
    # ── 锁用户输入 / 锁光标（能把用户锁在门外）──
    "BlockInput", "ClipCursor", "SwitchDesktop", "SetThreadDesktop",
    # ── 内存可执行化（写 shellcode 的前置）──
    "VirtualAlloc", "VirtualProtect", "NtAllocateVirtualMemory",
    "NtProtectVirtualMemory", "RtlMoveMemory",
    # ── 补漏：这些能起进程/写注册表但原本不在名单里 ──
    "NtCreateUserProcess", "RtlCreateUserProcess", "NtCreateProcess",
    "NtSetValueKey", "NtCreateKey", "NtDeleteKey", "NtDeleteValueKey",
    "RegSetKeyValue", "RegCreateKeyTransacted", "NtUserMessageCall",
    "NtQueueApcThread", "RtlCreateUserThread", "NtCreateThreadEx",
)

# ★ 精确匹配名单（不是子串）。
#   为什么需要它：`msvcrt.system` / `ucrtbase.system` 是**纯 C 调用**，
#   不发任何审计事件，只能靠 ctypes 符号闸门拦；而 "system" 太短，
#   放子串里会误伤（虽然大写 S 的 GetSystemMetrics 不受影响，
#   但谁也不能保证将来没有小写 system 的良性符号）。所以用精确匹配。
#   实测依据：`ctypes.CDLL('msvcrt').system` 能直接解析出函数对象，
#   调用它就是 `system("taskkill /F /IM explorer.exe")` —— 杀进程能力当场破。
DENY_SYMBOL_EXACT = frozenset({
    "system", "_wsystem", "popen", "_popen", "_wpopen",
    "execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe",
    "spawnl", "spawnle", "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe",
    "_execl", "_execle", "_execlp", "_execlpe", "_execv", "_execve", "_execvp", "_execvpe",
    "_spawnl", "_spawnle", "_spawnlp", "_spawnlpe",
    "_spawnv", "_spawnve", "_spawnvp", "_spawnvpe",
    "ShellExecuteA", "ShellExecuteW", "ShellExecuteExA", "ShellExecuteExW",
    "WinExec", "CreateProcessA", "CreateProcessW",
    "TerminateProcess", "OpenProcess", "NtTerminateProcess", "ZwTerminateProcess",
    "GetProcAddress", "LoadLibraryA", "LoadLibraryW", "LoadLibraryExA", "LoadLibraryExW",
})
# 明确不能拦的（键鼠/截屏命脉）—— 用来自检黑名单有没有误伤
MUST_ALLOW_SYMBOL_SUBSTR = (
    "SetCursorPos", "GetCursorPos", "mouse_event", "keybd_event", "SendInput",
    "GetSystemMetrics", "GetDC", "GetAsyncKeyState", "SetProcessDPIAware",
    "OpenClipboard", "CloseClipboard", "EmptyClipboard",
    "GetClipboardData", "SetClipboardData",
    "GlobalAlloc", "GlobalLock", "GlobalUnlock", "GlobalFree", "GlobalSize",
    "GetForegroundWindow", "WindowFromPoint", "GetWindowThreadProcessId",
    "GetClassName", "GetWindowRect", "IsWindowVisible", "GetAncestor",
    "EnumWindows", "GetWindowText", "GetWindowTextLength", "MessageBox",
    "GetCurrentProcess", "GetCurrentProcessId", "CloseHandle", "GetTickCount",
    "GetTokenInformation", "QueryFullProcessImageName", "GetLastError",
    "Sleep", "GetModuleFileName",   # ← 注意：这一条与黑名单冲突，见 _selfcheck()
)

# import 层黑名单（C 扩展 / 纯 C 调 Win32，审计事件覆盖不到）
DENY_IMPORT = frozenset({
    "psutil", "wmi", "pywinauto", "uiautomation",
    "win32api", "win32process", "win32security", "win32event", "win32gui",
    "win32service", "win32file", "win32con", "win32job", "win32ts",
    "pywintypes", "pythoncom", "comtypes", "cffi", "_cffi_backend",
    "ctypes.macholib",
    # ★ 审计钩子**按解释器隔离** —— 主解释器装的钩子，
    #   在 _interpreters.create() 出来的子解释器里**不生效**（子解释器里
    #   os.system / os.kill 可跑、ctypes / subprocess 可导入、父 hook 收不到
    #   子解释器的 sys.audit），而创建/运行子解释器**不发可用的审计事件**。
    #   ⚠️ 但这三个模块**不能直接封 import**：实测 pyautogui 的导入链会 import
    #      _interpreters，一封就把键鼠能力做废（实测多个用例当场 FAIL）。
    #   ⇒ 正确做法：**放行 import，装完之后把危险函数换成会抛异常的桩**
    #      （见 POISON_MODULES / _PoisonFinder）。
    # 其它能造进程/降权的 C 扩展
    "win32comext", "win32print", "win32clipboard",
})

# 审计事件黑名单（精确名）——「开子进程」
DENY_EVENT_EXACT = frozenset({
    "os.system", "os.kill", "os.killpg", "os.startfile", "os.posix_spawn",
    "subprocess.Popen", "webbrowser.open", "pty.spawn", "multiprocessing.start",
    "ctypes.dlopen.noop",   # 占位，永不触发（保证集合非空便于调试）
})
# 审计事件黑名单（前缀）
DENY_EVENT_PREFIX = (
    "os.exec", "os.spawn", "os.fork", "os.putenv",
    "_winapi.CreateProcess", "_winapi.OpenProcess", "_winapi.TerminateProcess",
    "_winapi.DuplicateHandle", "_winapi.CreateJobObject",
    "_winapi.AssignProcessToJobObject", "_winapi.TerminateJobObject",
    "winreg.CreateKey", "winreg.DeleteKey", "winreg.DeleteValue",
    "winreg.SetValue", "winreg.SaveKey", "winreg.ReplaceKey", "winreg.LoadKey",
    "winreg.RestoreKey",
)
# 文件系统：写/删/改类审计事件
FS_MUTATE_EVENTS = frozenset({
    "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.truncate",
    "os.chmod", "os.chown", "os.link", "os.symlink", "os.utime",
    "shutil.copyfile", "shutil.copymode", "shutil.copystat",
    "shutil.move", "shutil.rmtree", "shutil.unpack_archive",
    "os.replace", "tempfile.mkstemp", "tempfile.mkdtemp",
})

# ══════════════════════════════════════════════════════════════════
# 全局状态
# ══════════════════════════════════════════════════════════════════
_STATE = {
    "installed": False,
    "policy": None,
    "workdir": None,
    "allow_roots": (),
    "audit_path": None,
    "blocked": [],
    "started_at": None,
    "pre_resolved": {},
    "gui_guard_installed": False,
}

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
# ★ 必须用 ctypes.windll.user32 —— 它和 ctypes.WinDLL("user32") **不是同一个对象**！
#   实测 `ctypes.WinDLL('user32') is ctypes.windll.user32` → False。
#   而 pyautogui / pyscreeze / pyperclip 用的都是 ctypes.windll.user32。
#   早期实现把钩子包在自己 new 出来的 WinDLL 上，结果整个 GUI 护栏**完全空转**
#   （这个 bug 其实早有迹象：
#    值仍是 <_FuncPtr object>，如果包装生效应该是 <function ...>）。
_u32 = ctypes.windll.user32
_adv = ctypes.WinDLL("advapi32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TokenElevation = 20


# ══════════════════════════════════════════════════════════════════
# 审计日志（护栏自己写，必须永远成功、永远不抛）
# ══════════════════════════════════════════════════════════════════
def _audit(event, **kw):
    # ★ 第一个形参**绝对不能叫 kind**：有调用点要传 kind=<输入类型: mouse/keyboard>，
    #   撞名会炸成 "TypeError: _audit() got multiple values for argument 'kind'"。
    #   这个 bug 藏了很久没暴露 —— 因为此前所有用例都只调 _decide()（纯判定），
    #   而真正拦截的 _gui_check() 一次都没被走到 ⇒ "拦截发生时"的行为从未被验证。
    #   现在两件事都修了：(1) 形参改名 event；(2) 加一层防御，万一以后又有人传
    #   kind=，把它挪到 subKind，绝不让它覆盖事件名。
    if "kind" in kw:
        kw["subKind"] = kw.pop("kind")
    rec = {"ts": int(time.time() * 1000), "src": "cu-guard", "kind": event, **kw}
    _STATE["blocked"].append(rec)
    p = _STATE["audit_path"]
    if not p:
        return
    try:
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except BaseException:
        pass


def _deny(reason, kind, **kw):
    """统一出口：记审计 + 抛 PermissionError（异常从审计钩子里抛出会中止该操作）。"""
    _audit(kind, reason=reason, **kw)
    raise PermissionError("CU-GUARD 拦截[%s] %s" % (kind, reason))


# ══════════════════════════════════════════════════════════════════
# 路径判定
# ══════════════════════════════════════════════════════════════════
def _norm(p):
    try:
        return os.path.normcase(os.path.abspath(str(p)))
    except BaseException:
        return ""


def _under(path, root):
    if not path or not root:
        return False
    if path == root:
        return True
    return path.startswith(root.rstrip("\\/") + os.sep)


def _write_allowed(path):
    n = _norm(path)
    if not n:
        return False
    for r in _STATE["allow_roots"]:
        if _under(n, r):
            return True
    return False


# ══════════════════════════════════════════════════════════════════
# 审计钩子
# ══════════════════════════════════════════════════════════════════
def _trusted_caller(depth, allow_frozen_importlib=False):
    """判断「正在调用危险 API 的那个 Python 帧」是不是解释器自己/标准库。

    为什么需要它：实测发现 import pyautogui 的链条会走到 stdlib 的
    `Lib/types.py:316`（types.coroutine）与 `asyncio/tasks.py:678`，两者内部都会用
    CodeType 复制 code 对象。如果全局拦 code.__new__，pyautogui 直接废掉
    （实测三个用例当场 FAIL）。

    判据（depth 指向真正触发审计事件的那个帧）：
      · `<frozen importlib...>`：**只有 allow_frozen_importlib=True 时才算可信** ——
        实测 6/6 个标准库模块的 .pyc 加载都是它调的 marshal.loads；
      · co_filename 落在 sys.prefix / sys.base_prefix 之下 = 可信；
      · 其它（`<string>` / 工作目录里的脚本）= 不可信，拦。

    `types.coroutine` 只能把已有 code 对象的 flags 改一位，**不能注入任意字节码**，
    所以放行它不构成绕过。
    """
    try:
        f = sys._getframe(depth)
    except ValueError:
        return False
    if f is None:
        return False
    fn = f.f_code.co_filename or ""
    if fn.startswith("<frozen importlib"):
        return bool(allow_frozen_importlib)
    if not fn or fn.startswith("<"):
        return False
    n = _norm(fn)
    for root in (sys.prefix, sys.base_prefix):
        if root and _under(n, _norm(root)):
            return True
    return False


# 给函数换"内脏"的属性：只有真正能换掉**代码本体**的才算危险。
# 实测教训：一开始把 __defaults__ / __kwdefaults__ 也列进来了，
# 结果 `collections.namedtuple` 内部一句 `__new__.__defaults__ = defaults` 被拦，
# 整个 namedtuple 废掉 —— 而 pyautogui 返回的 Point/Size 就是 namedtuple，
# 等于把键鼠能力做废。改默认参数**值**不是注入代码的原语，__code__ 才是。
# 为什么拦它便宜：2000 次普通属性赋值触发 0 次 object.__setattr__ 事件，
# 而 f.__code__ = ... 恰好 1 次 ⇒ 几乎零成本、不误伤普通代码。
DANGEROUS_SETATTR_NAMES = frozenset({
    "__code__",        # 换掉函数体 —— 真正危险的只有这个
    "__globals__",     # 换掉全局命名空间（函数上其实是只读的，留着当兜底）
    "__closure__",     # 换掉闭包捕获（同上，只读）
})


# ══════════════════════════════════════════════════════════════════
# 「import 放行、装完就废」的模块：这些模块**必须**能 import（否则键鼠能力废），
# 但里面的某些函数一旦能用就等于绕过了整副护栏。
# 实现方式：往 sys.meta_path 最前面插一个 finder，把目标模块的 loader 包一层，
# 在 exec_module 之后把危险属性替换成会抛 PermissionError 的桩。
# ══════════════════════════════════════════════════════════════════
POISON_MODULES = {
    "_interpreters": ("create", "run_string", "run_func", "exec", "call",
                      "call_in_thread", "create_thread"),
    "_xxsubinterpreters": ("create", "run_string", "run", "call", "create_thread"),
    "interpreters": ("create", "run_string", "run_func", "exec", "call"),
}


def _make_blocker(modname, attr):
    def _blocked(*a, **k):
        raise PermissionError(
            "CU-GUARD 拦截[subinterpreter] %s.%s 已被禁用："
            "CPython 的审计钩子按解释器隔离，子解释器里护栏等于不存在，"
            "所以这条入口被封。需要并发请用线程。" % (modname, attr))
    _blocked.__name__ = attr
    return _blocked


class _PoisonLoader:
    """包住真正的 loader：先正常加载，再把危险属性换成桩。"""

    def __init__(self, inner, name):
        self._inner = inner
        self._name = name

    def create_module(self, spec):
        f = getattr(self._inner, "create_module", None)
        return f(spec) if f is not None else None

    def exec_module(self, module):
        self._inner.exec_module(module)
        done, failed = [], []
        for attr in POISON_MODULES.get(self._name, ()):  # noqa: B009
            if hasattr(module, attr):
                try:
                    setattr(module, attr, _make_blocker(self._name, attr))
                    done.append(attr)
                except BaseException as e:  # noqa: BLE001
                    failed.append("%s:%s" % (attr, type(e).__name__))
        _audit("poisoned-module", module=self._name, disabled=done, failed=failed)

    def __getattr__(self, item):          # 其余属性（get_code 等）原样透传
        return getattr(self._inner, item)


class _PoisonFinder:
    def find_spec(self, fullname, path=None, target=None):
        if fullname not in POISON_MODULES:
            return None
        for finder in list(sys.meta_path):
            if finder is self:
                continue
            try:
                spec = finder.find_spec(fullname, path, target)
            except BaseException:
                spec = None
            if spec is not None and spec.loader is not None:
                try:
                    spec.loader = _PoisonLoader(spec.loader, fullname)
                except BaseException:
                    pass
                return spec
        return None


def _install_poison_finder():
    for m in list(sys.meta_path):
        if isinstance(m, _PoisonFinder):
            return
    sys.meta_path.insert(0, _PoisonFinder())
    # 已经加载过的（护栏装载之前就 import 了）就地补毒
    for name, attrs in POISON_MODULES.items():
        mod = sys.modules.get(name)
        if mod is None:
            continue
        done = []
        for attr in attrs:
            if hasattr(mod, attr):
                try:
                    setattr(mod, attr, _make_blocker(name, attr))
                    done.append(attr)
                except BaseException:
                    pass
        if done:
            _audit("poisoned-module-preloaded", module=name, disabled=done)


def _hook(event, args):
    # —— 热路径：绝大多数事件直接弹开 ——
    if event == "ctypes.dlsym":
        _on_dlsym(args)
        return
    if event == "ctypes.dlopen":
        _on_dlopen(args)
        return
    if event == "import":
        _on_import(args)
        return
    if event == "code.__new__":
        # compile() 不触发这个事件（实测：只触发 compile），所以拦它不误伤正常的代码执行。
        # 但要放行解释器自带库（见 _trusted_caller 的说明），否则 pyautogui 会被误伤。
        # depth=2：0=本函数 1=_hook 2=真正触发审计事件的那个 Python 帧。
        if _STATE["policy"].get("blockCodeNew", True) and not _trusted_caller(2):
            _deny("拒绝从用户代码构造 code 对象（CodeType 是已知的审计钩子绕过入口）",
                  "code-new", args=str(args)[:160])
        return
    if event == "marshal.loads":
        # marshal.loads 能直接从字节反序列化出 code 对象 —— 这是 CodeType 之外
        # 唯一剩下的「造任意字节码」路子。实测调用方可以精确区分：
        #   标准库 .pyc 加载 → <frozen importlib._bootstrap_external> 的 _compile_bytecode
        #   用户代码        → <string> / 工作目录里的脚本
        mode = _STATE["policy"].get("blockMarshalLoads", "user-code-only")
        if mode is True or mode == "always":
            _deny("拒绝 marshal.loads（可反序列化出 code 对象）", "marshal-loads",
                  args=str(args)[:80])
        elif mode in ("user-code-only", "user"):
            if not _trusted_caller(2, allow_frozen_importlib=True):
                _deny("拒绝从用户代码调 marshal.loads（可反序列化出 code 对象；"
                      "import 机制走这里不受影响）", "marshal-loads", args=str(args)[:80])
        return
    if event == "object.__setattr__":
        # 只在「用户代码发起」时拦 —— 标准库/第三方库自己改这些属性是正常的
        # （实测踩过的坑：collections.namedtuple 会设 __new__.__defaults__）。
        if _STATE["policy"].get("blockCodeAttrAssignment", True) and len(args) > 1:
            nm = args[1]
            if isinstance(nm, str) and nm in DANGEROUS_SETATTR_NAMES \
                    and not _trusted_caller(2):
                _deny("拒绝从用户代码给函数换 %s（把 code 对象装上去的那一步）" % nm,
                      "setattr-code", attr=nm)
        return
    if event == "sys.addaudithook":
        _audit("audit-hook-added", note="有代码又装了一个审计钩子；本护栏无法被移除，仅记录")
        return
    if event == "open":
        _on_open(args)
        return
    if event in FS_MUTATE_EVENTS:
        _on_fs_mutate(event, args)
        return
    if event in DENY_EVENT_EXACT:
        _deny("事件 %s 被禁" % event, "spawn-or-kill", event=event, args=str(args)[:200])
    for pre in DENY_EVENT_PREFIX:
        if event.startswith(pre):
            if pre.startswith("winreg.") and _STATE["policy"]["registryWrite"] == "allow":
                return
            _deny("事件 %s 被禁" % event, "spawn-kill-registry", event=event,
                  args=str(args)[:200])
    return


# ── ctypes 符号解析 ──────────────────────────────────────────────
def _on_dlsym(args):
    if len(args) < 2:
        return
    lib, sym = args[0], args[1]
    libname = ""
    try:
        libname = str(getattr(lib, "_name", "") or "")
    except BaseException:
        pass
    # 按序号解析 = 故意绕黑名单
    if not isinstance(sym, str):
        _deny("拒绝按序号解析符号（疑似绕过黑名单）", "ctypes-ordinal", lib=libname,
              sym=repr(sym)[:60])
    # 不许碰 Python 自己的 C API（可能拿去改解释器内部状态）
    if re.search(r"python\d*\.dll", libname, re.I) or libname.lower().startswith("python"):
        _deny("拒绝解析 Python 解释器自身符号: %s!%s" % (libname, sym), "ctypes-pythonapi",
              lib=libname, sym=sym)
    for bad in DENY_SYMBOL_SUBSTR:
        if bad in sym:
            _deny("拒绝解析危险 Win32 符号: %s!%s" % (libname or "?", sym),
                  "ctypes-symbol", lib=libname, sym=sym, matched=bad)
    if sym in DENY_SYMBOL_EXACT:
        _deny("拒绝解析危险 C 运行时/系统函数: %s!%s（这类是纯 C 调用，不发审计事件，"
              "只能在符号层拦）" % (libname or "?", sym),
              "ctypes-symbol-exact", lib=libname, sym=sym)


def _on_dlopen(args):
    # 加载 DLL 本身不危险（危险的是拿到里面的危险符号）——只记录，不拦。
    return


# ── import ──────────────────────────────────────────────────────
def _on_import(args):
    if not args:
        return
    name = args[0]
    if not isinstance(name, str):
        return
    root = name.split(".")[0]
    if name in DENY_IMPORT or root in DENY_IMPORT:
        _deny("拒绝 import %s（C 扩展，直接调 Win32 且无审计事件，只能在 import 层拦）" % name,
              "import", module=name)


# ── 文件 ────────────────────────────────────────────────────────
def _mode_is_write(mode, flags):
    if isinstance(mode, str) and any(c in mode for c in "wax+"):
        return True
    if isinstance(flags, int):
        wbits = getattr(os, "O_WRONLY", 1) | getattr(os, "O_RDWR", 2) | \
            getattr(os, "O_CREAT", 0o100) | getattr(os, "O_TRUNC", 0o1000) | \
            getattr(os, "O_APPEND", 0o2000)
        if flags & wbits:
            return True
    return False


def _on_open(args):
    pol = _STATE["policy"]
    if pol["fileWrites"] == "allow":
        return
    path = args[0] if args else None
    if not isinstance(path, (str, bytes, os.PathLike)):
        return
    mode = args[1] if len(args) > 1 else None
    flags = args[2] if len(args) > 2 else None
    if not _mode_is_write(mode, flags):
        return
    if _write_allowed(path):
        return
    # 护栏自己的审计日志是个例外：它默认落在 workdir 的**上一级**
    # （如果日志就在唯一可写目录里，被审计者自己能截断/伪造它），
    # 所以这里对"恰好是那一个文件"开一个精确口子。
    ap = _STATE.get("audit_path")
    if ap and _norm(path) == _norm(ap):
        return
    if pol["fileWrites"] == "deny-destructive":
        return          # 只拦删改（由 FS_MUTATE_EVENTS 负责），允许新建
    _deny("工作区外不许写文件: %s" % str(path)[:180], "fs-write", path=str(path)[:240],
          mode=str(mode)[:20])


def _fs_mutate_roots(args):
    return [a for a in args if isinstance(a, (str, bytes, os.PathLike))]


def _on_fs_mutate(event, args):
    pol = _STATE["policy"]
    if pol["fileWrites"] == "allow":
        return
    paths = _fs_mutate_roots(args)
    if not paths:
        return
    # ★ 注意别退化成"只要有一个目标在允许区就放行"，
    #   于是 os.rename(工作区外目录, 工作区内路径) 被放行 —— 工作区外的数据
    #   可以先被搬进来、再在工作区内被删掉，等于绕过了"工作区外不许删改"。
    #   现在改成：**可判定的每一个路径都必须在允许区**。
    for p in paths:
        if not _write_allowed(p):
            _deny("工作区外不许删/改/移: %s（路径 %s 不在允许区）" % (event, str(p)[:120]),
                  "fs-mutate", event=event, path=str(p)[:240], args=str(args)[:240])


# ══════════════════════════════════════════════════════════════════
# 符号缓存清洗：ctypes 会把解析成功的符号缓存进 DLL 对象，
# 之后再访问不再触发 dlsym 事件 ⇒ 装护栏时先把危险缓存项删掉。
# ══════════════════════════════════════════════════════════════════
def _purge_cached_symbols():
    removed = []
    for loader_name in ("windll", "oledll", "cdll", "pydll"):
        loader = getattr(ctypes, loader_name, None)
        if loader is None:
            continue
        for dll_name, dll in list(vars(loader).items()):
            if dll_name.startswith("_"):
                continue
            try:
                attrs = vars(dll)
            except BaseException:
                continue
            for attr in list(attrs.keys()):
                if attr.startswith("_"):
                    continue
                if any(b in attr for b in DENY_SYMBOL_SUBSTR):
                    try:
                        delattr(dll, attr)
                        removed.append("%s!%s" % (dll_name, attr))
                    except BaseException:
                        pass
    return removed


# ══════════════════════════════════════════════════════════════════
# GUI 目标窗口护栏
# ══════════════════════════════════════════════════════════════════
class POINT(ctypes.Structure):
    _fields_ = [("x", wt.LONG), ("y", wt.LONG)]


class RECT(ctypes.Structure):
    _fields_ = [("left", wt.LONG), ("top", wt.LONG),
                ("right", wt.LONG), ("bottom", wt.LONG)]


def _pre_resolve():
    """在装钩子之前，把护栏自己要用的符号解析好（否则装了钩子就解析不了了）。"""
    syms = {}
    syms["OpenProcess"] = _k32.OpenProcess
    syms["CloseHandle"] = _k32.CloseHandle
    syms["GetCurrentProcess"] = _k32.GetCurrentProcess
    for n in ("GetCursorPos", "GetForegroundWindow", "WindowFromPoint", "GetAncestor",
              "GetWindowThreadProcessId", "GetClassNameW", "GetWindowTextW",
              "GetWindowRect", "IsWindowVisible", "mouse_event", "keybd_event",
              "SendInput", "SetCursorPos", "GetSystemMetrics"):
        syms[n] = getattr(_u32, n)
    syms["OpenProcessToken"] = _adv.OpenProcessToken
    syms["GetTokenInformation"] = _adv.GetTokenInformation
    return syms


def _pid_of_window(hwnd):
    pid = wt.DWORD(0)
    try:
        _STATE["pre_resolved"]["GetWindowThreadProcessId"](hwnd, ctypes.byref(pid))
    except BaseException:
        return 0, 0
    tid = 0
    return pid.value, tid


def _exe_of_pid(pid):
    h = _STATE["pre_resolved"]["OpenProcess"](PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        ok = _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
        return buf.value if ok else ""
    except BaseException:
        return ""
    finally:
        try:
            _STATE["pre_resolved"]["CloseHandle"](h)
        except BaseException:
            pass


def _is_elevated(pid):
    """返回 True=已提权 / False=普通 / None=查不到原因。

    ★ fail-closed 修正：早期实现打不开进程就返回 None，
      而 _decide 只在 `is True` 时才拒 ⇒ **"未知"被当成安全放行**。
      后果实测可见：在真实前台窗口上拿到 `elevated: None`，
      也就是这条规则在真机上从来不生效。
      现在：ERROR_ACCESS_DENIED / ERROR_PRIVILEGE_NOT_HELD 明确当作"对方防护更高"
      ⇒ 返回 True（要拒）；只有"进程不存在"之类的才返回 None。
    """
    h = _STATE["pre_resolved"]["OpenProcess"](PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        try:
            # _k32 是 use_last_error=True 的 WinDLL ⇒ 这里拿到的才是 OpenProcess 的真实错误码
            # （用 kernel32!GetLastError 取会被 ctypes 自己中间的调用冲掉）。
            err = ctypes.get_last_error()
        except BaseException:
            err = 0
        if err in (5, 1314):        # ERROR_ACCESS_DENIED / ERROR_PRIVILEGE_NOT_HELD
            return True
        return None
    tok = wt.HANDLE()
    try:
        if not _STATE["pre_resolved"]["OpenProcessToken"](h, TOKEN_QUERY, ctypes.byref(tok)):
            return None
        val = wt.DWORD(0)
        size = wt.DWORD(0)
        ok = _STATE["pre_resolved"]["GetTokenInformation"](
            tok, TokenElevation, ctypes.byref(val), ctypes.sizeof(val), ctypes.byref(size))
        return bool(val.value) if ok else None
    except BaseException:
        return None
    finally:
        try:
            if tok:
                _STATE["pre_resolved"]["CloseHandle"](tok)
        except BaseException:
            pass
        try:
            _STATE["pre_resolved"]["CloseHandle"](h)
        except BaseException:
            pass


def _window_info(hwnd):
    if not hwnd:
        return None
    root = _STATE["pre_resolved"]["GetAncestor"](hwnd, 2) or hwnd
    pid, _ = _pid_of_window(root)
    cls = ctypes.create_unicode_buffer(256)
    _STATE["pre_resolved"]["GetClassNameW"](root, cls, 256)
    title = ctypes.create_unicode_buffer(512)
    _STATE["pre_resolved"]["GetWindowTextW"](root, title, 512)
    exe = _exe_of_pid(pid) if pid else ""
    base = os.path.basename(exe).lower() if exe else ""
    return {"hwnd": int(root), "pid": pid, "exe": exe, "exeBase": base,
            "class": cls.value, "title": title.value[:120],
            "elevated": _is_elevated(pid) if pid else None}


def _window_under_cursor():
    p = POINT()
    if not _STATE["pre_resolved"]["GetCursorPos"](ctypes.byref(p)):
        return None
    return _STATE["pre_resolved"]["WindowFromPoint"](p)


def _decide(kind, info):
    """kind: 'mouse' | 'keyboard'。返回 None=放行，否则返回拒绝原因字符串。"""
    gg = _STATE["policy"]["guiGuard"]
    if not gg.get("enabled", True):
        return None
    if not info:
        # ★ 原来这里直接 return None（放行）—— 取不到目标窗口
        #   就 fail-open。改成：**再按前台窗口查一次**；仍取不到就按策略处理。
        try:
            info = _window_info(_STATE["pre_resolved"]["GetForegroundWindow"]())
        except BaseException:
            info = None
    if not info:
        if gg.get("unknownWindow", "deny") == "allow":
            _audit("unknown-window-allowed", input=kind,
                   note="取不到目标窗口；unknownWindow=allow 所以放行（这是显式配置的 fail-open）")
            return None
        return ("取不到目标窗口（光标下没有窗口、且前台窗口也取不到）—— "
                "按最保守处理：拒绝。这是 fail-closed；如果你的环境里窗口信息常年取不到，"
                "可以把策略里的 guiGuard.unknownWindow 改成 \"allow\"。")
    base = info.get("exeBase") or ""
    if gg.get("denyElevatedWindows", True):
        elev = info.get("elevated")
        if elev is True:
            return "目标窗口属于已提权进程(%s)，不许操作" % (base or info.get("pid"))
        if elev is None and gg.get("elevatedUnknown", "deny") == "deny":
            # fail-closed：查不出提权状态时按"要拒"处理。
            # 理由：查不出的典型原因就是 OpenProcess 被拒绝，而那**正是**对方
            # 防护级别更高的信号（早期的 fail-open 已修正）。
            return "无法确认目标窗口(%s)的提权状态，按最保守处理：拒绝" % (base or info.get("pid"))
    if base:
        if base in [x.lower() for x in gg.get("denyMouseAndKeyboard", [])]:
            return "目标进程 %s 在黑名单里（终端/任务管理器/提权工具类）" % base
        if kind == "keyboard" and base in [x.lower() for x in gg.get("denyKeyboardOnly", [])]:
            return "不许往 %s 的窗口敲键盘（地址栏/运行框能直接执行命令）" % base
    return None


def _gui_check(kind, info, what):
    reason = _decide(kind, info)
    if reason:
        _audit("gui-blocked", input=kind, what=what, reason=reason,
               target={k: v for k, v in (info or {}).items() if k != "hwnd"})
        if _STATE["policy"]["guiGuard"].get("enforce", True):
            raise PermissionError(
                "CU-GUARD 拦截[gui] %s（%s / 窗口标题「%s」）。"
                "这一条是为了防止绕过防护：请改用窗口的关闭按钮，或在允许的窗口上操作。"
                % (reason, what, (info or {}).get("title", "")))
    return reason


# ══════════════════════════════════════════════════════════════════
# 快捷键黑名单（全局热键）
#
# 为什么窗口级检查挡不住它：
#   输入目标护栏是"先看这一下点给哪个窗口"，但**全局热键由 Windows 按组合键
#   本身路由、不看焦点窗口** —— 前台是记事本时按 Win+R，运行框照样弹出来。
#   所以必须在**按键这一层**拦。
#
# 难点：pyautogui 发 ctrl+shift+esc 是**拆成多次 keybd_event** 的
#   （keyDown ctrl → keyDown shift → keyDown esc → keyUp …）
#   单看一次调用只看到一个键 ⇒ 必须**跨调用跟踪修饰键状态**。
#
# ⚠️ 改版后：**不再拦 Win 键本身**。
#
# 旧版是"拦 Win 键的 keyDown（按下即拒）" —— 那样一切 Win 组合都到不了，
# 但**放行 Win+D / Win+E / Win+S / Win+Q**（方便且低危），
# 只拦 Win+R / Win+L / Win+X / Win+I。所以改成**逐组合判定**：
#   Win 键 keyDown 不再拒，而是记进 mods_down；等第二个键按下时再按组合判。
#
# 放行 Win+E / Win+S 的**硬依赖**（写在代码里，免得以后被拆掉）：
#   它们是安全的，**只因为"往 explorer / 搜索框打字"被窗口层拦住**
#   （见 denyKeyboardOnly），而且 explorer 另有 DACL 锁。
#   如果哪天拿掉窗口层，放行 Win+E（地址栏敲命令）/ Win+S（搜 cmd 再回车）
#   就会立刻变成洞。
# ══════════════════════════════════════════════════════════════════
_VK_MODS = {
    0x10: "shift", 0xA0: "shift", 0xA1: "shift",
    0x11: "ctrl", 0xA2: "ctrl", 0xA3: "ctrl",
    0x12: "alt", 0xA4: "alt", 0xA5: "alt",
    0x5B: "win", 0x5C: "win",
}
_MOD_ALIAS = {"control": "ctrl", "menu": "alt", "lwin": "win", "rwin": "win"}
_VK_BY_NAME = {
    "win": {0x5B, 0x5C}, "lwin": {0x5B}, "rwin": {0x5C},
    "ctrl": {0x11, 0xA2, 0xA3}, "control": {0x11, 0xA2, 0xA3},
    "shift": {0x10, 0xA0, 0xA1}, "alt": {0x12, 0xA4, 0xA5}, "menu": {0x12, 0xA4, 0xA5},
    "esc": {0x1B}, "escape": {0x1B}, "delete": {0x2E}, "del": {0x2E},
    "enter": {0x0D}, "return": {0x0D}, "tab": {0x09}, "space": {0x20},
    "pause": {0x13}, "break": {0x13}, "f4": {0x73},
}
for _c in "abcdefghijklmnopqrstuvwxyz":
    _VK_BY_NAME[_c] = {ord(_c.upper())}
for _d in range(10):
    _VK_BY_NAME[str(_d)] = {0x30 + _d}


def _compile_hotkeys(specs):
    """["win", "ctrl+shift+esc"] → [(必需的修饰键 frozenset, 被拦的 VK frozenset)]。

    纯修饰键的组合（如 "win"）意思是"这个修饰键本身按下就拦" ⇒ 必需修饰键集合为空、
    被拦集合 = 该修饰键的 VK。解析不了的条目**跳过并记审计**（不让一个笔误把整层废掉）。"""
    rules, bad = [], []
    for spec in (specs or ()):
        if not isinstance(spec, str) or not spec.strip():
            continue
        mods, vks, ok = set(), set(), True
        for part in spec.replace(" ", "").lower().split("+"):
            if part in _MOD_ALIAS or part in ("ctrl", "shift", "alt", "win"):
                mods.add(_MOD_ALIAS.get(part, part))
            elif part in _VK_BY_NAME:
                vks |= _VK_BY_NAME[part]
            else:
                ok = False
        if not ok:
            bad.append(spec)
            continue
        if not vks:                       # 纯修饰键 ⇒ 拦它自己
            for m in mods:
                vks |= _VK_BY_NAME[m]
            mods = set()
        if vks:
            rules.append((frozenset(mods), frozenset(vks)))
    if bad:
        _audit("hotkey-spec-unparsed", specs=bad)
    return rules


def _install_gui_guard():
    p = _STATE["pre_resolved"]
    orig_mouse = p["mouse_event"]
    orig_key = p["keybd_event"]
    orig_send = p["SendInput"]
    MOUSEEVENTF_MOVE = 0x0001
    MOUSEEVENTF_ABSOLUTE = 0x8000
    MOUSEEVENTF_WHEEL = 0x0800
    MOUSEEVENTF_HWHEEL = 0x1000
    KEYEVENTF_KEYUP = 0x0002

    gg = _STATE["policy"].get("guiGuard") or {}
    hotkey_rules = _compile_hotkeys(gg.get("denyHotkeys"))
    # ★ 记的是 {修饰键名: 当时真正按下去的那个 VK}，**不能只记名字**：
    #   光 Ctrl 就有 0x11 / 0xA2 / 0xA3 三个 VK，补发 keyUp 必须发准那一个。
    #   （只记名字的旧写法会拿字符串当 VK 用，已实测抓出并修正。）
    mods_down = {}
    hk_stat = {"blocked": [], "seen": 0}

    def _release_held(why):
        """把**已经转发给 OS** 的修饰键补发 keyUp 收回来，再清账本。

        ★ 为什么光清账本没用（已用桩 PoC 实证、并读码确认的漏洞）：
          pyautogui 的 hotkey() 在 keyDown 抛异常后**不会执行 keyUp 循环**
          （它没有 try/finally）⇒ 此前已转发出去的 ctrl↓/shift↓/win↓ 会在 **OS 层残留**。
          残留的后果不只是"我这边账本对不上"：OS 里 Win 一直按着，
          之后**任何一次裸按键都会变成 Win 组合** ——
            残留 Win + 裸 r ⇒ 运行框弹出；残留 Win + 裸 l ⇒ 锁屏；
            残留 Ctrl+Shift + 裸 esc ⇒ 任务管理器被打开。
          ⇒ 黑名单被整层绕过。必须**真把 keyUp 发出去**（用 orig_key，绕开自己的检查）。

        为什么可以照 mods_down 补发：被窗口层拒掉的修饰键不进账本，
        所以账本里剩下的恰好就是**确实转发出去过**的那些。
        """
        released = []
        for _name, mvk in sorted(mods_down.items()):
            try:
                orig_key(mvk, 0, KEYEVENTF_KEYUP, 0)
                released.append(mvk)
            except BaseException:
                pass
        mods_down.clear()
        if released:
            _audit("mods-released", why=why, vks=["0x%02X" % v for v in released])
        return released

    def mouse_event(dwFlags, dx, dy, dwData, dwExtraInfo):
        # 纯移动/滚轮：不改窗口状态，放行（点击/按键才需要查目标）
        action = dwFlags & ~(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE |
                             MOUSEEVENTF_WHEEL | MOUSEEVENTF_HWHEEL)
        if action == 0:
            return orig_mouse(dwFlags, dx, dy, dwData, dwExtraInfo)
        info = _window_info(_window_under_cursor())
        _gui_check("mouse", info, "mouse_event flags=0x%X" % dwFlags)
        return orig_mouse(dwFlags, dx, dy, dwData, dwExtraInfo)

    def keybd_event(bVk, bScan, dwFlags, dwExtraInfo):
        vk = int(bVk) & 0xFF
        is_up = bool(int(dwFlags) & KEYEVENTF_KEYUP)
        mod = _VK_MODS.get(vk)
        hk_stat["seen"] += 1
        if not is_up and hotkey_rules:
            hit = None
            for need, vks in hotkey_rules:
                if vk in vks and need <= set(mods_down):
                    hit = (need, vks)
                    break
            if hit is not None:
                combo = "+".join(sorted(hit[0])) + ("+" if hit[0] else "") + ("vk=0x%02X" % vk)
                hk_stat["blocked"].append(combo)
                _audit("gui-blocked", input="hotkey", combo=combo, vk=vk,
                       modsHeld=sorted(mods_down), rule=[sorted(hit[0]), sorted("0x%02X" % v for v in hit[1])])
                # ★ 拦下来必须**把已转发的修饰键补发 keyUp**（不能只清账本）——
                #   详见 _release_held 的说明：只清账本的话 OS 层修饰键会残留，
                #   之后任何裸按键都会被 OS 当成组合键，整层黑名单被绕过。
                _release_held("hotkey")
                if gg.get("enforce", True):
                    raise PermissionError(
                        "CU-GUARD 拦截[hotkey] 组合键 %s 在黑名单里。"
                        "全局热键由系统按组合键路由、**不看焦点窗口**，所以窗口级检查挡不住它，"
                        "只能在这一层拦。Win 系快捷键能开运行框/开始菜单（= 直接执行任意命令）、"
                        "Ctrl+Shift+Esc 直达任务管理器。请改用窗口的关闭按钮关程序、"
                        "cu_probe 只读查看，不要试图打开这些界面。" % combo)
        if mod:
            if is_up:
                mods_down.pop(mod, None)
            else:
                mods_down[mod] = vk
        info = _window_info(p["GetForegroundWindow"]())
        try:
            _gui_check("keyboard", info, "keybd_event vk=0x%02X" % vk)
        except BaseException:
            # ★ 窗口层把这一下拒了 ⇒ 这个键**根本没发出去**，OS 不知道它被按过。
            #   但**此前**已转发的修饰键仍然按在 OS 里（pyautogui 同样不会补 keyUp）
            #   ⇒ 必须把它们一起收回来，否则会残留成"裸键变组合键"的绕过。
            #   （只撤回"当前这个修饰键"是不够的 —— 那是修键鼠能力误伤，不是修这个。）
            _release_held("gui")
            raise
        return orig_key(bVk, bScan, dwFlags, dwExtraInfo)

    INPUT_KEYBOARD = 1
    _INPUT_SIZE = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28

    def _sendinput_has_keyboard(cInputs, pInputs):
        """扫一遍 INPUT 数组，看有没有键盘类事件（x64：每项 40 字节，type 在偏移 0）。"""
        try:
            base = ctypes.cast(pInputs, ctypes.c_void_p).value or 0
            for i in range(int(cInputs)):
                off = base + i * _INPUT_SIZE
                if ctypes.c_uint.from_address(off).value == INPUT_KEYBOARD:
                    return True
        except BaseException:
            # 读不出来就**保守当有**（宁严勿松）
            return True
        return False

    def SendInput(cInputs, pInputs, cbSize):
        # 保守做法：光标所在窗口和前台窗口都要过关
        for info in (_window_info(_window_under_cursor()),
                     _window_info(p["GetForegroundWindow"]())):
            _gui_check("mouse", info, "SendInput")
        # ★ 这里原来只做窗口检查、不做组合键判定 ——
        #   若未来有输入路径改走 SendInput，整层热键黑名单会**静默失效**。
        #   我的处理不是"再写一套组合键状态机"（那会和 keybd_event 那份走偏），
        #   而是**直接拒绝键盘类 SendInput**：键盘一律走 keybd_event 那条已被覆盖的路。
        #   当前 pyautogui 正是走 keybd_event（_keyDown 用 keybd_event），所以这不影响现有功能，
        #   而它把"静默失效"变成"响亮拒绝 + 告诉改造者该走哪条路"。
        if hotkey_rules and _sendinput_has_keyboard(cInputs, pInputs):
            _audit("gui-blocked", input="sendinput-keyboard", nInputs=int(cInputs))
            if gg.get("enforce", True):
                raise PermissionError(
                    "CU-GUARD 拦截[sendinput] 检测到用 SendInput 注入**键盘**事件。"
                    "全局热键黑名单挂在 keybd_event 上，走 SendInput 会绕过整层黑名单，所以这里直接拒绝。"
                    "（现有功能不受影响：pyautogui 的键盘正是走 keybd_event。）")
        return orig_send(cInputs, pInputs, cbSize)

    # 直接替换 WinDLL 实例上的属性 → pyautogui / pyscreeze / 任何使用者都走这里
    try:
        _u32.mouse_event = mouse_event
        _u32.keybd_event = keybd_event
        _u32.SendInput = SendInput
        # ★ 另一处：pre_resolved 里不能再留**未包装的原始函数** ——
        #   否则用户代码 `cu_guard._STATE["pre_resolved"]["keybd_event"](...)`
        #   一个窗口检查都不走。这里换成 wrapper 本身（调用仍会过检查）。
        p["mouse_event"] = mouse_event
        p["keybd_event"] = keybd_event
        p["SendInput"] = SendInput
        # 接线自证：pyautogui 用的就是 ctypes.windll.user32，而 _u32 就是它。
        # （早期实现用的是 ctypes.WinDLL("user32")，与它不是同一个对象 ⇒ 整个第三层空转。）
        _STATE["gui_guard_installed"] = bool(
            _u32 is ctypes.windll.user32
            and getattr(ctypes.windll.user32, "mouse_event", None) is mouse_event
            and getattr(ctypes.windll.user32, "keybd_event", None) is keybd_event)
        _STATE["hotkey"] = {"rules": len(hotkey_rules), "stat": hk_stat,
                            "modsDown": mods_down}
    except BaseException as e:  # noqa: BLE001
        _audit("gui-guard-install-failed", error=str(e)[:200])
    return _STATE["gui_guard_installed"]


def hotkey_stats():
    """给测试用：看黑名单装了几条、拦过什么。"""
    hk = _STATE.get("hotkey") or {}
    return {"rules": hk.get("rules", 0),
            "blocked": list((hk.get("stat") or {}).get("blocked", [])),
            "modsDown": sorted(hk.get("modsDown") or ()),
            "seen": (hk.get("stat") or {}).get("seen", 0)}



def selfcheck():
    collide = []
    for good in MUST_ALLOW_SYMBOL_SUBSTR:
        for bad in DENY_SYMBOL_SUBSTR:
            if bad in good and bad != good:
                # 例：GetModuleFileName 在黑名单里(想拦自己找模块基址)，
                # 但 GetModuleFileName 也被 pygetwindow 用到 → 属于必须显式裁决的冲突
                collide.append({"允许项": good, "被黑名单命中": bad})
    return {
        "符号黑名单条数": len(DENY_SYMBOL_SUBSTR),
        "import黑名单条数": len(DENY_IMPORT),
        "冲突": collide,
        "有冲突": bool(collide),
    }


# ══════════════════════════════════════════════════════════════════
# 安装入口
# ══════════════════════════════════════════════════════════════════
def install(workdir, policy_path=None, extra_allow=()):
    if _STATE["installed"]:
        return {"already": True}
    pol = json.loads(json.dumps(DEFAULT_POLICY))     # 深拷贝
    if policy_path and os.path.isfile(policy_path):
        try:
            with open(policy_path, "r", encoding="utf-8") as f:
                user = json.load(f)
            gg = dict(pol.get("guiGuard", {}))
            gg.update(user.pop("guiGuard", {}) or {})
            pol.update(user)
            pol["guiGuard"] = gg
        except BaseException as e:  # noqa: BLE001
            sys.stderr.write("[cu-guard] policy 读取失败，用默认策略: %s\n" % e)
    _STATE["policy"] = pol
    _STATE["workdir"] = _norm(workdir)
    _STATE["started_at"] = int(time.time() * 1000)

    roots = [os.path.normcase(os.path.abspath(workdir))]
    for e in extra_allow:
        if e:
            roots.append(os.path.normcase(os.path.abspath(str(e))))
    _STATE["allow_roots"] = tuple(r for r in roots if r)

    ap = pol.get("auditPath") or os.path.join(os.path.dirname(os.path.abspath(workdir)),
                                              "guard-audit.jsonl")
    _STATE["audit_path"] = ap
    try:
        os.makedirs(os.path.dirname(ap), exist_ok=True)
    except BaseException:
        pass

    _STATE["pre_resolved"] = _pre_resolve()
    purged = _purge_cached_symbols() if pol.get("purgeCachedSymbols", True) else []
    gui_ok = _install_gui_guard()
    _install_poison_finder()           # ← 必须在装钩子之前，之后才好 audit
    sys.addaudithook(_hook)            # ← 装上就再也拿不下来
    _STATE["installed"] = True
    _audit("installed", workdir=workdir, purged=purged, guiGuard=gui_ok,
           policyVersion=pol.get("version"))
    return {"installed": True, "purgedSymbols": purged, "guiGuard": gui_ok,
            "auditPath": ap, "selfcheck": selfcheck()}


def install_gui_only(workdir, policy_path=None):
    """给 cu-act.py 这种「只做一次键鼠动作」的独立进程用：
    只装输入目标护栏 + 审计钩子，不改变其它行为。
    （cu-act.py 是插件单独 spawn 的进程，护栏不会自动继承过来。）"""
    if _STATE["installed"]:
        return {"already": True}
    pol = json.loads(json.dumps(DEFAULT_POLICY))
    if policy_path and os.path.isfile(policy_path):
        try:
            with open(policy_path, "r", encoding="utf-8") as f:
                user = json.load(f)
            gg = dict(pol.get("guiGuard", {}))
            gg.update(user.pop("guiGuard", {}) or {})
            pol.update(user)
            pol["guiGuard"] = gg
        except BaseException:
            pass
    _STATE["policy"] = pol
    _STATE["workdir"] = _norm(workdir)
    _STATE["started_at"] = int(time.time() * 1000)
    _STATE["allow_roots"] = (os.path.normcase(os.path.abspath(workdir)),)
    _STATE["audit_path"] = pol.get("auditPath") or os.path.join(workdir, "guard-audit.jsonl")
    _STATE["pre_resolved"] = _pre_resolve()
    _purge_cached_symbols()
    gui_ok = _install_gui_guard()
    _install_poison_finder()
    sys.addaudithook(_hook)
    _STATE["installed"] = True
    _audit("installed-gui-only", workdir=workdir, guiGuard=gui_ok)
    return {"installed": True, "guiGuard": gui_ok, "mode": "gui-only"}


def status():
    return {
        "installed": _STATE["installed"],
        "guiGuard": _STATE["gui_guard_installed"],
        "workdir": _STATE["workdir"],
        "allowRoots": list(_STATE["allow_roots"]),
        "policy": _STATE["policy"],
        "blockedCount": len(_STATE["blocked"]),
        "blocked": _STATE["blocked"][:20],
    }
