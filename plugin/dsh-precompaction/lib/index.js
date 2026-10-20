/**
 * dsh-precompaction — 上下文「预压缩」后端 for dsh
 *
 * 目标：在上下文到 `triggerTokens`（默认 40 万）时，**在后台**把旧历史压成摘要；
 * 主循环一秒都不停。摘要算好后，在下一个 `agent/pre-step` 的开头**同步原子替换**。
 *
 * 与官方 `@deepseek-ai/dsh-compaction-basic` 的关系：**并存**。官方那条线
 * （按模型上下文动态计算，见官方 `lib/index.js` L132）原样保留当兜底；本插件是第二条线，
 * 正常情况下永远走不到它。
 *
 * ── 设计要点（都来自官方源码实读，见每条注释里的出处）────────────────────
 *
 * 1. **改模型可见内容的唯一合法通道**是 `session.append(...)` 带
 *    `surfaceOp: { op:'replace', startSeq, endSeq }`。
 *    `agent/request` 只能换调用配置（`dsh-agent/lib/types/runtime-types.d.ts` L318-319
 *    原文：Model-visible content must use logged channels; this waterfall cannot
 *    mutate messages）。
 *
 * 2. **摘要后台算，提交同步写。** 官方在事务里 `await summarize()`
 *    （`dsh-compaction-basic/lib/index.js` L478），这就是阻塞的来源。本插件把它拆开。
 *
 * 3. **`compaction/start` 是锁，且必须早于检查点。**
 *    - `dsh-compaction/lib/types/types.d.ts` L17-19：start「holds the lock until
 *      `compaction/end`」；
 *    - `dsh-compaction/lib/invariant.js` L54-62 `validateCheckpoint`：带
 *      `compact-checkpoint` 的替换消息落地时，**必须已存在 compactionId 相同的
 *      未闭合 `compaction/start`**；
 *    - `dsh-compaction-basic/lib/index.js` L536-548 `assertCompactionInactive`：任何
 *      未闭合的 start 会让官方后端与 `/compact` 报 `busy`。
 *    ⇒ 因此 **start 不能横跨主循环**（否则摘要跑的几十秒里官方兜底与 `/compact` 全被锁死），
 *      也不能排在检查点之后。正确形态是提交时一个**同步四连写、中间不 await**：
 *      start → summary → user/message(replace) → end。
 *
 * 4. **`compaction/summary` 与替换消息必须紧邻**（`types.d.ts` L30-33：
 *    "That adjacency is contractual"），summary 里的 `shadowedRange/shadowedSeqs/
 *    shadowedTokenCount` 就是这次替换的「影子价格」。
 *
 * 5. **工具配对校验用官方导出的函数**，不要手写：
 *    `@deepseek-ai/dsh-compaction` 的公开导出面（`lib/index.js` L175）含
 *    `toolPairingBalancedBefore` / `toolPairingBalancedAfter`。
 *
 * 6. **提交前必须验「这段没被改过」**，不只是「seq 还在表层」。
 *    `compaction/prune`（工具结果修剪）与官方压缩都是**原地 replace 同一个 seq**：
 *    seq 还在，内容变了。所以起 job 时快照
 *    `surface.replaceGeneration` + `contentGeneration` + 每个节点的消息指纹，
 *    提交前逐一比对。
 *
 * 7. **摘要输入照抄官方**（`buildSummarizationInput` L695-704 + `summarizeWithLlm`
 *    L292-338）：系统提示词放第一位、带 `tools` 与 `toolHistory`、压缩指令作为
 *    **最后一条 user 消息**追加——这是官方声称的暖前缀复用方式。`COMPACTION_INSTRUCTION`
 *    是官方冻结模板（L243-278），此处逐字照抄（官方未导出它）。
 *
 * ── 未做的事 / 已知边界 ────────────────────────────────────────────────
 * - 不 fork、不修改任何 `@deepseek-ai/*` 官方包。
 * - 不用 `ctx.subagents.start`（有些环境会用插件包装 subagent：无条件覆盖模型、
 *   吃预算、写审计）。用 `ctx.llm.stream()` —— 与官方压缩同一个机制。
 * - 后台 job **不使用** turn 的 abort signal（它在 turn 结束时会 abort，而我们的 job
 *   需要跨 turn 存活）；只用插件自己的 AbortController，在插件卸载时 abort。
 * - 若压力已到 `dangerTokens`（默认 480,000）仍无 job 在飞，**主动放弃后台路线**，
 *   让官方同步压缩去兜底 —— 因为此时后台压完之前就可能撞上官方线，反而更糟。
 */

import { CompactionId, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { BlockAssembler, contentHasImage, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-precompaction';
export const inject = ['llm', 'tokenMeter'];

// ══════════════════════════════════════════════════════════════════════════
// 官方冻结常量（逐字照抄，来源见每条注释）
// ══════════════════════════════════════════════════════════════════════════

/** `dsh-compaction-basic/lib/index.js` L234-235 */
const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/** `dsh-compaction-basic/lib/index.js` L280 */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. '
  + 'Treat the captured context as established background and build on it without restating it. '
  + 'Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

/**
 * `dsh-compaction-basic/lib/index.js` L243-278 —— 官方冻结的摘要指令模板。
 * 照抄的理由：行为一致、输出质量已被用户认可。**不要自创格式。**
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');

// ══════════════════════════════════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════════════════════════════════

const DEFAULTS = Object.freeze({
  enabled: true,
  auto: true,
  triggerTokens: 400000,
  dangerTokens: 480000,
  keepTokens: 16000,
  overlapTokens: 4000,
  /**
   * 只在这些**预设**（agent preset）的会话里动作。空数组 = 不限制（对所有预设生效）。
   * 名单非空时，**读不到预设也一律不动作** —— 预设未知就不敢压，留给官方后端。
   */
  onlyPresets: [],
  summarizationProvider: '',
  summarizationModel: '',
  maxSummaryTokens: 65536,
  cooldownMs: 60000,
  maxJobMs: 600000,
});

function assertPositiveInt(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-precompaction: ${name} must be a positive safe integer, got ${String(value)}`);
  }
}

function resolveConfig(config = {}) {
  const merged = { ...DEFAULTS, ...config };
  assertPositiveInt('triggerTokens', merged.triggerTokens);
  assertPositiveInt('dangerTokens', merged.dangerTokens);
  if (merged.dangerTokens <= merged.triggerTokens) {
    throw new Error(`dsh-precompaction: dangerTokens (${merged.dangerTokens}) must be greater than triggerTokens (${merged.triggerTokens})`);
  }
  if (!Number.isSafeInteger(merged.keepTokens) || merged.keepTokens < 0) {
    throw new Error(`dsh-precompaction: keepTokens must be a non-negative safe integer, got ${String(merged.keepTokens)}`);
  }
  if (!Number.isSafeInteger(merged.overlapTokens) || merged.overlapTokens < 0) {
    throw new Error(`dsh-precompaction: overlapTokens must be a non-negative safe integer, got ${String(merged.overlapTokens)}`);
  }
  assertPositiveInt('maxSummaryTokens', merged.maxSummaryTokens);
  if (!Number.isSafeInteger(merged.cooldownMs) || merged.cooldownMs < 0) {
    throw new Error(`dsh-precompaction: cooldownMs must be a non-negative safe integer, got ${String(merged.cooldownMs)}`);
  }
  assertPositiveInt('maxJobMs', merged.maxJobMs);
  if (!Array.isArray(merged.onlyPresets)) {
    throw new Error(`dsh-precompaction: onlyPresets must be an array of preset ids, got ${typeof merged.onlyPresets}`);
  }
  const onlyPresets = merged.onlyPresets.map((value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`dsh-precompaction: onlyPresets entries must be non-empty strings, got ${JSON.stringify(value)}`);
    }
    return value.trim();
  });
  if (new Set(onlyPresets).size !== onlyPresets.length) {
    throw new Error(`dsh-precompaction: onlyPresets contains duplicate entries: ${JSON.stringify(onlyPresets)}`);
  }
  const provider = typeof merged.summarizationProvider === 'string' ? merged.summarizationProvider : '';
  const model = typeof merged.summarizationModel === 'string' ? merged.summarizationModel : '';
  if (provider.length === 0 !== (model.length === 0)) {
    throw new Error('dsh-precompaction: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair');
  }
  return Object.freeze({
    enabled: merged.enabled !== false,
    auto: merged.auto !== false,
    triggerTokens: merged.triggerTokens,
    dangerTokens: merged.dangerTokens,
    keepTokens: merged.keepTokens,
    overlapTokens: merged.overlapTokens,
    onlyPresets: Object.freeze(onlyPresets),
    summarizationProvider: provider,
    summarizationModel: model,
    maxSummaryTokens: merged.maxSummaryTokens,
    cooldownMs: merged.cooldownMs,
    maxJobMs: merged.maxJobMs,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 纯函数：范围选择 / 输入构造 / 指纹
// ══════════════════════════════════════════════════════════════════════════

/**
 * 取会话投影服务。
 *
 * **必须走 `ctx.get()`，不能直接 `ctx.sessionProjections`。**
 * cordis 对未写进 `inject` 的服务会**抛错**：实测（2026-10-18）
 * `cannot get property "sessionProjections" without inject`。
 * 而把 `sessionProjections` 写进 `inject` 会让插件在该服务缺席时整个加载失败 ——
 * 为了一个只读的开关不值得。`ctx.get()` 是官方自己用的可选取法：
 * 见 `dsh-api-session-controller/lib/index.js` L359 `this.ctx.get("agentPresets")`、
 * `dsh-agent-preset-registry/lib/types/invariant.js` L37 `ctx.get('agentPresets')`。
 *
 * @returns 投影服务，或 undefined
 */
function projectionsOf(ctx) {
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get('sessionProjections');
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch { /* ignore */ }
  try {
    // 万一将来把 sessionProjections 写进了 inject，这条也能通
    const direct = ctx?.sessionProjections;
    if (direct !== undefined && direct !== null) return direct;
  } catch { /* 未 inject 时 cordis 抛错，属预期 */ }
  return undefined;
}

/**
 * 读会话当前生效的预设 id（`onlyPresets` 判定的输入）。
 *
 * **为什么不用 `session.meta.agentPreset`：**
 * - 实测（2026-10-18，headless 会话）：`session.meta` 直接是 `undefined`；
 * - 即便有值，`meta` 只是**会话头**，中途切换预设（`agent-preset/selected`）不会更新它。
 *
 * **规范来源是会话投影**（dsh 自己就这么读）：
 * - `dsh-api-session-controller/lib/types/agent.js` L370：
 *   `return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined;`
 * - 投影定义 `dsh-agent-preset-registry/lib/types/session.js` L19-26：
 *   `init: header => header.agentPreset ?? null`，`apply` 吃 `agent-preset/selected` 事件。
 *
 * @param ctx - 插件上下文（用来拿可选的 `sessionProjections` 服务）。
 * @param session - 目标会话。
 * @returns 预设 id；读不到时 `undefined`（调用方必须把 undefined 当「不在名单」处理）。
 */
export function readAgentPreset(ctx, session) {
  try {
    const projections = projectionsOf(ctx);
    if (projections !== undefined && typeof projections.stateOf === 'function') {
      const value = projections.stateOf(session, 'agentPreset');
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch { /* 投影不可用：退回会话头，不让它影响主循环 */ }
  try {
    const value = session?.meta?.agentPreset;
    if (typeof value === 'string' && value.length > 0) return value;
  } catch { /* ignore */ }
  return undefined;
}

/**
 * 系统提示词节点判定。照 `dsh-compaction-basic/lib/index.js` L396-399 `systemHead`。
 * @returns 节点 0 是 system/message 时 true（此时范围必须从索引 1 起）
 */
export function hasSystemHead(session) {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return false;
  return session.eventAt(nodes[0])?.type === 'system/message';
}

/**
 * 选择要压的范围。逻辑照抄官方 `selectCompactableRange`
 * （`dsh-compaction-basic/lib/index.js` L410-433），**加上** 本插件特有的
 * 「重叠回带」（用户要求「多带几步保连续」）。
 *
 * 官方那条 `while (!toolPairingBalancedBefore(...)) keepFromIdx--` 也照抄；
 * 另外官方 `validateSurfaceRegion`（L550-566）还会查 `end` 端，
 * 这里用官方导出的 `toolPairingBalancedAfter` 一并查掉。
 *
 * @param session - 权威表层来源
 * @param measurement - `ctx.tokenMeter.measure(session)` 的结果
 * @param keepTokens - 「纯保留」的近期尾巴预算
 * @param overlapTokens - 额外回带的重叠量（0 = 与官方一致）
 * @returns `{ start, end, firstIdx, overlapFromIdx, keepFromIdx, shadowedSeqs, shadowedTokens }` 或 null
 */
export function selectRange(session, measurement, keepTokens, overlapTokens) {
  const priced = measurement.nodes;
  if (priced.length === 0) return null;
  const nodes = session.surface.nodes;
  if (nodes.length !== priced.length || nodes.some((seq, index) => seq !== priced[index]?.seq)) {
    throw new Error('dsh-precompaction: token-meter surface does not match the current session surface');
  }
  const firstIdx = hasSystemHead(session) ? 1 : 0;

  // 1) 从尾部往前累加，直到达到「纯保留」预算
  let accumulated = 0;
  let keepFromIdx = priced.length;
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index].tokens;
    keepFromIdx = index;
    if (accumulated >= keepTokens) break;
  }

  // 2) 再往前多推 overlapTokens，得到「含重叠」边界
  let overlapFromIdx = keepFromIdx;
  let overlapAccumulated = 0;
  while (overlapFromIdx > firstIdx && overlapAccumulated < overlapTokens) {
    overlapFromIdx -= 1;
    overlapAccumulated += priced[overlapFromIdx].tokens;
  }

  // 3) 两端都必须是工具配对平衡的切点（官方 L557-558 同款校验）
  let startIdx = firstIdx;
  while (startIdx < overlapFromIdx && !toolPairingBalancedBefore(session, nodes[startIdx])) startIdx += 1;
  let endIdx = overlapFromIdx - 1;
  while (endIdx >= startIdx && !toolPairingBalancedAfter(session, nodes[endIdx])) endIdx -= 1;

  if (endIdx < startIdx) return null;
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
  if (shadowedSeqs.length === 0) return null;
  let shadowedTokens = 0;
  for (let index = startIdx; index <= endIdx; index += 1) shadowedTokens += priced[index].heuristicTokens;

  return {
    start: nodes[startIdx],
    end: nodes[endIdx],
    firstIdx: startIdx,
    keepFromIdx,
    overlapFromIdx,
    shadowedSeqs,
    shadowedTokens,
    surfaceNodes: [...nodes],
  };
}

/**
 * 构造摘要输入。照抄官方 `buildSummarizationInput`
 * （`dsh-compaction-basic/lib/index.js` L695-704）。
 * @returns `{ tools, messages }`，messages = [系统提示词?, ...被压区域]
 */
export function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader();
  const nodes = session.surface.nodes;
  const head = nodes.length === 0 ? undefined : session.eventAt(nodes[0]);
  const system = head?.type === 'system/message' ? session.deriveEventMessage(head) : null;
  const region = shadowedSeqs
    .map((seq) => session.deriveEventMessage(session.eventAt(seq)))
    .filter((message) => message !== null && message !== undefined);
  return {
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages: system === null ? region : [system, ...region],
  };
}

/**
 * 一个节点当前派生消息的轻量指纹。
 * 用途：提交前确认「被选中的这一段没被别的 replace 改过内容」。
 * 官方用 `isDeepStrictEqual(meter.measure(...).nodes, ...)` 做等价的事
 * （`assertSelectedSpanStable` L617-626），这里用消息文本指纹，避免依赖测量细节。
 */
export function messageFingerprint(message) {
  if (message === null || message === undefined) return '';
  const parts = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text') parts.push(`t:${block.text}`);
    else if (block.type === 'reasoning') parts.push(`r:${block.text}`);
    else if (block.type === 'tool-call') parts.push(`c:${block.id}:${block.name}:${block.arguments}`);
    else parts.push(`x:${JSON.stringify(block)}`);
  }
  return `${message.role}|${parts.join('\u0001')}`;
}

/** 被压区域的节点指纹快照（用于提交前比对）。 */
export function spanFingerprint(session, shadowedSeqs) {
  return shadowedSeqs.map((seq) => messageFingerprint(session.deriveEventMessage(session.eventAt(seq))));
}

/** 官方 `frameSummary`（L344-356）的等价实现（官方未导出该函数）。 */
export function frameSummary(summary) {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ];
}

// ══════════════════════════════════════════════════════════════════════════
// 插件
// ══════════════════════════════════════════════════════════════════════════

/**
 * 每个 agent 一份的预压缩后端状态。
 */
class PrecompactionBackend {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** @type {Map<object, {job: object|null, cooldownUntil: number}>} */
    this.states = new Map();
    /** @type {Set<object>} 已经就「预设不在名单」记过一次日志的 agent（免得每步刷屏） */
    this.presetSkips = new Set();
    this.controller = new AbortController();
    this.disposed = false;
  }

  state(agent) {
    let state = this.states.get(agent);
    if (state === undefined) {
      state = { job: null, cooldownUntil: 0 };
      this.states.set(agent, state);
    }
    return state;
  }

  log(message) {
    try {
      this.ctx.logger?.info?.(`precompaction: ${message}`);
    } catch { /* logging must never break the loop */ }
  }

  warn(message) {
    try {
      this.ctx.logger?.warn?.(`precompaction: ${message}`);
    } catch { /* logging must never break the loop */ }
  }

  /** 解析摘要调用的目标路由。空配置 = 用最近路由（官方 `summarizeWithLlm` L293-303 同款回退链）。 */
  resolveTarget(agent) {
    const { summarizationProvider: provider, summarizationModel: model } = this.config;
    if (provider.length > 0 && model.length > 0) return { provider, model };
    const latest = agent.session.requestHeader()?.config;
    if (latest !== undefined && latest.provider.length > 0 && latest.model.length > 0) {
      return { provider: latest.provider, model: latest.model };
    }
    const options = agent.options ?? {};
    if (typeof options.provider === 'string' && options.provider.length > 0
      && typeof options.model === 'string' && options.model.length > 0) {
      return { provider: options.provider, model: options.model };
    }
    return undefined;
  }

  /** 后台摘要调用：一次 `ctx.llm.stream()`，官方同款（`summarizeWithLlm` L292-338）。 */
  async runSummary(agent, input, target, signal) {
    const assembler = new BlockAssembler();
    const messages = [
      ...input.messages,
      { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] },
    ];
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.maxSummaryTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      signal,
    };
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`precompaction summarization ${finish.kind}: ${finish.failure?.message ?? 'unknown'}`);
    }
    if (finish.kind === 'max-tokens') {
      throw new Error('precompaction summarization truncated at the token cap (incomplete checkpoint)');
    }
    const rawOutput = assembler.blocks();
    if (contentHasImage(rawOutput)) throw new Error('precompaction summary cannot contain image output');
    const summary = rawOutput.filter((block) => block.type === 'text');
    if (!summary.some((block) => block.text.trim().length > 0)) {
      throw new Error('precompaction summarization produced no text summary content');
    }
    return {
      summary,
      rawOutput,
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }

  /** 起一个后台 job。**不 await** —— 这是「不阻塞」的全部秘密。 */
  startJob(agent, measurement, range, target) {
    const state = this.state(agent);
    const job = {
      compactionId: CompactionId(randomUUID()),
      target,
      range: { start: range.start, end: range.end },
      shadowedSeqs: [...range.shadowedSeqs],
      shadowedTokens: range.shadowedTokens,
      fingerprints: spanFingerprint(agent.session, range.shadowedSeqs),
      replaceGeneration: agent.session.surface.replaceGeneration,
      contentGeneration: agent.session.surface.contentGeneration,
      snapshotTokens: measurement.totalTokens,
      startedAt: Date.now(),
      settled: false,
      result: undefined,
      failure: undefined,
      error: undefined,
    };
    state.job = job;

    const controller = new AbortController();
    job.cancel = (reason) => controller.abort(reason ?? new Error('precompaction job cancelled'));
    const onDispose = () => controller.abort(new Error('precompaction backend disposed'));
    this.controller.signal.addEventListener('abort', onDispose, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`precompaction job exceeded maxJobMs (${this.config.maxJobMs})`)), this.config.maxJobMs);
    if (typeof timer.unref === 'function') timer.unref();

    // 摘要输入在**起 job 时**快照（照官方 `prepareCompaction` L568-580）
    const input = buildSummarizationInput(agent.session, range.shadowedSeqs);

    this.log(`job started at ${measurement.totalTokens} tokens, shadowing ${range.shadowedSeqs.length} nodes (~${range.shadowedTokens} tok), route ${target.provider}/${target.model}`);

    job.promise = (async () => {
      try {
        const result = await this.runSummary(agent, input, target, controller.signal);
        job.result = result;
      } catch (error) {
        job.failure = error;
      } finally {
        clearTimeout(timer);
        this.controller.signal.removeEventListener('abort', onDispose);
        job.settled = true;
      }
    })();
    // 防未处理拒绝：job.promise 永不 reject（内部已 catch）
    return job;
  }

  /**
   * 提交：**同步四连写，中间不 await**。
   * 顺序与相邻性由官方契约固定，见文件头 §3/§4。
   * @returns true = 已提交
   */
  commit(agent, job, turn) {
    const session = agent.session;
    const { start, end } = job.range;

    // ── 复核 0：先看代际计数器（`SessionSurface` 暴露，`surface.d.ts` L118-125）。
    // 这是**快路径**：任何位置替换或插件拥有的消息变更都会让它前进。
    // 注意：官方压缩/工具结果修剪这类**位置替换**还会改动表层形状，
    // 会被下面的复核 1 拦住；而「消息投影」类变更形状不变，只有这里能快速发现。
    if (session.surface.contentGeneration !== job.contentGeneration) {
      this.warn('benign failure: surface content generation moved since the job started');
      return false;
    }

    // ── 复核 1：这一段还在表层、顺序一致
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(start);
    const endIdx = nodes.indexOf(end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      this.warn(`benign failure: selected range no longer on the surface (start ${start}, end ${end})`);
      return false;
    }
    const current = nodes.slice(startIdx, endIdx + 1);
    if (current.length !== job.shadowedSeqs.length || current.some((seq, index) => seq !== job.shadowedSeqs[index])) {
      this.warn('benign failure: selected span changed shape since the job started');
      return false;
    }

    // ── 复核 2：这一段的内容没被别的 replace 改过（工具结果修剪 / 官方压缩都会原地改）
    const nowFingerprints = spanFingerprint(session, job.shadowedSeqs);
    if (nowFingerprints.length !== job.fingerprints.length
      || nowFingerprints.some((value, index) => value !== job.fingerprints[index])) {
      this.warn('benign failure: selected span was rewritten during summarization');
      return false;
    }

    // ── 复核 3：两端仍是工具配对平衡的切点
    if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) {
      this.warn('benign failure: selected span is no longer a balanced tool-pairing boundary');
      return false;
    }

    // ── 复核 4：摘要必须更小（官方 L600-601 同款保护）
    const checkpointMessage = createUserMessage({
      content: frameSummary(job.result.summary),
      source: compactCheckpointSource(job.compactionId),
    });
    const framedTokens = this.ctx.tokenMeter.estimateMessage(checkpointMessage);
    if (framedTokens >= job.shadowedTokens) {
      this.warn(`benign failure: summary is not smaller than the shadowed content (${framedTokens} >= ${job.shadowedTokens})`);
      return false;
    }

    // ── 同步四连写（**中间不许有 await**）
    const lifecycle = { compactionId: job.compactionId, turn };
    const startEvent = session.append('compaction/start', lifecycle);
    const summaryEvent = session.append('compaction/summary', {
      compactionId: job.compactionId,
      summary: job.result.summary,
      rawOutput: job.result.rawOutput,
      llmStreamCall: true,
      shadowedRange: { start, end },
      shadowedSeqs: [...job.shadowedSeqs],
      shadowedTokenCount: job.shadowedTokens,
      provider: job.result.provider,
      model: job.result.model,
      ...(job.result.maxTokens === undefined ? {} : { maxTokens: job.result.maxTokens }),
      ...(job.result.usage === undefined ? {} : { usage: job.result.usage }),
    });
    try {
      session.append('user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...job.shadowedSeqs],
      });
    } catch (error) {
      // 替换失败：必须补一个带 error 的 end，否则这把锁会把官方后端永久锁死
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) });
      } catch (closeError) {
        this.warn(`failed to close compaction bracket after replace failure: ${errorChain(closeError)}`);
      }
      throw error;
    }
    session.append('compaction/end', lifecycle);

    const elapsed = Date.now() - job.startedAt;
    this.log(`committed after ${elapsed}ms: shadowed ${job.shadowedSeqs.length} nodes (~${job.shadowedTokens} tok) → checkpoint ~${framedTokens} tok`);
    return true;
  }

  /**
   * 这个会话的预设允不允许本插件动作（`onlyPresets` 闸门）。
   *
   * - 名单为空 ⇒ 不限制，保持旧的「对所有预设生效」行为。
   * - 名单非空 ⇒ 只有读到的预设 id 在名单里才放行。
   * - **读不到预设 ⇒ 不放行。** 这是刻意的：预设未知时宁可交给官方后端，
   *   也不能在一个来路不明的会话里乱压上下文。
   *
   * @returns true = 放行
   */
  presetAllowed(agent) {
    const allow = this.config.onlyPresets;
    if (allow.length === 0) return true;
    const preset = readAgentPreset(this.ctx, agent.session);
    if (preset !== undefined && allow.includes(preset)) return true;
    if (!this.presetSkips.has(agent)) {
      this.presetSkips.add(agent);
      this.log(
        `preset ${preset === undefined ? '(unreadable)' : `"${preset}"`} is not in onlyPresets `
        + `[${allow.join(', ')}]; leaving this session to the official backend`,
      );
    }
    return false;
  }

  /** 丢弃一个已结算/未结算的 job（取消后台调用、清状态）。 */
  drop(state, reason) {
    const job = state.job;
    state.job = null;
    if (job === null) return;
    if (!job.settled) job.cancel?.();
    this.warn(`job dropped: ${reason}`);
  }

  /** 每个 `agent/pre-step` 都跑：先尝试提交，再决定要不要起新 job。 */
  async preStep(agent, turn, signal) {
    if (this.disposed || !this.config.enabled || !this.config.auto) return;
    if (signal?.aborted) return;
    const state = this.state(agent);

    // ── 1) 有结算好的 job → 提交
    const job = state.job;
    if (job !== null && job.settled) {
      if (job.failure !== undefined) {
        this.warn(`summary failed: ${errorChain(job.failure)}; discarding this attempt`);
        state.job = null;
        state.cooldownUntil = Date.now() + this.config.cooldownMs;
      } else {
        let committed = false;
        try {
          committed = this.commit(agent, job, turn);
        } catch (error) {
          this.warn(`commit threw: ${errorChain(error)}; discarding this summary`);
        }
        state.job = null;
        if (!committed) state.cooldownUntil = Date.now() + this.config.cooldownMs;
        else state.cooldownUntil = 0;
        // 刚提交完就不要再起新 job（上下文已经降下来了）
        return;
      }
    }

    // ── 2) 决定要不要起新 job
    if (state.job !== null) return; // 有 job 在飞，主循环照跑
    if (Date.now() < state.cooldownUntil) return;

    // 预设闸门：只挡「起新 job」，不挡上面的提交 —— 否则中途换预设会把已算好的摘要
    // 悬在半空（job 一直不提交，白花一次摘要调用）。
    if (!this.presetAllowed(agent)) return;

    let measurement;
    try {
      measurement = this.ctx.tokenMeter.measure(agent.session);
    } catch (error) {
      this.warn(`token meter failed: ${errorChain(error)}`);
      return;
    }
    const pressure = measurement.totalTokens;
    if (pressure < this.config.triggerTokens) return;

    if (pressure >= this.config.dangerTokens) {
      // 太晚了：后台压完之前就可能撞上官方线，主动让位给官方同步压缩
      this.warn(`pressure ${pressure} >= dangerTokens ${this.config.dangerTokens}; skipping background compaction and leaving it to the official backend`);
      state.cooldownUntil = Date.now() + this.config.cooldownMs;
      return;
    }

    const target = this.resolveTarget(agent);
    if (target === undefined) {
      this.warn('no provider/model available for summarization');
      return;
    }

    let range;
    try {
      range = selectRange(agent.session, measurement, this.config.keepTokens, this.config.overlapTokens);
    } catch (error) {
      this.warn(`range selection failed: ${errorChain(error)}`);
      state.cooldownUntil = Date.now() + this.config.cooldownMs;
      return;
    }
    if (range === null) return; // 没东西可压

    try {
      this.startJob(agent, measurement, range, target);
    } catch (error) {
      this.warn(`failed to start job: ${errorChain(error)}`);
      state.cooldownUntil = Date.now() + this.config.cooldownMs;
    }
  }

  dispose() {
    this.disposed = true;
    this.controller.abort(new Error('precompaction backend disposed'));
    this.states.clear();
  }
}

/** cordis 插件入口。 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  const backend = new PrecompactionBackend(ctx, resolved);

  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    try {
      await backend.preStep(agent, turn, signal);
    } catch (error) {
      // 预压缩的任何异常都不许影响主循环
      backend.warn(`pre-step hook failed: ${errorChain(error)}; continuing the turn`);
    }
    return next();
  });

  // cordis 的 fiber 销毁钩子：ctx.effect 的回调返回值即清理函数
  ctx.effect(() => () => backend.dispose(), 'dsh-precompaction.dispose');

  ctx.logger?.info?.(
    `precompaction: armed (trigger ${resolved.triggerTokens}, danger ${resolved.dangerTokens}, `
    + `keep ${resolved.keepTokens}, overlap ${resolved.overlapTokens}, auto ${resolved.auto}, `
    + `onlyPresets ${resolved.onlyPresets.length === 0 ? '(all)' : `[${resolved.onlyPresets.join(', ')}]`})`,
  );
}

export { resolveConfig, PrecompactionBackend, COMPACTION_INSTRUCTION, CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG, SUMMARY_CLOSE_TAG };
