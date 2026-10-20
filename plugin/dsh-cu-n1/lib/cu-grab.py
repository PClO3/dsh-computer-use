# cu-grab.py - capture the primary screen with PIL (faster cold path than the
# GDI+ capture in cu-shot.ps1) and, for som:true, draw numbered SoM badges
# directly on the grab. The UIA element list itself is produced by a concurrent
# `cu-shot.ps1 -NoCapture -ElementsPath ...` run; this script polls for that
# file so the two processes overlap instead of running back to back.
# Usage:
#   python cu-grab.py <out.png>
#   python cu-grab.py <out.png> <elements.json> <annotated.png>
#   python cu-grab.py <out.png> <elements.json> <annotated.png> <maxWidth>
# Prints one JSON line (UTF-8):
#   {"ok":true,"width":W,"height":H,"path":P,"badges":N,"somWaitMs":M,"somTimeout":bool,
#    "screenWidth":SW,"screenHeight":SH,"scale":S,"downsampled":bool}
#
# 降采样（第 4 个参数 maxWidth）：为什么必须在**这里**降，而不是交给下游 ——
#   实测：harness 会把图投到"刚好用满 provider 单图
#   token 上限"的尺寸（DeepSeek 侧为 1024 token），**不主动降就一定吃满上限**。
#   全屏原图（16:10 屏）→ 约 962 视觉 token；先降到 1024 宽（1024x640）→ 418 token（-57%）；
#   降到默认的 1280 宽（1280x800）→ 642 token（-33%）。
#   ⚠️ 这些数字按**16:10 屏**算；换宽高比要重算（早期文档里的 340/-65% 是按 2:1 算的，已更正）。
#   徽章先画后缩：缩完徽章会变小，所以徽章尺寸按缩放比反向放大，保证可读。
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


def draw_badges(img, elements, scale=1.0) -> int:
    """在元素中心画编号徽章。scale<1（要降采样）时把徽章放大 1/scale，
    这样缩完之后的徽章仍约等于原始像素大小，编号不会糊掉。"""
    draw = ImageDraw.Draw(img)
    grow = max(1.0, 1.0 / scale) if scale < 1.0 else 1.0
    r = int(round(10 * grow))
    try:
        font = ImageFont.load_default(size=max(14, int(round(14 * grow))))
    except TypeError:
        font = ImageFont.load_default()
    n = 0
    for el in elements:
        x, y, i = int(el["x"]), int(el["y"]), int(el["i"])
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
    max_width = 0
    if len(sys.argv) > 4 and str(sys.argv[4]).strip():
        try:
            max_width = int(float(sys.argv[4]))
        except ValueError:
            max_width = 0
    if max_width < 0:
        max_width = 0

    t0 = time.perf_counter()
    img = ImageGrab.grab()
    width, height = img.size
    # 目标宽度：0 = 不降采样；只在"原图更宽"时才缩（绝不放大）。
    target_w = max_width if (max_width and width > max_width) else width
    scale = target_w / float(width)
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
                badges = draw_badges(img, elements, scale=scale)
                final_path = annotated_path
            except Exception:  # badge failure: ship the plain grab instead
                badges = 0
                final_path = out_path

    downsampled = False
    if target_w != width:
        target_h = max(1, int(round(height * scale)))
        img = img.resize((target_w, target_h), Image.LANCZOS)
        downsampled = True

    img.save(final_path, "PNG")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({
        "ok": True, "width": img.size[0], "height": img.size[1], "path": final_path,
        "badges": badges, "somWaitMs": som_wait_ms, "somTimeout": som_timeout,
        "screenWidth": width, "screenHeight": height,
        "scale": round(scale, 6), "downsampled": downsampled,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
