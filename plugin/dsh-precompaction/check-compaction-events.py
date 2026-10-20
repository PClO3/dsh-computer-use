#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-compaction-events.py —— 机械核对「压缩事件」是否真的发生（dsh-precompaction 的功能判据）

为什么要用它：会话日志里 `<compacted-summary>` 这个**子串**不能当压缩次数用
（一份检查点里会出现多次、历史重放还会再出现一次）。**必须按事件类型数。**

用法（Python 3.14，用标准库 compression.zstd，无需第三方包）：
    python check-compaction-events.py --latest                 # 只看最新改动的那个会话
    python check-compaction-events.py --since 2026-10-18       # 看该日期之后改动过的所有会话
    python check-compaction-events.py --session <会话目录>      # 指定会话目录
    python check-compaction-events.py --latest --json          # 额外输出机器可读的一行

判据（脚本自己给结论）：
    · 出现 compaction/start → compaction/summary → compaction/end 三连，且 start 在 end 之前
    · 报告每次压缩的 shadowedTokenCount（被折叠的 token 数）与摘要字符数
    · 官方 dsh-compaction-basic 的触发线 = 模型上下文 − 预留（随模型/配置变化；
      脚本里给的是**通用示例值**，请按自己的模型改，或用环境变量 DSH_COMPACTION_LINE 覆盖）
      ⇒ 短会话里出现压缩 = 一定是 precompaction 干的（它的钩子确实响了）
"""
import argparse
import datetime
import json
import os
import pathlib
import sys

try:
    from compression import zstd
except ImportError:
    sys.exit("需要 Python 3.14+（compression.zstd）。Windows 上若用 Python Install Manager，通常是 %LOCALAPPDATA%\\Python\\bin\\python.exe")

DSH = pathlib.Path(os.environ.get("DSH_HOME") or (pathlib.Path.home() / ".dsh"))
SESSIONS = DSH / "sessions"
OFFICIAL_LINE = int(os.environ.get("DSH_COMPACTION_LINE", 1_000_000))  # 参考值，非官方常量


def decompress(path: pathlib.Path) -> bytes:
    return zstd.decompress(path.read_bytes())


def analyse(path: pathlib.Path):
    raw = decompress(path)
    events = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        t = obj.get("type")
        if isinstance(t, str) and t.startswith("compaction/"):
            events.append((obj.get("seq"), t, obj.get("data") or {}))
    return raw, events


def report(path: pathlib.Path) -> dict:
    raw, events = analyse(path)
    starts = [e for e in events if e[1] == "compaction/start"]
    summaries = [e for e in events if e[1] == "compaction/summary"]
    ends = [e for e in events if e[1] == "compaction/end"]
    print(f"\n会话: {path.parent.name}")
    print(f"  日志 {len(raw):,} 字节 ｜ compaction/start={len(starts)} summary={len(summaries)} end={len(ends)}")
    triples = 0
    for s, sm, e in zip(starts, summaries, ends):
        ok_order = s[0] < sm[0] < e[0]
        shadowed = sm[2].get("shadowedTokenCount") or sm[2].get("shadowedRouteTokenCount")
        summary_text = ""
        for key in ("summary", "text", "framedSummary"):
            v = sm[2].get(key)
            if isinstance(v, str) and v:
                summary_text = v
                break
        err = e[2].get("error")
        triples += 1 if ok_order and not err else 0
        print(f"    #{triples if ok_order and not err else '-'} seq {s[0]}→{sm[0]}→{e[0]}"
              f" ｜ 顺序{'正确' if ok_order else '★错误'}"
              f" ｜ 折叠 {shadowed if shadowed is not None else '未记录'} token"
              f" ｜ 摘要 {len(summary_text)} 字符"
              f"{' ｜ ★带 error: ' + str(err) if err else ''}")
    return {
        "session": path.parent.name,
        "start": len(starts), "summary": len(summaries), "end": len(ends),
        "well_formed": triples,
        "path": str(path),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", help="会话目录（含 session.v4.jsonl.zstd）")
    ap.add_argument("--since", help="YYYY-MM-DD：只看该日期之后改动过的会话")
    ap.add_argument("--latest", action="store_true", help="只看最新改动的那一个会话")
    ap.add_argument("--json", action="store_true", help="额外输出机器可读汇总")
    a = ap.parse_args()

    if a.session:
        files = [pathlib.Path(a.session) / "session.v4.jsonl.zstd"]
    else:
        files = sorted(SESSIONS.rglob("session.v4.jsonl.zstd"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        if a.since:
            cutoff = datetime.datetime.fromisoformat(a.since)
            files = [f for f in files if datetime.datetime.fromtimestamp(f.stat().st_mtime) >= cutoff]
        elif a.latest:
            files = files[:1]
    files = [f for f in files if f.exists()]
    if not files:
        sys.exit("没有找到会话日志（检查 --session/--since 的取值）")

    print(f"扫描 {len(files)} 个会话日志；参考压缩线 = {OFFICIAL_LINE:,} token（见文件头，随模型/配置变化）")
    out = []
    for f in files:
        try:
            out.append(report(f))
        except Exception as exc:
            print(f"\n会话 {f.parent.name}: 解压/解析失败 —— {exc}")

    total = sum(o["well_formed"] for o in out)
    print("\n" + "═" * 70)
    print(f"合计：结构完整的三连 {total} 次 ｜ 涉及 {len([o for o in out if o['start']])} 个会话")
    if total:
        print(f"判定：**压缩确实发生了**。若这些会话的上下文远低于 {OFFICIAL_LINE:,}，则执行者是 dsh-precompaction"
              f"（官方线在 {OFFICIAL_LINE:,}，不可能在短会话里触发）。")
    else:
        print("判定：**本次扫描没有看到任何压缩事件** —— 不要据此说「插件没生效」，"
              "先确认：(a) 触发点是否真的压到很低；(b) 会话上下文是否真超过了触发点；"
              "(c) 是否重启过（配置是开机读取的）。")
    print("═" * 70)
    if a.json:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
