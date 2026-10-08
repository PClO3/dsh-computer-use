# cu-act.py - execute one mouse/keyboard action via pyautogui.
# Usage: python cu-act.py <action.json>
# action.json: {"action": "...", "x": .., "y": .., "text": .., "key": ..,
#               "direction": "up"|"down", "amount": .., "clicks": ..}
# Prints one JSON line to stdout (UTF-8). Never raises: errors go to the JSON.
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

# DPI awareness BEFORE pyautogui so all coordinates are physical pixels.
u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.SetProcessDPIAware.restype = wt.BOOL
u32.SetProcessDPIAware()
u32.GetForegroundWindow.restype = wt.HWND
u32.GetForegroundWindow.argtypes = []

import pyautogui  # noqa: E402  (after DPI pinning)

pyautogui.FAILSAFE = True  # slam mouse to (0,0) aborts with FailSafeException
pyautogui.PAUSE = 0.02

# ---- 输入目标护栏（cu-guard）----------------------------------------------
# cu_act 是插件单独 spawn 的进程，别的护栏不会自动继承过来，所以这里必须自己装一份：
# 注入之前先看目标窗口属于哪个进程、有没有提权 ——
# 管理员窗口 / UAC 弹窗 / 任务管理器 / 终端类窗口一律不许碰。
# 装不上就**拒绝执行**（fail closed），不能"装不上就裸奔"。
try:
    import importlib.util as _ilu
    import os as _cu_os          # cu-act.py 本身没有 import os，这里自带
    _cu_guard_dir = _cu_os.path.dirname(_cu_os.path.abspath(__file__))
    _spec = _ilu.spec_from_file_location(
        "cu_guard", _cu_os.path.join(_cu_guard_dir, "cu-guard.py"))
    _cu_guard = _ilu.module_from_spec(_spec)
    sys.modules["cu_guard"] = _cu_guard
    _spec.loader.exec_module(_cu_guard)
    _cu_wd = (_cu_os.path.dirname(_cu_os.path.abspath(sys.argv[1]))
              if len(sys.argv) > 1 else _cu_os.getcwd())
    _cu_pol = _cu_os.path.join(_cu_guard_dir, "cu-guard.policy.json")
    _cu_info = _cu_guard.install_gui_only(
        workdir=_cu_wd, policy_path=(_cu_pol if _cu_os.path.isfile(_cu_pol) else None))
    if not _cu_info.get("guiGuard"):
        raise RuntimeError("guiGuard 未生效")
except Exception as _cu_e:  # noqa: BLE001
    sys.stderr.write("[cu-guard] cu-act 护栏装载失败，拒绝执行: %r\n" % (_cu_e,))
    print(json.dumps({"ok": False, "action": "guard",
                      "error": "输入目标护栏装载失败，已拒绝执行: %r" % (_cu_e,)},
                     ensure_ascii=False))
    sys.exit(3)

# --- 64-bit-safe clipboard (declare restype/argtypes: handles are 64-bit) ---
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
u32.OpenClipboard.argtypes = [wt.HWND]
u32.SetClipboardData.restype = wt.HANDLE
u32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
k32.GlobalAlloc.restype = wt.HGLOBAL
k32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
k32.GlobalLock.restype = wt.LPVOID
k32.GlobalLock.argtypes = [wt.HGLOBAL]
k32.GlobalUnlock.argtypes = [wt.HGLOBAL]
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


def set_clipboard_text(text: str) -> None:
    last_err = None
    for _ in range(10):
        if u32.OpenClipboard(None):
            break
        last_err = ctypes.get_last_error()
        time.sleep(0.1)
    else:
        raise OSError(f"OpenClipboard failed (last_error={last_err})")
    try:
        u32.EmptyClipboard()
        size = (len(text) + 1) * 2
        h = k32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not h:
            raise OSError("GlobalAlloc failed")
        p = k32.GlobalLock(h)
        if not p:
            raise OSError("GlobalLock failed")
        try:
            ctypes.memmove(p, ctypes.create_unicode_buffer(text), size)
        finally:
            k32.GlobalUnlock(h)
        if not u32.SetClipboardData(CF_UNICODETEXT, h):
            raise OSError("SetClipboardData failed")
    finally:
        u32.CloseClipboard()


def find_dsh_windows():
    """Top-level windows whose title is/ends with 'DeepSeek Harness' (the dsh
    desktop app titles itself '<session> — DeepSeek Harness'). Topmost first."""
    results = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, lparam):
        if not u32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(hwnd, buf, 256)
        t = buf.value.strip()
        if t == "DeepSeek Harness" or t.endswith("— DeepSeek Harness") or t.endswith("- DeepSeek Harness"):
            results.append((hwnd, t))
        return True

    u32.EnumWindows(cb, 0)
    return results


def do_action(a: dict) -> dict:
    action = a.get("action", "")

    def verify_at(x, y, what):
        # pyautogui 不检查 SetCursorPos 的返回值;受限令牌下会静默失败。
        # 移动类动作后必须核实鼠标真的到位了。
        px, py = pyautogui.position()
        if abs(px - x) > 2 or abs(py - y) > 2:
            raise OSError(
                f"{what}: 鼠标未到位(请求 ({x},{y}),实际 ({px},{py}))。"
                "输入调用被系统拒绝——当前 python 可能受限,换 pythonPath 到有输入权限的解释器。")

    if action == "focus_dsh":
        wins = find_dsh_windows()
        if not wins:
            raise OSError("没找到 dsh 主窗口(标题以 'DeepSeek Harness' 结尾);窗口可能已关闭")
        hwnd, title = wins[0]  # Z 序最上面的那个
        u32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
        u32.ShowWindow.restype = wt.BOOL
        u32.ShowWindow(hwnd, 9)  # SW_RESTORE:从最小化恢复(已在前台时无副作用)
        u32.SetForegroundWindow.restype = wt.BOOL
        u32.SetForegroundWindow.argtypes = [wt.HWND]
        u32.SetForegroundWindow(hwnd)
        if u32.GetForegroundWindow() != hwnd:
            # Windows 前台锁:后台进程直接切会被拒。发一个 Alt 键让系统认为有用户输入,再试。
            u32.keybd_event(0x12, 0, 0, 0)   # VK_MENU down
            u32.SetForegroundWindow(hwnd)
            u32.keybd_event(0x12, 0, 2, 0)   # VK_MENU up (KEYEVENTF_KEYUP)
        if u32.GetForegroundWindow() != hwnd:
            # 仍被拒:最小化再恢复 —— restore 必然置顶并接管前台。
            u32.ShowWindow(hwnd, 6)          # SW_MINIMIZE
            u32.ShowWindow(hwnd, 9)          # SW_RESTORE
        if u32.GetForegroundWindow() != hwnd:
            raise OSError(f"切前台失败(三招都被系统拒绝);目标窗口: {title}")
        return {"detail": f"dsh 主界面已带回前台: {title}"}
    if action == "click":
        pyautogui.click(x=a.get("x"), y=a.get("y"), clicks=int(a.get("clicks") or 1))
        verify_at(a.get("x"), a.get("y"), "click")
        return {"detail": f"click ({a.get('x')},{a.get('y')})"}
    if action == "double_click":
        pyautogui.click(x=a.get("x"), y=a.get("y"), clicks=2)
        verify_at(a.get("x"), a.get("y"), "double_click")
        return {"detail": f"double_click ({a.get('x')},{a.get('y')})"}
    if action == "right_click":
        pyautogui.click(x=a.get("x"), y=a.get("y"), button="right")
        verify_at(a.get("x"), a.get("y"), "right_click")
        return {"detail": f"right_click ({a.get('x')},{a.get('y')})"}
    if action == "type":
        text = a.get("text") or ""
        if not text:
            raise ValueError("type: text is empty")
        if text.isascii():
            pyautogui.write(text, interval=0.012)
            return {"detail": f"type {len(text)} ascii chars"}
        set_clipboard_text(text)
        time.sleep(0.15)
        pyautogui.hotkey("ctrl", "v")
        return {"detail": f"paste {len(text)} chars (clipboard was overwritten)"}
    if action == "key":
        key = a.get("key") or ""
        if not key:
            raise ValueError("key: key name is empty")
        parts = [k.strip().lower() for k in key.split("+") if k.strip()]
        if len(parts) == 1:
            pyautogui.press(parts[0])
        else:
            pyautogui.hotkey(*parts)
        return {"detail": f"key {key}"}
    if action == "scroll":
        amount = int(a.get("amount") or 5)
        if a.get("direction") == "down":
            amount = -amount
        pyautogui.scroll(amount)
        return {"detail": f"scroll {amount}"}
    if action == "move":
        pyautogui.moveTo(a.get("x"), a.get("y"), duration=0.05)
        verify_at(a.get("x"), a.get("y"), "move")
        return {"detail": f"move ({a.get('x')},{a.get('y')})"}
    if action == "drag":
        pyautogui.moveTo(a.get("x"), a.get("y"), duration=0.05)
        verify_at(a.get("x"), a.get("y"), "drag")
        pyautogui.dragTo(a.get("x2"), a.get("y2"), duration=0.4, button="left")
        return {"detail": f"drag ({a.get('x')},{a.get('y')}) -> ({a.get('x2')},{a.get('y2')})"}
    raise ValueError(f"unknown action: {action}")


def run_batch(req: dict) -> dict:
    """单进程跑一整批动作。

    ★ 为什么必须这样（已核实成立）：
      原来 index.js 是**每条动作起一个 Python 进程** —— 20 条 = 20 次冷启动
      （每次还要 import pyautogui + 加载上千行护栏模块 + 写一条审计），估 10~20s；
      而且**批级没有总超时**。改成单进程后：一次冷启动跑完；
      护栏的修饰键状态在批内**天然连续**（不会被进程边界切断）；
      前面那条"修饰键残留窗口"也从"跨进程"缩小到"批内"。

    语义（与 JS 侧校验一致）：**整批先在 JS 侧全部校验**，任一条不合法整批拒绝；
    执行阶段按 stop_on_error 决定"遇错即停"还是"继续跑完"。
    """
    actions = req.get("actions") or []
    stop_on_error = bool(req.get("stop_on_error", True))
    results = []
    attempted = 0
    stopped_why = None
    for i, a in enumerate(actions):
        attempted += 1
        try:
            detail = do_action(a)
            results.append({"i": i, "action": a.get("action"), "ok": True, **detail})
        except pyautogui.FailSafeException:
            # 急停：不管 stop_on_error 是什么，立刻停 —— 这是用户把鼠标甩到 (0,0) 的意思
            results.append({"i": i, "action": a.get("action"), "ok": False,
                            "error": "FAILSAFE triggered: mouse at screen corner (0,0) - aborted"})
            stopped_why = "FAILSAFE 急停"
            break
        except Exception as e:  # noqa: BLE001 - 报给模型，绝不崩
            results.append({"i": i, "action": a.get("action"), "ok": False,
                            "error": f"{type(e).__name__}: {e}"})
            if stop_on_error:
                stopped_why = "前序失败且 stop_on_error"
                break
    out = {
        "ok": all(r.get("ok") for r in results) and attempted == len(actions),
        "batch": True,
        "n": len(actions),
        "executed": attempted,
        "results": results,
    }
    if stopped_why is not None and attempted < len(actions):
        out["stoppedAt"] = attempted
        out["stoppedWhy"] = stopped_why
    return out


def main() -> int:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        a = json.load(f)
    if isinstance(a.get("actions"), list):
        out = run_batch(a)
    else:
        out = {"ok": False}
        try:
            detail = do_action(a)
            out.update(ok=True, action=a.get("action"), **detail)
        except pyautogui.FailSafeException:
            out.update(error="FAILSAFE triggered: mouse at screen corner (0,0) - aborted")
        except Exception as e:  # noqa: BLE001 - report to the model, never crash
            out.update(error=f"{type(e).__name__}: {e}")
    px, py = pyautogui.position()
    out["screen"] = {"width": pyautogui.size().width, "height": pyautogui.size().height}
    out["mouse"] = {"x": px, "y": py}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
