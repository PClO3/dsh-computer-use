# cu-grab.py - capture the primary screen with PIL (faster cold path than the
# GDI+ capture in cu-shot.ps1) and, for som:true, draw numbered SoM badges
# directly on the grab. The UIA element list itself is produced by a concurrent
# `cu-shot.ps1 -NoCapture -ElementsPath ...` run; this script polls for that
# file so the two processes overlap instead of running back to back.
# Usage:
#   python cu-grab.py <out.png>
#   python cu-grab.py <out.png> <elements.json> <annotated.png>
# Prints one JSON line (UTF-8):
#   {"ok":true,"width":W,"height":H,"path":P,"badges":N,"somWaitMs":M,"somTimeout":bool}
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

# DPI awareness BEFORE PIL so the grab is full physical resolution.
u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.SetProcessDPIAware.restype = wt.BOOL
u32.SetProcessDPIAware()

from PIL import Image, ImageDraw, ImageFont, ImageGrab  # noqa: E402

SOM_WAIT_MS = 12000    # bail out to a plain shot if UIA takes longer than this
PARSE_GRACE_MS = 1500  # elements file may be mid-write; retry briefly


def draw_badges(img, elements) -> int:
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=14)
    except TypeError:
        font = ImageFont.load_default()
    n = 0
    for el in elements:
        x, y, i = int(el["x"]), int(el["y"]), int(el["i"])
        r = 10
        draw.ellipse([x - r - 1, y - r - 1, x + r + 1, y + r + 1], fill=(255, 255, 255))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(210, 35, 35))
        label = str(i)
        box = draw.textbbox((0, 0), label, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        draw.text((x - tw / 2 - box[0], y - th / 2 - box[1]), label,
                  fill=(255, 255, 255), font=font)
        n += 1
    return n


def read_json(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def wait_for_elements(elements_path: str, t0: float):
    """Poll for the UIA output file. Returns (data, timed_out)."""
    deadline = t0 + SOM_WAIT_MS / 1000
    while time.perf_counter() < deadline:
        try:
            return read_json(elements_path), False
        except FileNotFoundError:
            time.sleep(0.025)
        except json.JSONDecodeError:
            # mid-write: grant a short grace window, then give up on this file
            grace_end = time.perf_counter() + PARSE_GRACE_MS / 1000
            while time.perf_counter() < grace_end:
                time.sleep(0.05)
                try:
                    return read_json(elements_path), False
                except (FileNotFoundError, json.JSONDecodeError):
                    continue
            return None, False
    return None, True


def main() -> int:
    out_path = sys.argv[1]
    elements_path = sys.argv[2] if len(sys.argv) > 2 else ""
    annotated_path = sys.argv[3] if len(sys.argv) > 3 else ""

    t0 = time.perf_counter()
    img = ImageGrab.grab()
    width, height = img.size
    final_path = out_path
    badges = 0
    som_wait_ms = 0
    som_timeout = False

    if elements_path:
        data, timed_out = wait_for_elements(elements_path, t0)
        som_wait_ms = int((time.perf_counter() - t0) * 1000)
        som_timeout = timed_out
        elements = (data or {}).get("elements", []) if data else []
        if elements:
            try:
                badges = draw_badges(img, elements)
                final_path = annotated_path
            except Exception:  # badge failure: ship the plain grab instead
                badges = 0
                final_path = out_path

    img.save(final_path, "PNG")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({
        "ok": True, "width": width, "height": height, "path": final_path,
        "badges": badges, "somWaitMs": som_wait_ms, "somTimeout": som_timeout,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
