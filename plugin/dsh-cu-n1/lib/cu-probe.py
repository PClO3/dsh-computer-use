# -*- coding: utf-8 -*-
"""cu-probe.py — cu_probe / cu_wait 的共用后端（只读，永不改变系统状态）。

为什么两个工具共用一个后端：
  cu_wait 需要**轮询**（每 100~250ms 查一次条件）。如果让 JS 侧循环调用、
  每次起一个新进程，一次 8 秒的等待要起 30~40 个 Python —— 太贵。
  所以把轮询放进本进程内部：**一次进程，内部循环**。

用法（与 cu-act.py 同风格）：
    python cu-probe.py <请求.json>
请求 JSON：
    {"mode":"probe", "kind":"windows"|"processes"|"screen"|"pixel"|"file_tail"|"dir", ...}
    {"mode":"wait",  "condition":"pixel"|"window"|"file", "timeout_ms":8000, ...}
输出：最后一行一个 JSON 对象（前面可有日志行）。

只读保证：本文件不调用任何写接口 —— 不含 WriteFile / CreateFile / RegSet* /
SetCursorPos / mouse_event / keybd_event / TerminateProcess / CreateProcess。
（文件系统只读：open(...,'r')、os.scandir、os.path.*）
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time

u32 = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

# ══════════════════════════════════════════════════════════════════════════
# ★ 必须先设 DPI 感知 —— 否则本进程报的是**逻辑像素**，而 cu_act 吃的是
#   **物理像素**，两边对不上，模型照 probe 的坐标去点就会**全部点偏**。
#
#   实测（在缩放比大于 100% 的屏幕上，两组读数会相差一个缩放系数）：
#     不设 DPI 感知 → GetSystemMetrics 返回**逻辑像素**（被缩放比除过）
#     cu-act.py（设了）→ 返回**物理像素**（真实分辨率）
#   原插件的 RUN_PRELUDE 里本来就有 SetProcessDPIAware()，这个新后端最初漏了，
#   是靠"和 cu-act.py 对账"才发现的 —— 单看自己测通过是发现不了的。
# ══════════════════════════════════════════════════════════════════════════
try:
    u32.SetProcessDPIAware.restype = wt.BOOL
    DPI_AWARE = bool(u32.SetProcessDPIAware())
except BaseException:
    DPI_AWARE = False

# ── 窗口枚举 ────────────────────────────────────────────────────────────────
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
u32.EnumWindows.argtypes = [WNDENUMPROC, wt.LPARAM]
u32.GetWindowTextLengthW.argtypes = [wt.HWND]
u32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
u32.GetForegroundWindow.restype = wt.HWND
u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u32.GetWindowThreadProcessId.restype = wt.DWORD

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.OpenProcess.restype = wt.HANDLE
k32.CloseHandle.argtypes = [wt.HANDLE]
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]


def _exe_of(pid):
    """pid -> exe 全路径。打不开就返回 None（受限令牌下常见，属正常）。"""
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        k32.CloseHandle(h)


def _windows(visible_only=True):
    out = []
    fg = u32.GetForegroundWindow()

    def cb(hwnd, _lparam):
        try:
            if visible_only and not u32.IsWindowVisible(hwnd):
                return True
            n = u32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            tbuf = ctypes.create_unicode_buffer(n + 1)
            u32.GetWindowTextW(hwnd, tbuf, n + 1)
            title = tbuf.value
            if not title.strip():
                return True
            cbuf = ctypes.create_unicode_buffer(256)
            u32.GetClassNameW(hwnd, cbuf, 256)
            pid = wt.DWORD(0)
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            r = wt.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(r))
            exe = _exe_of(pid.value)
            out.append({
                "title": title,
                "class": cbuf.value,
                "pid": pid.value,
                "exe": os.path.basename(exe) if exe else None,
                "rect": {"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top},
                "is_foreground": bool(hwnd == fg),
            })
        except BaseException:
            pass
        return True

    u32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


# ── 进程枚举（Toolhelp32：不需要 OpenProcess 权限，受限令牌下也能列出同级）──
TH32CS_SNAPPROCESS = 0x00000002
MAX_PATH = 260


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
                ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * MAX_PATH)]


k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]


def _processes(name_filter=None):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == wt.HANDLE(-1).value or not snap:
        return []
    out = []
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            nm = e.szExeFile
            if name_filter is None or nm.lower() == str(name_filter).lower():
                out.append({"name": nm, "pid": e.th32ProcessID, "ppid": e.th32ParentProcessID})
            e.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return out


# ── 屏幕 / 像素 ────────────────────────────────────────────────────────────
u32.GetSystemMetrics.argtypes = [ctypes.c_int]
u32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]


def _screen():
    p = wt.POINT()
    u32.GetCursorPos(ctypes.byref(p))
    return {"width": u32.GetSystemMetrics(0), "height": u32.GetSystemMetrics(1),
            "cursor": {"x": p.x, "y": p.y},
            "dpiAware": DPI_AWARE,
            "note": ("坐标都是物理像素，与 cu_act 一致。" if DPI_AWARE
                     else "⚠️ DPI 感知设置失败，本进程可能报逻辑像素，与 cu_act 的物理像素不一致——先别按这里的坐标去点。")}


def _grab():
    """懒加载 PIL —— 只在真要读像素/截图时才 import。"""
    from PIL import ImageGrab
    return ImageGrab


def _pixel(x, y):
    im = _grab().grab(bbox=(int(x), int(y), int(x) + 1, int(y) + 1))
    r, g, b = im.convert("RGB").getpixel((0, 0))
    return {"x": int(x), "y": int(y), "r": r, "g": g, "b": b,
            "hex": "#%02X%02X%02X" % (r, g, b)}


def _check_bounds(x, y):
    """像素坐标必须落在屏幕内 —— 越界时 PIL 返回黑边，会**静默**给出 #000000。"""
    sw, sh = u32.GetSystemMetrics(0), u32.GetSystemMetrics(1)
    if not (0 <= int(x) < sw and 0 <= int(y) < sh):
        raise ValueError("像素坐标越界: (%s,%s) 不在屏幕 %dx%d 内。越界时 PIL 会返回黑边、"
                         "静默给出 #000000，所以这里直接拒绝而不是给你一个假颜色。" % (x, y, sw, sh))


def _hex_to_rgb(s):
    s = str(s).strip().lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _close(a, b, tol):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol and abs(a[2] - b[2]) <= tol


# ── 文件 ───────────────────────────────────────────────────────────────────
def _file_tail(p, lines=50):
    lines = max(1, min(int(lines), 500))
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        buf = f.readlines()
    total = len(buf)
    return {"path": p, "lines": [l.rstrip("\n") for l in buf[-lines:]],
            "total_lines": total, "truncated": total > lines}


def _dir(p, pattern=None):
    import fnmatch
    out = []
    with os.scandir(p) as it:
        for e in it:
            if pattern and not fnmatch.fnmatch(e.name, pattern):
                continue
            try:
                st = e.stat()
                isdir = e.is_dir()
                # ★ 目录的 st_size 不是"里面有多少内容"，给出来容易被误读 ⇒ 目录给 None。
                out.append({"name": e.name, "size": (None if isdir else st.st_size),
                            "mtime": int(st.st_mtime), "is_dir": isdir})
            except BaseException:
                out.append({"name": e.name, "size": None, "mtime": None, "is_dir": e.is_dir()})
    out.sort(key=lambda d: (not d["is_dir"], d["name"].lower()))
    return out


# ── 两种模式 ───────────────────────────────────────────────────────────────
def do_probe(req):
    kind = str(req.get("kind") or "")
    if kind == "windows":
        ws = _windows(visible_only=req.get("visible_only", True))
        if req.get("foreground_only"):
            ws = [w for w in ws if w["is_foreground"]]
        if req.get("title_contains"):
            needle = str(req["title_contains"]).lower()
            ws = [w for w in ws if needle in (w["title"] or "").lower()]
        out = {"ok": True, "kind": kind, "count": len(ws), "windows": ws[:120]}
        if len(ws) > 120:
            out["truncated"] = True
            out["note"] = "只返回前 120 个窗口(共 %d 个)" % len(ws)
        return out
    if kind == "processes":
        ps = _processes(req.get("name"))
        out = {"ok": True, "kind": kind, "count": len(ps), "processes": ps[:300]}
        if len(ps) > 300:
            out["truncated"] = True
        # ★ 防呆（实测教训）：受限令牌（低完整性）下**进程枚举会被系统过滤** ——
        #   实测从低完整性 shell 里查 explorer.exe 得到 count=0，
        #   而 explorer 明显在跑。直接据此下结论，就会报出这样一条假消息
        #   （"explorer 没在运行"）。所以这里必须显式警告，别让模型据此下结论。
        if not ps:
            out["note"] = ("没找到匹配的进程。⚠️ 在受限令牌下进程枚举可能被系统过滤 —— "
                           "**不要据此断定该进程没在运行**。可改用 cu_probe(kind=\"windows\") "
                           "看有没有它的窗口来侧面判断。")
        else:
            out["note"] = "⚠️ 受限令牌下本列表可能不完整，别把「这里没有」当成「它没在跑」。"
        return out
    if kind == "screen":
        return {"ok": True, "kind": kind, **_screen()}
    if kind == "pixel":
        # ★ 原来不查边界 —— PIL 越界 grab 会返回**黑边**，于是静默给出 #000000，
        #   模型会以为"那里真的是黑的"。所以越界直接拒。
        _check_bounds(req["x"], req["y"])
        return {"ok": True, "kind": kind, **_pixel(req["x"], req["y"])}
    if kind == "file_tail":
        return {"ok": True, "kind": kind, **_file_tail(req["path"], req.get("lines", 50))}
    if kind == "dir":
        return {"ok": True, "kind": kind, "path": req["path"],
                "entries": _dir(req["path"], req.get("pattern"))[:400]}
    raise ValueError("cu_probe: 未知 kind=%r（可选 windows/processes/screen/pixel/file_tail/dir）" % kind)


def _cond_met(req):
    """返回 (是否满足, 当前快照)。异常向上抛，由调用方决定是否算失败。"""
    c = str(req.get("condition") or "")
    if c == "pixel":
        _check_bounds(req["x"], req["y"])
        want = _hex_to_rgb(req["expect"])
        tol = int(req.get("tolerance", 16))
        cur = _pixel(req["x"], req["y"])
        return _close((cur["r"], cur["g"], cur["b"]), want, tol), cur
    if c == "window":
        needle = str(req.get("title_contains") or "")
        ws = _windows()
        hit = [w for w in ws if needle.lower() in (w["title"] or "").lower()]
        return len(hit) > 0, {"matched": hit[:5], "window_count": len(ws)}
    if c == "file":
        p = req["path"]
        exists = os.path.exists(p)
        want = req.get("exists", True)
        return (exists == bool(want)), {"path": p, "exists": exists,
                                        "size": (os.path.getsize(p) if exists and os.path.isfile(p) else None)}
    raise ValueError("cu_wait: 未知 condition=%r（可选 pixel/window/file）" % c)


def do_wait(req):
    timeout_ms = int(req.get("timeout_ms", 5000))
    timeout_ms = max(0, min(timeout_ms, 120000))
    interval = int(req.get("interval_ms", 150))
    interval = max(30, min(interval, 2000))
    deadline = time.monotonic() + timeout_ms / 1000.0
    t0 = time.monotonic()
    last = None
    tries = 0
    while True:
        tries += 1
        try:
            met, last = _cond_met(req)
            if met:
                return {"ok": True, "elapsedMs": int((time.monotonic() - t0) * 1000),
                        "tries": tries, "last": last}
        except Exception as e:      # noqa: BLE001 — 单次探测失败不致命，继续轮询
            last = {"error": "%s: %s" % (type(e).__name__, str(e)[:120])}
        if time.monotonic() >= deadline:
            return {"ok": False, "elapsedMs": int((time.monotonic() - t0) * 1000),
                    "tries": tries, "last": last,
                    "error": "等待超时 %dms（条件未满足）" % timeout_ms}
        time.sleep(interval / 1000.0)


def main(argv):
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: cu-probe.py <请求.json>"}, ensure_ascii=False))
        return 2
    with open(argv[1], "r", encoding="utf-8") as f:
        req = json.load(f)
    mode = str(req.get("mode") or "probe")
    try:
        out = do_wait(req) if mode == "wait" else do_probe(req)
    except BaseException as e:  # noqa: BLE001
        out = {"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300])}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
