# cu-advisor.py — 副模型(异步顾问)单文件实现。
#
# 职责:在主模型**等待界面就绪**的死时间(现在由 cu_wait 的 timeout_ms 表达)时，基于
#   「用户任务 + 即将等待什么 + 上一个动作 + 最近截图文本 + som 元素清单 + 上次动作结果」
# 预判"接下来可能出什么问题、出现了怎么办"，产出 ≤3 条 IF-THEN + 可选核对点 + 可选 END 收尾提醒。
#
# ⚠️ 点火点挂在「cu_wait 的 timeout_ms/1000」上——
#    （跑任意代码的 cu_run_code 通道已整个删除）。本文件的 SYSTEM_PROMPT 与 replay() 与之对应，
#    否则提示词描述的输入与实际发的对不上，预判质量会受损。
# 它没有手脚:不碰键鼠、不写文件、只是调用 LLM。主模型是唯一拍板人。
#
# 用法:
#   python cu-advisor.py ask <task.json> [out.json]      # 单次预判(live 模式)
#   python cu-advisor.py replay <session.jsonl> <out.jsonl> [--limit N] [--model M]
#                              # 离线回放:对历史会话逐段预判，并附当时的真实结局供评分
#
# 凭证:读 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY(绝不打印)。
# 模型/网关:默认 https://api.deepseek.com + deepseek-chat，可用同目录 advisor.local.json 覆盖。
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

CRED = Path.home() / ".dsh" / ".credentials.yaml"
LOCAL_CFG = Path(__file__).parent / "advisor.local.json"
DEFAULT_BASE = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-chat"
MIN_SLEEP = 1.5          # 预判触发门限(秒):cu_wait 的 timeout_ms/1000(即"打算等多久")

SYSTEM_PROMPT = """你是电脑操作系统的「副模型」:主模型正在用鼠标键盘操作 Windows,你只在它等待的间隙做预判。你没有工具,不能执行任何操作,唯一产出是文字。

你的输入:用户的任务、主模型**即将等待什么**(例如"出现标题含「导出完成」的窗口",或"像素 (x,y) 变成 #RRGGBB")、它**上一个动作及其结果**、最近的屏幕信息。
你的任务:预判**这次等待结束之后**「接下来最可能出什么问题」,以及万一出现了该怎么应对。
注意:你看不到"正在执行的代码"了(跑任意代码的通道已整个删除)。别要求看代码,也别假设有代码。

格式(严格遵守,总量尽量短):
- 一切正常就只输出一行: SKIP
- 否则输出 1~3 条风险,按严重度排序,每条一行,编号 R1/R2/R3 各至多一条:
  R1 IF <执行后会看到的具体信号> THEN <具体应对动作>
- 可选一行核对点: CHECK <主模型下一步应该核对什么值>
- 可选一行计划风险: PLAN-RISK <当前计划哪一步可能走不通+为什么>(只给警告和理由,不许给替代计划)

- 可选收尾提醒:主模型的硬规矩是每轮向用户汇报前都会先调用 cu_act(action="focus_dsh") 把 dsh 窗口调回前台。若你判断主模型**这次等待结束后**大概率收尾汇报(拿不准也算),把输出的第 1 行换成:
  END 汇报前先 cu_act(action="focus_dsh") 把 dsh 窗口调回前台
  (风险行 R1~R3 从第 2 行起照旧;没有风险就只输出这一行,不输出 SKIP。)
红线:不准提新计划;不准评价主模型的策略;不准输出与操作无关的内容。
{budget_note}"""


def load_key() -> str:
    import yaml
    d = yaml.safe_load(CRED.read_text(encoding="utf-8"))
    key = (d.get("refs") or {}).get("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError(".credentials.yaml 里没有 refs.DEEPSEEK_API_KEY")
    return key


def load_cfg() -> dict:
    if LOCAL_CFG.exists():
        return json.loads(LOCAL_CFG.read_text(encoding="utf-8"))
    return {}


def ask(user_prompt: str, budget: int, cfg: dict, key: str) -> dict:
    """一次预判调用。返回 {prediction, latencyMs, usage, finishReason}。"""
    base = cfg.get("baseUrl", DEFAULT_BASE).rstrip("/")
    model = cfg.get("model", DEFAULT_MODEL)
    budget_note = f"你的输出预算:不超过 {budget} token,超出会被硬截断,把最重要的放前面。"
    sys_prompt = SYSTEM_PROMPT.replace("{budget_note}", budget_note)
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_prompt}],
        "max_tokens": budget,
        "temperature": 0.2,
        # deepseek-flash 默认带思维链，会把小预算烧在 reasoning 上(content 变空，实测)。
        # 副模型要的是即时预判，默认关思考;要开就在 advisor.local.json 里 "thinking": "enabled"。
        "thinking": {"type": cfg.get("thinking", "disabled")},
    }).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=body, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key})
    t0 = time.perf_counter()
    last_err = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            choice = data["choices"][0]
            return {
                "prediction": (choice.get("message") or {}).get("content", "").strip(),
                "finishReason": choice.get("finish_reason"),
                "latencyMs": int((time.perf_counter() - t0) * 1000),
                "usage": data.get("usage") or {},
                "model": model,
            }
        except Exception as e:
            last_err = e
            time.sleep(1.0)
    return {"prediction": "ADVISOR-ERROR: " + str(last_err), "latencyMs": int((time.perf_counter() - t0) * 1000), "error": True}


def sleep_total(code: str) -> float:
    return sum(float(m.group(1)) for m in re.finditer(r"time\.sleep\(\s*([\d.]+)\s*\)", code))


def render_text(d: dict) -> str:
    msg = d.get("message") or {}
    parts = []
    for c in (msg.get("content") or []):
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(c.get("text", ""))
    return "\n".join(parts)


def is_ok(text: str):
    """从渲染文本判断成功/失败;空文本 = 未知。"""
    if not text:
        return None
    return not re.search(r"FAILED|ADVISOR-ERROR", text[:80], re.I)


def replay(session_path: str, out_path: str, limit: int = 0, model: str = None):
    """两遍索引法:先建 callId -> 调用/结果 的索引,再顺序扫描,杜绝配对错误。"""
    cfg = load_cfg()
    if model:
        cfg["model"] = model
    key = load_key()
    recs = []
    with open(session_path, encoding="utf-8") as f:
        for line in f:
            try:
                recs.append(json.loads(line))
            except Exception:
                pass

    order = []            # (kind, ts, cid)
    call_by_id = {}       # cid -> (name, args_text)
    result_by_id = {}     # cid -> (text, ok)
    user_texts = []       # (ts, text)
    for r in recs:
        t, d = r.get("type"), r.get("data") or {}
        ts = r.get("time")
        if t == "tool/call":
            cid = d.get("callId")
            order.append(("call", ts, cid))
            call_by_id[cid] = (d.get("name"), d.get("arguments") or "")
        elif t == "tool/result":
            cid = (d.get("message") or {}).get("toolCallId")
            text = render_text(d)
            order.append(("result", ts, cid))
            result_by_id[cid] = (text, is_ok(text))
        elif t == "user/message":
            txt = render_text(d)
            if txt.strip():
                user_texts.append((ts, txt[:400]))
        elif t == "agent/inbox/spliced":
            for ins in (d.get("inserted") or []):
                if (ins.get("source") or {}).get("kind") == "user":
                    txt = render_text(ins)
                    if txt.strip():
                        user_texts.append((ts, txt[:400]))

    results = []
    last_shot_text = ""
    last_result_text = ""
    last_ok = None
    for pos, (kind, ts, cid) in enumerate(order):
        if kind == "result":
            text, ok = result_by_id.get(cid, ("", None))
            last_result_text = text[:200]
            last_ok = ok if ok is not None else last_ok
            m = re.search(r"<som_elements[\s\S]*?</som_elements>", text)
            last_shot_text = (m.group(0) if m else text)[:600]
            continue
        name, args_text = call_by_id[cid]
        # ── 点火锚点有两个────────────────────────────────
        #  · cu_wait      —— 现在的点火点：timeout_ms/1000 >= MIN_SLEEP。
        #                    新会话走这条。
        #  · cu_run_code  —— **历史会话专用**。该工具已整个删除，
        #                    但 replay 的职责是「对**历史**会话逐段预判、附当时真实结局供评分」，
        #                    审计的历史记录里还有这类调用 ⇒ 保留它才能继续用真实数据
        #                    评估副模型质量、调阈值与预算。新会话里它自然零样本。
        if name == "cu_wait":
            try:
                _a = json.loads(args_text)
            except Exception:
                continue
            st = float(_a.get("timeout_ms") or 0) / 1000.0
            code = ""            # 没有代码了
            wait_desc = "【即将等待】" + str(_a.get("condition") or "?") + " " + json.dumps(
                {k: v for k, v in _a.items() if k in ("x", "y", "expect", "title_contains", "path", "exists")},
                ensure_ascii=False)
        elif name == "cu_run_code":
            try:
                code = json.loads(args_text).get("code", "")
            except Exception:
                continue
            st = sleep_total(code)
            wait_desc = "【（历史）代码里的等待总量】"
        else:
            continue
        if st < MIN_SLEEP:
            continue
        # 下一个工具调用及其结果 = 这段代码执行后的"真实走向"
        next_call_cid = next((c2 for k2, _, c2 in order[pos + 1:] if k2 == "call"), None)
        next_outcome, next_ok = "", None
        next_clicks = None
        if next_call_cid:
            ntext, next_ok = result_by_id.get(next_call_cid, ("", None))
            next_outcome = ntext[:400]
            if call_by_id.get(next_call_cid, ("?",))[0] == "cu_run_code":
                try:
                    next_clicks = len(re.findall(r"pyautogui\.click", json.loads(call_by_id[next_call_cid][1]).get("code", "")))
                except Exception:
                    next_clicks = None
        plan_lines = [ln.strip() for ln in code.split("\n") if ln.strip().startswith("#")][:2]
        task = user_texts[-1][1] if user_texts else "(未知)"
        budget = max(50, min(200, int((st - 1.0) * 250)))
        # 提示词的键与 index.js 的 fireAdvisor() **必须一致**（否则提示词与实发对不上）。
        user_prompt = (
            "【用户任务】" + task + "\n"
            + wait_desc + "\n"
            + "【等待总量】" + f"{st:.1f}" + " 秒\n"
            + "【上一个动作】" + (" / ".join(plan_lines) if plan_lines else "(未记录)") + "\n"
            + "【上一个动作的结果】" + ("成功" if last_ok else ("失败" if last_ok is False else "未知")) + ": " + last_result_text[:200] + "\n"
            + "【最近一次截图的画面信息】\n" + (last_shot_text[:500] or "(无)")
        )
        resp = ask(user_prompt, budget, cfg, key)
        results.append({
            "ts": ts,
            "waitSec": round(st, 2),       # 等待秒数（cu_wait 的 timeout_ms/1000）
            "budget": budget,
            "planLines": plan_lines,
            "prediction": resp.get("prediction", ""),
            "latencyMs": resp.get("latencyMs"),
            "finishReason": resp.get("finishReason"),
            "ownOk": result_by_id.get(cid, ("", None))[1],
            "nextOk": next_ok,
            "nextOutcome": next_outcome,
            "nextRunCodeClicks": next_clicks,
        })
        if limit and len(results) >= limit:
            break

    with open(out_path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("replay 完成: " + str(len(results)) + " 段预判 → " + out_path)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 1
    if argv[0] == "ask":
        payload = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        cfg = load_cfg()
        key = load_key()
        out = ask(payload["prompt"], int(payload.get("budget", 200)), cfg, key)
        text = json.dumps(out, ensure_ascii=False, indent=1)
        if len(argv) > 2:
            Path(argv[2]).write_text(text, encoding="utf-8")
        else:
            print(text)
        return 0
    if argv[0] == "replay":
        limit = 0
        model = None
        if "--limit" in argv:
            limit = int(argv[argv.index("--limit") + 1])
        if "--model" in argv:
            model = argv[argv.index("--model") + 1]
        replay(argv[1], argv[2], limit, model)
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
