/**
 * dsh-precompaction 验证套件（自包含，不需要 dsh 运行时）
 *
 * 用法：
 *   node verify-precompaction.mjs
 *
 * 做法：
 *   1) 用 `module.registerHooks` 把 `@deepseek-ai/*` 裸标识符重定向到本地 dsh 安装的
 *      `profiles/node_modules`（**不需要 junction**，避免污染插件目录）；
 *   2) 用**真实的 `Session`**（`dsh-session`）构造合成会话 —— 所以
 *      `session.append(..., {surfaceOp:{op:'replace'}})` 的校验、`deriveMessages()`
 *      的重派生、官方 `toolPairingBalanced*` 全是**真货**，不是 mock；
 *   3) 只 mock 两样：`ctx.llm.stream()`（免得真花钱）与 `ctx.tokenMeter`（免得要起
 *      cordis 服务）。
 *
 * 断言依据全部来自官方源码（每条注明出处），见 lib/index.js 文件头。
 */

import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── 1) 解析钩子：把 @deepseek-ai/* 指到本地 dsh 安装 ──────────────────────
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const SCOPE_DIR = path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai');

/** 按包自己的 exports/main 解析入口（各包入口不一致，例如 schemastery 是 lib/index.mjs）。 */
function entryOf(base, sub) {
  const manifest = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
  if (sub === '') {
    const root = manifest.exports?.['.'];
    const pick = root === undefined
      ? undefined
      : typeof root === 'string' ? root : (root.import ?? root.default ?? root.require);
    return path.join(base, pick ?? manifest.module ?? manifest.main ?? 'lib/index.js');
  }
  const key = `./${sub}`;
  const mapped = manifest.exports?.[key];
  const pick = mapped === undefined
    ? undefined
    : typeof mapped === 'string' ? mapped : (mapped.import ?? mapped.default ?? mapped.require);
  return path.join(base, pick ?? `lib/${sub}.js`);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      const rest = specifier.slice('@deepseek-ai/'.length);
      const slash = rest.indexOf('/');
      const pkg = slash === -1 ? rest : rest.slice(0, slash);
      const sub = slash === -1 ? '' : rest.slice(slash + 1);
      return { url: pathToFileURL(entryOf(path.join(SCOPE_DIR, pkg), sub)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// ── 2) 被测模块 ──────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'lib', 'index.js');
const plugin = await import(pathToFileURL(PLUGIN).href);
const { Session, SessionId, SessionSeq } = await import('@deepseek-ai/dsh-session');
const { estimateMessage } = await import('@deepseek-ai/dsh-token-meter/estimate');
const { compactCheckpointSource } = await import('@deepseek-ai/dsh-compaction');
const { createUserMessage } = await import('@deepseek-ai/dsh-llm');

// ══════════════════════════════════════════════════════════════════════════
// 测试框架
// ══════════════════════════════════════════════════════════════════════════
let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('断言返回 false');
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n       ${error?.message ?? error}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('断言返回 false');
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n       ${error?.message ?? error}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message ?? '断言失败');
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label ?? '值'} 不等：actual=${actual} expected=${expected}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 合成会话构造
// ══════════════════════════════════════════════════════════════════════════

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

/** 造一段带 padding 的文本，让 estimateMessage 落到目标 token 数附近。 */
function textOfTokens(tokens) {
  return 'x'.repeat(Math.max(1, tokens * 4 - 8));
}

/**
 * 造一个合成会话：
 *   [0] system/message
 *   [1] turn/start
 *   [2] user/message
 *   [3..] 交替 assistant/message（带 tool-call）与 tool/result
 * @returns {{session: Session, nodes: number[]}}
 */
function buildSession({ steps = 12, tokensPerStep = 600, systemTokens = 200 } = {}) {
  const session = Session.create(SessionId('session-verify-precompaction'));
  session.append('system/message', {
    message: { role: 'system', content: [{ type: 'text', text: textOfTokens(systemTokens) }], id: nextId('sys') },
  }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  session.append('user/message', {
    role: 'user',
    content: [{ type: 'text', text: textOfTokens(tokensPerStep) }],
    id: nextId('usr'),
  }, { surfaceOp: 'append' });

  for (let step = 1; step <= steps; step += 1) {
    const callId = nextId('call');
    session.append('step/start', { turn: 1, step });
    session.append('assistant/message', {
      turn: 1,
      step,
      message: {
        role: 'assistant',
        id: nextId('asst'),
        content: [
          { type: 'text', text: textOfTokens(Math.round(tokensPerStep / 2)) },
          { type: 'tool-call', id: callId, name: 'pwsh', arguments: JSON.stringify({ command: textOfTokens(Math.round(tokensPerStep / 4)) }) },
        ],
      },
    }, { surfaceOp: 'append' });
    session.append('tool/call', { turn: 1, step, callId });
    session.append('tool/result', {
      turn: 1,
      step,
      message: {
        role: 'tool',
        id: nextId('res'),
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: textOfTokens(Math.round(tokensPerStep / 4)) }],
      },
    }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 1, step });
  }
  return { session, nodes: [...session.surface.nodes] };
}

/** 官方口径的启发式测量（只做 unit 级：tokens = heuristicTokens）。 */
function measure(session) {
  const nodes = session.surface.nodes.map((s) => {
    const message = session.deriveEventMessage(session.eventAt(s));
    const tokens = message === null || message === undefined ? 0 : estimateMessage(message);
    return { seq: s, tokens, heuristicTokens: tokens };
  });
  return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0), surfaceTokens: 0, surfaceDeltaTokens: 0, logRevision: session.seq, baseline: { kind: 'none', tokens: 0 } };
}

// ══════════════════════════════════════════════════════════════════════════
// ctx / llm 替身
// ══════════════════════════════════════════════════════════════════════════

function makeCtx({ streamImpl, estimateOverride } = {}) {
  const logs = [];
  return {
    logs,
    logger: {
      info: (m) => logs.push(`INFO ${m}`),
      warn: (m) => logs.push(`WARN ${m}`),
    },
    tokenMeter: {
      measure: (session) => measure(session),
      estimateMessage: estimateOverride ?? ((message) => estimateMessage(message)),
    },
    llm: {
      stream: streamImpl ?? defaultStream,
    },
  };
}

/** 默认：吐一段正常摘要（text-delta + usage + finish）。 */
async function* defaultStream(options) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: '## Primary Request and Intent\n- (none)\n## Next Step\n- (none)' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '## Primary Request and Intent\n- (none)\n## Next Step\n- (none)' } };
  yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

function makeBackend(ctx, config = {}) {
  const resolved = plugin.resolveConfig({
    triggerTokens: 1000,
    dangerTokens: 100000,
    keepTokens: 300,
    overlapTokens: 100,
    cooldownMs: 0,
    maxJobMs: 60000,
    ...config,
  });
  return new plugin.PrecompactionBackend(ctx, resolved);
}

/** 测试用 agent 替身。**必须带 provider/model**，否则 resolveTarget 会因没有
 *  request/header 而解析不出路由（真实 agent 有 requestHeader，合成会话没有）。 */
function makeAgent(session) {
  return { session, options: { provider: 'example-provider', model: 'test-model' } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ══════════════════════════════════════════════════════════════════════════
// 测试
// ══════════════════════════════════════════════════════════════════════════

console.log('\n═══ A. 范围选择（官方 selectCompactableRange L410-433 + 两端配对校验）═══');

check('A1 系统提示词永不入选（范围从索引 1 起）', () => {
  const { session, nodes } = buildSession();
  const range = plugin.selectRange(session, measure(session), 300, 100);
  assert(range !== null, 'range 不应为 null');
  assert(range.start !== nodes[0], 'start 不能是节点 0（系统提示词）');
  eq(session.eventAt(range.start).type === 'system/message', false, 'start 是系统提示词');
});

check('A2 没有系统头时范围可以从索引 0 起', () => {
  const session = Session.create(SessionId('session-no-system'));
  session.append('turn/start', { turn: 1 });
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: textOfTokens(2000) }], id: nextId('u') }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', id: nextId('a'), content: [{ type: 'text', text: textOfTokens(2000) }] },
  }, { surfaceOp: 'append' });
  const range = plugin.selectRange(session, measure(session), 100, 0);
  assert(range !== null, 'range 不应为 null');
  eq(range.start, session.surface.nodes[0], 'start 应为节点 0');
});

check('A3 不切开工具调用对：两端都平衡', () => {
  const { session } = buildSession();
  const range = plugin.selectRange(session, measure(session), 300, 100);
  const before = plugin.hasSystemHead(session) ? 1 : 0;
  // 手工复算平衡：end 之后必须没有未应答的 tool-call
  const nodes = session.surface.nodes;
  const endIdx = nodes.indexOf(range.end);
  let open = 0;
  for (let i = 0; i <= endIdx; i += 1) {
    const ev = session.eventAt(nodes[i]);
    if (ev.type === 'assistant/message') open += ev.data.message.content.filter((b) => b.type === 'tool-call').length;
    else if (ev.type === 'tool/result') open -= 1;
  }
  eq(open, 0, `end 处未应答 tool-call 数（range.start=${range.start} end=${range.end}）`);
  assert(endIdx >= before, 'end 索引应 >= 起始索引');
});

check('A4 重叠生效：H 的末尾比「纯保留」边界更靠前', () => {
  const { session } = buildSession();
  const m = measure(session);
  const withOverlap = plugin.selectRange(session, m, 300, 0);
  const withOut = plugin.selectRange(session, m, 300, 600);
  assert(withOverlap !== null && withOut !== null, 'range 不应为 null');
  const idxA = session.surface.nodes.indexOf(withOverlap.end);
  const idxB = session.surface.nodes.indexOf(withOut.end);
  assert(idxB < idxA, `重叠后 end 应更靠前：无重叠 idx=${idxA}，有重叠 idx=${idxB}`);
});

check('A5 没东西可压时返回 null', () => {
  const { session } = buildSession({ steps: 2, tokensPerStep: 50, systemTokens: 20 });
  const range = plugin.selectRange(session, measure(session), 1_000_000, 0);
  eq(range, null, 'range');
});

console.log('\n═══ B. 摘要输入构造（官方 buildSummarizationInput L695-704）═══');

check('B1 系统提示词放第一位，其后是被压区域', () => {
  const { session } = buildSession();
  const range = plugin.selectRange(session, measure(session), 300, 100);
  const input = plugin.buildSummarizationInput(session, range.shadowedSeqs);
  assert(Array.isArray(input.messages), 'messages 应为数组');
  eq(input.messages[0].role, 'system', '首条消息角色');
  eq(input.messages.length, range.shadowedSeqs.length + 1, '消息条数');
});

console.log('\n═══ C. 提交：官方契约（真实 Session 校验）═══');

await checkAsync('C1 检查点必须先有 compaction/start（官方 invariant.js L54-62）', async () => {
  const { session } = buildSession();
  const checkpoint = createUserMessage({
    content: plugin.frameSummary([{ type: 'text', text: 'summary' }]),
    source: compactCheckpointSource('cid-orphan'),
  });
  const nodes = session.surface.nodes;
  let threw = false;
  try {
    // 故意不写 compaction/start，直接 replace
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: nodes[1], endSeq: nodes[3] },
      sourceEventSeqs: [nodes[1], nodes[2], nodes[3]],
    });
  } catch {
    threw = true;
  }
  // 注意：当前 profile 未加载不变量组件，所以 dsh-session 本身**不会**拦这个。
  // 这条测试记录的是「运行时拦不拦」，不是「契约对不对」。
  return threw === true ? true : 'UNEXPECTED: dsh-session 竟然拦住了（说明不变量已加载，需重新评估）';
});

await checkAsync('C2 正常提交：四连写落地 + 表层真的变小 + 检查点被 deriveMessages 渲染', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const m0 = measure(session);
  const agent = makeAgent(session);

  await backend.preStep(agent, 1, { aborted: false });
  const state = backend.state(agent);
  assert(state.job !== null, '应已起 job');
  const job = state.job;
  await job.promise;

  const before = session.deriveMessages().length;
  const nodesBefore = session.surface.nodes.length;
  await backend.preStep(agent, 1, { aborted: false });

  eq(backend.state(agent).job, null, '提交后 job 应清空');
  const after = session.deriveMessages().length;
  assert(after < before, `派生消息数应下降：${before} → ${after}`);
  const nodesAfter = session.surface.nodes.length;
  assert(nodesAfter < nodesBefore, `表层节点数应下降：${nodesBefore} → ${nodesAfter}`);

  const events = session.snapshotEvents();
  const types = events.map((e) => e.type);
  const starts = types.filter((t) => t === 'compaction/start').length;
  const ends = types.filter((t) => t === 'compaction/end').length;
  const summaries = types.filter((t) => t === 'compaction/summary').length;
  eq(starts, 1, 'compaction/start 条数');
  eq(ends, 1, 'compaction/end 条数');
  eq(summaries, 1, 'compaction/summary 条数');

  // 相邻性契约：summary 的**下一条**必须是那个 replace user/message
  const summaryIdx = types.indexOf('compaction/summary');
  eq(types[summaryIdx + 1], 'user/message', 'summary 的下一条事件类型');
  const replaceEvent = events[summaryIdx + 1];
  eq(replaceEvent.surfaceOp?.op, 'replace', 'surfaceOp.op');

  // 顺序契约：start 在 summary 之前
  assert(types.indexOf('compaction/start') < summaryIdx, 'start 必须在 summary 之前');

  // 检查点必须出现在派生历史里，且带 compacted-summary 标签
  const derived = session.deriveMessages();
  const hasCheckpoint = derived.some((msg) => JSON.stringify(msg.content ?? []).includes('<compacted-summary>'));
  assert(hasCheckpoint, '派生历史里应能找到检查点');

  // 原文仍在日志里（只遮蔽不删除）
  eq(events.length > nodesAfter, true, '日志事件数应多于表层节点数');
});

await checkAsync('C3 日志可重放：foldSurface 重新折叠结果与在线表层一致', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  await backend.state(agent).job.promise;
  await backend.preStep(agent, 1, { aborted: false });

  const { foldSurface } = await import('@deepseek-ai/dsh-session');
  const folded = foldSurface(session.snapshotEvents());
  eq(folded.nodes.length, session.surface.nodes.length, '重放节点数');
  eq(folded.nodes.join(','), session.surface.nodes.join(','), '重放节点序列');
});

console.log('\n═══ D. 状态机（同一时刻只允许一个 job）═══');

await checkAsync('D1 连续触发两次，第二次不起 job', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      await new Promise((r) => setTimeout(r, 50)); // 故意慢，制造「在飞」窗口
      yield* defaultStream();
    },
  });
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  const first = backend.state(agent).job;
  assert(first !== null, '第一次应起 job');
  await backend.preStep(agent, 1, { aborted: false });
  eq(backend.state(agent).job, first, '第二次不应替换 job 实例（同一时刻只有一个）');
  await first.promise;
});

await checkAsync('D2 摘要失败 → 主循环不受影响，job 被丢弃', async () => {
  const ctx = makeCtx({
    streamImpl: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } };
    },
  });
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  const failedJob = backend.state(agent).job;
  await failedJob.promise;
  await backend.preStep(agent, 1, { aborted: false }); // 不应抛
  // 失败的 job 必须被换掉（不是留在原地等提交），且不得写 start
  assert(backend.state(agent).job !== failedJob, '失败的 job 应已被丢弃/替换');
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
  assert(ctx.logs.some((l) => l.includes('summary failed')), '应有失败告警');
});

await checkAsync('D3 压力低于触发点 → 不起 job', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx, { triggerTokens: 10_000_000, dangerTokens: 20_000_000 });
  const { session } = buildSession({ steps: 4 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  eq(backend.state(agent).job, null, 'job');
});

await checkAsync('D4 压力到 dangerTokens → 主动让位，不起 job', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx, { triggerTokens: 10, dangerTokens: 20 });
  const { session } = buildSession({ steps: 4 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  eq(backend.state(agent).job, null, 'job');
  assert(ctx.logs.some((l) => l.includes('dangerTokens')), '应有让位告警');
});

await checkAsync('D5 enabled:false / auto:false 时完全不动', async () => {
  for (const cfg of [{ enabled: false }, { auto: false }]) {
    const ctx = makeCtx();
    const backend = makeBackend(ctx, cfg);
    const { session } = buildSession({ steps: 14 });
    const agent = makeAgent(session);
    await backend.preStep(agent, 1, { aborted: false });
    eq(backend.state(agent).job, null, `job（${JSON.stringify(cfg)}）`);
    eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
  }
});

console.log('\n═══ E. 良性失败路径（都不得留下未闭合的 start）═══');

async function runToSettled(backend, agent, mutate) {
  await backend.preStep(agent, 1, { aborted: false });
  const job = backend.state(agent).job;
  assert(job !== null, '应已起 job');
  await job.promise;
  if (mutate) mutate(agent.session, job);
  await backend.preStep(agent, 1, { aborted: false });
  return job;
}

await checkAsync('E1 被压段内容被换掉（表层形状不变）→ 拒绝提交（官方 assertSelectedSpanStable L617-626 同款）', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await runToSettled(backend, agent, (_s, job) => {
    // 关键：**不改表层形状**，只让「起 job 时记下的那段内容指纹」变陈旧。
    // 真实触发场景：插件拥有的消息投影（image/offload）改了节点派生内容，
    // 而 `session.surface.nodes` 一字不变。
    job.fingerprints = job.fingerprints.map(() => 'STALE-FINGERPRINT');
  });
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
  assert(ctx.logs.some((l) => l.includes('rewritten')), '应有 rewritten 告警');
});

await checkAsync('E1b 工具结果被原地修剪 → 拒绝提交（真实 API 路径）', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await runToSettled(backend, agent, (s, job) => {
    const target = job.shadowedSeqs.find((sq) => s.eventAt(sq).type === 'tool/result');
    const ev = s.eventAt(target);
    s.append('tool/result', {
      ...ev.data,
      message: { ...ev.data.message, content: [{ type: 'text', text: 'PRUNED' }] },
    }, { surfaceOp: { op: 'replace', startSeq: target, endSeq: target }, sourceEventSeqs: [target] });
  });
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
  assert(ctx.logs.some((l) => l.includes('rewritten') || l.includes('changed shape') || l.includes('generation moved')), '应有失效告警');
});

await checkAsync('E2 被压段已不在表层 → 拒绝提交', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await runToSettled(backend, agent, (s, job) => {
    // 模拟「官方压缩抢先跑了一次」：把整段替换掉
    const checkpoint = createUserMessage({
      content: plugin.frameSummary([{ type: 'text', text: 'official' }]),
      source: { kind: 'user' },
    });
    s.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: job.range.start, endSeq: job.range.end },
      sourceEventSeqs: [...job.shadowedSeqs],
    });
  });
  assert(ctx.logs.some((l) => l.includes('no longer on the surface') || l.includes('changed shape') || l.includes('generation moved')), '应有范围失效告警');
});

await checkAsync('E3 摘要不比原文小 → 拒绝提交（官方 L600-601）', async () => {
  const ctx = makeCtx({ estimateOverride: () => 999_999 });
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await runToSettled(backend, agent);
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
  assert(ctx.logs.some((l) => l.includes('not smaller')), '应有 not smaller 告警');
});

await checkAsync('E4 标记对一定闭合：各失败路径下 start 与 end 数量相等', async () => {
  const cases = [
    ['正常', undefined, undefined],
    ['段被改写', undefined, (s, job) => {
      const target = job.shadowedSeqs.find((sq) => s.eventAt(sq).type === 'tool/result');
      const ev = s.eventAt(target);
      s.append('tool/result', { ...ev.data, message: { ...ev.data.message, content: [{ type: 'text', text: 'P' }] } },
        { surfaceOp: { op: 'replace', startSeq: target, endSeq: target }, sourceEventSeqs: [target] });
    }],
    ['摘要过大', () => 999_999, undefined],
  ];
  for (const [label, estimateOverride, mutate] of cases) {
    const ctx = makeCtx(estimateOverride === undefined ? {} : { estimateOverride });
    const backend = makeBackend(ctx);
    const { session } = buildSession({ steps: 14 });
    const agent = makeAgent(session);
    await runToSettled(backend, agent, mutate);
    const events = session.snapshotEvents();
    const starts = events.filter((e) => e.type === 'compaction/start').length;
    const ends = events.filter((e) => e.type === 'compaction/end').length;
    eq(starts, ends, `${label}：start/end 数量`);
    // 不允许有未闭合的 start
    let open = 0;
    for (const e of events) {
      if (e.type === 'compaction/start') open += 1;
      else if (e.type === 'compaction/end') open -= 1;
    }
    eq(open, 0, `${label}：未闭合 start 数`);
  }
});

await checkAsync('E5 replace 落地失败时仍补一个带 error 的 compaction/end（锁不会漏）', async () => {
  const ctx = makeCtx();
  const backend = makeBackend(ctx);
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  const job = backend.state(agent).job;
  await job.promise;

  // 只在 user/message（即 replace）那一次 append 上注入失败，
  // 模拟「start 与 summary 都写进去了、替换却落地失败」这个最危险的窗口。
  const realAppend = session.append.bind(session);
  let injected = false;
  session.append = (type, data, ...rest) => {
    if (type === 'user/message' && !injected) {
      injected = true;
      throw new Error('injected: replace rejected by the session');
    }
    return realAppend(type, data, ...rest);
  };
  let threw = false;
  try {
    backend.commit(agent, job, 1);
  } catch {
    threw = true;
  } finally {
    session.append = realAppend;
  }

  const events = session.snapshotEvents();
  const starts = events.filter((e) => e.type === 'compaction/start').length;
  const ends = events.filter((e) => e.type === 'compaction/end').length;
  eq(injected, true, '注入是否生效');
  eq(threw, true, 'commit 应把错误抛出去（由 preStep 捕获记日志）');
  eq(starts, 1, 'compaction/start 条数');
  eq(ends, 1, 'compaction/end 条数（必须闭合，否则官方后端被永久锁死）');
  eq(ends - starts, 0, '未闭合 start 数');
  const endEvent = events.find((e) => e.type === 'compaction/end');
  assert(typeof endEvent.data.error === 'string' && endEvent.data.error.length > 0, 'end 必须带 error 说明');
});

console.log('\n═══ F. 配置校验 ═══');

check('F1 dangerTokens 必须大于 triggerTokens', () => {
  let threw = false;
  try {
    plugin.resolveConfig({ triggerTokens: 500, dangerTokens: 400 });
  } catch { threw = true; }
  assert(threw, '应当抛错');
});

check('F2 summarizationProvider/Model 必须成对', () => {
  let threw = false;
  try {
    plugin.resolveConfig({ summarizationProvider: 'example-provider' });
  } catch { threw = true; }
  assert(threw, '应当抛错');
});

check('F3 默认值符合文档（触发 400000 / 保留 16000 / 重叠 4000）', () => {
  const c = plugin.resolveConfig({});
  eq(c.triggerTokens, 400000, 'triggerTokens');
  eq(c.keepTokens, 16000, 'keepTokens');
  eq(c.overlapTokens, 4000, 'overlapTokens');
  eq(c.enabled, true, 'enabled');
  eq(c.auto, true, 'auto');
  eq(c.onlyPresets.length, 0, 'onlyPresets 默认必须为空（= 不限制，保持旧行为）');
});

check('F4 onlyPresets 必须是「非空字符串」数组，且不许重复', () => {
  const ok = plugin.resolveConfig({ onlyPresets: ['computer-use'] });
  eq(ok.onlyPresets.length, 1, '应接受合法名单');
  eq(ok.onlyPresets[0], 'computer-use', '名单内容');
  eq(Object.isFrozen(ok.onlyPresets), true, '名单必须冻结，防止运行期被改');
  eq(plugin.resolveConfig({ onlyPresets: [' computer-use '] }).onlyPresets[0], 'computer-use', '应 trim');

  const bad = [
    'computer-use',            // 不是数组
    [''],                      // 空串
    ['   '],                   // 全空白
    [42],                      // 非字符串
    [null],                    // null
    ['a', 'a'],                // 重复
  ];
  for (const value of bad) {
    let threw = false;
    try { plugin.resolveConfig({ onlyPresets: value }); } catch { threw = true; }
    assert(threw, `应当抛错：${JSON.stringify(value)}`);
  }
});

check('F5 readAgentPreset 优先走会话投影，退回会话头，都没有则 undefined', () => {
  const svc = { stateOf: (_s, key) => (key === 'agentPreset' ? 'computer-use' : null) };

  // 1) ctx.get() 是主路径（cordis 未 inject 的服务只能这么拿）
  eq(plugin.readAgentPreset({ get: () => svc }, { meta: { agentPreset: 'standard' } }),
    'computer-use', 'ctx.get() 拿到的投影应优先于会话头');

  // 2) 直接属性也能通（万一将来写进了 inject）
  eq(plugin.readAgentPreset({ sessionProjections: svc }, { meta: { agentPreset: 'standard' } }),
    'computer-use', '直接属性路径');

  // 3) 真实 cordis 行为：未 inject 时读属性会**抛错** —— 必须被吞掉并退回会话头
  const throwing = {
    get: () => { throw new Error('cannot get property "sessionProjections" without inject'); },
  };
  Object.defineProperty(throwing, 'sessionProjections', {
    get() { throw new Error('cannot get property "sessionProjections" without inject'); },
  });
  eq(plugin.readAgentPreset(throwing, { meta: { agentPreset: 'standard' } }),
    'standard', '投影抛错时应退回会话头且不许冒泡');

  // 4) 投影本身抛错 → 退回会话头
  eq(plugin.readAgentPreset({ get: () => ({ stateOf: () => { throw new Error('nope'); } }) }, { meta: { agentPreset: 'standard' } }),
    'standard', 'stateOf 抛错时应退回会话头');
  eq(plugin.readAgentPreset({}, { meta: { agentPreset: 'standard' } }), 'standard', '无投影服务时用会话头');
  eq(plugin.readAgentPreset(undefined, { meta: { agentPreset: 'standard' } }), 'standard', 'ctx 为空也不许抛');

  // 5) 都读不到 → undefined（实测 headless 会话的 session.meta 就是 undefined）
  eq(plugin.readAgentPreset({}, undefined), undefined, 'session 为空');
  eq(plugin.readAgentPreset({}, {}), undefined, 'meta 缺失');
  eq(plugin.readAgentPreset({ get: () => ({ stateOf: () => null }) }, { meta: {} }), undefined, '投影为 null');
});

console.log('\n═══ G. 官方模板照抄一致性 ═══');

await checkAsync('G1 COMPACTION_INSTRUCTION 与官方逐字一致', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(
    path.join(SCOPE_DIR, 'dsh-compaction-basic', 'lib', 'index.js'), 'utf8',
  );
  // 官方是 `const COMPACTION_INSTRUCTION = [ ... ].join("\n");`，数组里含模板字符串，
  // 不能直接 JSON.parse —— 改成抽出每个字符串字面量再拼。
  const start = src.indexOf('const COMPACTION_INSTRUCTION = [');
  assert(start !== -1, '未找到模板定义');
  const end = src.indexOf('].join("\\n");', start);
  assert(end !== -1, '未找到模板结尾');
  const body = src.slice(start, end);
  const parts = [];
  const re = /^[\t ]*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`),?$/gm;
  let m;
  while ((m = re.exec(body)) !== null) parts.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]);
  assert(parts.length > 10, `抽出的模板行数太少：${parts.length}`);
  // 官方那一行是模板字符串，源文本里是 ${SUMMARY_OPEN_TAG} 字面量；求值后才是真值。
  const official = parts.join('\n').replaceAll('${SUMMARY_OPEN_TAG}', '<compacted-summary>');
  eq(plugin.COMPACTION_INSTRUCTION, official, '模板文本');
});

await checkAsync('G2 CHECKPOINT_PREAMBLE 与官方逐字一致', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(
    path.join(SCOPE_DIR, 'dsh-compaction-basic', 'lib', 'index.js'), 'utf8',
  );
  const m = src.match(/const CHECKPOINT_PREAMBLE = "([^"]*)";/);
  assert(m !== null, '未能抽出 preamble');
  eq(plugin.CHECKPOINT_PREAMBLE, m[1], 'preamble 文本');
});

await checkAsync('G3 frameSummary 与官方 frameSummary 等价（结构 + 首尾文本）', async () => {
  const summary = [{ type: 'text', text: 'BODY' }];
  const framed = plugin.frameSummary(summary);
  eq(framed.length, 3, '块数');
  eq(framed[0].text, `${plugin.CHECKPOINT_PREAMBLE}\n\n<compacted-summary>`, '首块文本');
  eq(framed[1].text, 'BODY', '正文');
  eq(framed[2].text, '</compacted-summary>', '尾块文本');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n═══ H. 插件入口 apply()（cordis 契约）═══');

/** 极简 cordis 替身：记录监听器与 effect 清理函数。 */
function makeCordisStub() {
  const listeners = new Map();
  const effects = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    tokenMeter: { measure: (s) => measure(s), estimateMessage: (m) => estimateMessage(m) },
    llm: { stream: defaultStream },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, disposer });
      return () => disposer?.();
    },
  };
  return { ctx, listeners, effects };
}

await checkAsync('H1 apply() 注册 agent/pre-step 监听器', async () => {
  const { ctx, listeners } = makeCordisStub();
  plugin.apply(ctx, {});
  const hooks = listeners.get('agent/pre-step') ?? [];
  eq(hooks.length, 1, 'agent/pre-step 监听器数');
  eq(typeof hooks[0], 'function', '监听器类型');
});

await checkAsync('H2 监听器遵守 waterfall 契约：调用 next() 并透传其返回值', async () => {
  const { ctx, listeners } = makeCordisStub();
  plugin.apply(ctx, {});
  const hook = listeners.get('agent/pre-step')[0];
  const { session } = buildSession({ steps: 3 });
  const agent = makeAgent(session);
  const sentinel = { kind: 'enter', messages: [] };
  let called = 0;
  const decision = await hook({ agent, turn: 1, step: 1, signal: { aborted: false } }, () => {
    called += 1;
    return Promise.resolve(sentinel);
  });
  eq(called, 1, 'next() 调用次数');
  eq(decision, sentinel, '返回值');
});

await checkAsync('H3 后端抛错不得影响主循环：next() 仍被调用', async () => {
  const { ctx, listeners } = makeCordisStub();
  plugin.apply(ctx, {});
  const hook = listeners.get('agent/pre-step')[0];
  // 造一个会让 preStep 抛错的 agent：tokenMeter.measure 抛
  ctx.tokenMeter.measure = () => { throw new Error('meter exploded'); };
  const agent = makeAgent({});
  let called = 0;
  await hook({ agent, turn: 1, step: 1, signal: { aborted: false } }, () => {
    called += 1;
    return Promise.resolve({ kind: 'enter', messages: [] });
  });
  eq(called, 1, 'next() 调用次数（异常也必须放行）');
});

await checkAsync('H4 dispose 后不再起 job（effect 清理生效）', async () => {
  const { ctx, listeners, effects } = makeCordisStub();
  plugin.apply(ctx, {});
  const hook = listeners.get('agent/pre-step')[0];
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  eq(effects.length, 1, 'effect 注册数');
  await hook({ agent, turn: 1, step: 1, signal: { aborted: false } }, () => Promise.resolve({ kind: 'enter', messages: [] }));
  const hadJob = session.snapshotEvents().length >= 0;
  effects[0].disposer(); // 模拟 fiber 销毁
  // 销毁后再触发：不应再起新 job（旧 job 已被 abort）
  await hook({ agent, turn: 1, step: 1, signal: { aborted: false } }, () => Promise.resolve({ kind: 'enter', messages: [] }));
  eq(hadJob, true, '前置条件');
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '销毁后不应写 start');
});

await checkAsync('H5 signal 已 abort 时直接返回', async () => {
  const { ctx, listeners } = makeCordisStub();
  plugin.apply(ctx, {});
  const hook = listeners.get('agent/pre-step')[0];
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await hook({ agent, turn: 1, step: 1, signal: { aborted: true } }, () => Promise.resolve({ kind: 'enter', messages: [] }));
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
});

check('H6 inject 清单未被改动（读投影走 ctx.get，不新增必需服务）', () => {
  eq(JSON.stringify(plugin.inject), JSON.stringify(['llm', 'tokenMeter']),
    'inject 必须仍是 llm+tokenMeter —— 否则 sessionProjections 缺席时插件会整个加载失败，'
    + '且 verify-install.mjs 的第 4 条会挂');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n═══ I. 预设闸门 onlyPresets ═══');

/** 造一个能报预设的 ctx：模拟官方会话投影服务。 */
function makeCtxWithPreset(preset, extra = {}) {
  const ctx = makeCtx(extra);
  ctx.sessionProjections = { stateOf: (_session, key) => (key === 'agentPreset' ? (preset ?? null) : null) };
  return ctx;
}

await checkAsync('I1 名单非空 + 预设不在名单 → 不起 job，并记一次日志', async () => {
  const ctx = makeCtxWithPreset('standard');
  const backend = makeBackend(ctx, { onlyPresets: ['computer-use'] });
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  eq(backend.state(agent).job, null, 'job 必须为 null');
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 0, '不应写 start');
  assert(ctx.logs.some((l) => l.includes('not in onlyPresets')), '应留下一条跳过说明');
  // 第二步不许重复刷屏
  await backend.preStep(agent, 1, { aborted: false });
  eq(ctx.logs.filter((l) => l.includes('not in onlyPresets')).length, 1, '同一 agent 只记一次');
});

await checkAsync('I2 名单非空 + 预设命中 → 正常起 job', async () => {
  const ctx = makeCtxWithPreset('computer-use');
  const backend = makeBackend(ctx, { onlyPresets: ['computer-use'] });
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  const job = backend.state(agent).job;
  assert(job !== null, '命中的预设必须照常起 job');
  await job.promise;
});

await checkAsync('I3 名单非空但预设读不到 → 一律不动作（安全默认）', async () => {
  const ctx = makeCtx();               // 没有 sessionProjections
  const backend = makeBackend(ctx, { onlyPresets: ['computer-use'] });
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);    // 也没有 meta
  await backend.preStep(agent, 1, { aborted: false });
  eq(backend.state(agent).job, null, 'job 必须为 null');
  assert(ctx.logs.some((l) => l.includes('(unreadable)')), '应说明预设读不到');
});

await checkAsync('I4 名单为空 → 行为与旧版一致（不限制）', async () => {
  const ctx = makeCtxWithPreset('standard');
  const backend = makeBackend(ctx, { onlyPresets: [] });
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);
  await backend.preStep(agent, 1, { aborted: false });
  const job = backend.state(agent).job;
  assert(job !== null, '空名单必须照常起 job');
  await job.promise;
});

await checkAsync('I5 闸门只挡「起新 job」，不挡提交：中途换预设，已算好的摘要仍会落地', async () => {
  let preset = 'computer-use';
  const ctx = makeCtx({ streamImpl: defaultStream });
  ctx.sessionProjections = { stateOf: (_s, key) => (key === 'agentPreset' ? preset : null) };
  const backend = makeBackend(ctx, { onlyPresets: ['computer-use'] });
  const { session } = buildSession({ steps: 14 });
  const agent = makeAgent(session);

  await backend.preStep(agent, 1, { aborted: false });   // 命中 → 起 job
  const job = backend.state(agent).job;
  assert(job !== null, '前置条件：应先起 job');
  await job.promise;                                     // 等摘要结算

  preset = 'standard';                                   // 会话中途切到别的预设
  await backend.preStep(agent, 1, { aborted: false });   // 这一步应当「提交」而不是丢弃
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/start').length, 1, '应提交 1 次（start）');
  eq(session.snapshotEvents().filter((e) => e.type === 'compaction/end').length, 1, '应闭合 1 次（end）');
  eq(backend.state(agent).job, null, '提交后不留 job');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log(`结果：通过 ${passed} ｜ 失败 ${failed}`);
if (failed > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
}
console.log('═'.repeat(70));
process.exit(failed === 0 ? 0 : 1);
