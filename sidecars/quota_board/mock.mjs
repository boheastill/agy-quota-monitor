/**
 * Deterministic English mock snapshot generator for standalone previews & automated UI tests.
 * Uses the real `parseTranscriptJsonl` and `computePaceForecast` math from `collector.mjs`.
 */

import {
  computeCacheHitRatio,
  computeEffectiveTokens,
  computePaceForecast,
  FORMULA_SPEC,
  parseTranscriptJsonl,
} from './collector.mjs';

const HOUR = 3_600_000;
export const MOCK_NOW_MS = Date.parse('2026-11-26T15:30:00Z');
export const MOCK_ACTIVE_CONV_ID = '11111111-2222-3333-4444-aaaaaaaaaaaa';

export function createMockSnapshot({ mode = 'healthy' } = {}) {
  const isBurst = mode === 'burst';
  const now = MOCK_NOW_MS;

  // Build active session from realistic JSONL steps so turn & cache-reload math is 100% genuine
  const activeJsonl = [
    JSON.stringify({
      type: 'USER_INPUT',
      created_at: new Date(now - 95 * 60_000).toISOString(),
      content: '<USER_REQUEST>Audit refresh token rotation flow for concurrent 401 race conditions</USER_REQUEST>',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date(now - 94 * 60_000).toISOString(),
      model: 'gemini-4-neon-high',
      input_tokens: 28_000,
      cache_read_tokens: 162_000,
      output_tokens: 4_800,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date(now - 93 * 60_000).toISOString(),
      model: 'gemini-4-neon-high',
      input_tokens: 6_000,
      cache_read_tokens: 192_000,
      output_tokens: 3_600,
    }),
    // Turn 2: 38-minute coffee/meeting break -> Prompt Cache TTL expired (`idle_ttl`, +178k wasted)
    JSON.stringify({
      type: 'USER_INPUT',
      created_at: new Date(now - 55 * 60_000).toISOString(),
      content: '<USER_REQUEST>Add single-flight mutex around token rotation and run auth tests</USER_REQUEST>',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date(now - 54 * 60_000).toISOString(),
      model: 'gemini-4-neon-high',
      input_tokens: 204_000,
      cache_read_tokens: 0,
      output_tokens: 9_200,
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date(now - 53 * 60_000).toISOString(),
      model: 'gemini-4-neon-high',
      input_tokens: 9_000,
      cache_read_tokens: 213_000,
      output_tokens: 5_400,
    }),
    // Turn 3: Switched from Neon -> Carbon after 2m -> Model switch cache reload (`model_switch`)
    JSON.stringify({
      type: 'USER_INPUT',
      created_at: new Date(now - 51 * 60_000).toISOString(),
      content: '<USER_REQUEST>Verify edge cases on expired refresh cookies under parallel load</USER_REQUEST>',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date(now - 50 * 60_000).toISOString(),
      model: 'gemini-4-carbon-high',
      input_tokens: isBurst ? 226_000 : 14_000,
      cache_read_tokens: isBurst ? 0 : 224_000,
      output_tokens: 7_800,
    }),
    // Turn 4: Warm cache hit (fast follow-up on same model)
    JSON.stringify({
      type: 'USER_INPUT',
      created_at: new Date(now - 48 * 60_000).toISOString(),
      content: '<USER_REQUEST>Clean up dead retry constants and export types</USER_REQUEST>',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: new Date(now - 47 * 60_000).toISOString(),
      model: 'gemini-4-carbon-high',
      input_tokens: isBurst ? 198_000 : 11_000,
      cache_read_tokens: isBurst ? 12_000 : 880_000,
      output_tokens: 6_200,
    }),
  ].join('\n');

  const parsedActive = parseTranscriptJsonl(activeJsonl);
  const activeSummary = {
    conversationId: MOCK_ACTIVE_CONV_ID,
    title: 'Refactor Auth Middleware',
    isSubagent: false,
    subagentCount: 1,
    turnCount: parsedActive.turns.length,
    plannerSteps: parsedActive.plannerSteps,
    models: parsedActive.models,
    updatedAt: now - 60_000,
    inputTokens: parsedActive.inputTokens,
    cacheReadTokens: parsedActive.cacheReadTokens,
    outputTokens: parsedActive.outputTokens,
    totalTokens: parsedActive.totalTokens,
    effectiveTokens: parsedActive.effectiveTokens,
    cacheHitRatio: parsedActive.cacheHitRatio,
    savedEffectiveTokens: parsedActive.savedEffectiveTokens,
    reloadCount: parsedActive.reloadCount,
    wastedEffectiveTokens: parsedActive.wastedEffectiveTokens,
    turns: parsedActive.turns,
    cacheReloads: parsedActive.cacheReloads.map((r) => ({
      ...r,
      conversationId: MOCK_ACTIVE_CONV_ID,
      sessionTitle: 'Refactor Auth Middleware',
      isCurrentSession: true,
    })),
  };

  function makeOther(id, title, turns, inp, cache, out, ageMin, extraReload = null) {
    const eff = computeEffectiveTokens(inp, cache, out);
    return {
      conversationId: id,
      title,
      isSubagent: false,
      subagentCount: 0,
      turnCount: turns,
      plannerSteps: turns * 3,
      models: ['gemini-4-neon-high'],
      updatedAt: now - ageMin * 60_000,
      inputTokens: inp,
      cacheReadTokens: cache,
      outputTokens: out,
      totalTokens: inp + cache + out,
      effectiveTokens: eff,
      cacheHitRatio: computeCacheHitRatio(inp, cache),
      savedEffectiveTokens: Math.round(cache * 0.9),
      reloadCount: extraReload ? 1 : 0,
      wastedEffectiveTokens: extraReload ? extraReload.wastedEffectiveTokens : 0,
      _extraReload: extraReload,
    };
  }

  const wsDropEvent = isBurst
    ? {
        turnIndex: 3,
        prompt: 'Replay missed heartbeat frames on socket reconnect',
        reason: 'early_drop',
        gapSec: 75,
        prevModel: 'gemini-4-neon-high',
        model: 'gemini-4-neon-high',
        reloadedTokens: 96_000,
        wastedEffectiveTokens: 86_400,
        atMs: now - 22 * 60_000,
        conversationId: '22222222-2222-3333-4444-bbbbbbbbbbbb',
        sessionTitle: 'Fix WebSocket Reconnect',
        isCurrentSession: false,
      }
    : null;

  const others = [
    makeOther('22222222-2222-3333-4444-bbbbbbbbbbbb', 'Fix WebSocket Reconnect', 6, 148_000, 1_420_000, 26_000, 24, wsDropEvent),
    makeOther('33333333-2222-3333-4444-cccccccccccc', 'Modbus TCP Frame Parser', 5, 96_000, 840_000, 18_500, 110),
    makeOther('44444444-2222-3333-4444-dddddddddddd', 'Stripe Webhook Retry Queue', 4, 72_000, 510_000, 11_200, 390),
    makeOther('55555555-2222-3333-4444-eeeeeeeeeeee', 'PostgreSQL Index Migration', 3, 42_000, 290_000, 7_400, 900),
    makeOther('66666666-2222-3333-4444-ffffffffffff', 'CI Pipeline Cache Tuning', 2, 24_000, 140_000, 4_600, 1500),
  ];

  const sessions = [activeSummary, ...others].map(({ _extraReload, turns, cacheReloads, ...rest }) => rest);
  sessions.sort((a, b) => b.effectiveTokens - a.effectiveTokens);

  const recent5h = [activeSummary, others[0], others[1]];
  const allEvents = [
    ...(wsDropEvent ? [wsDropEvent] : []),
    ...activeSummary.cacheReloads,
  ].sort((a, b) => (b.atMs || 0) - (a.atMs || 0));

  const byReason = { idle_ttl: 0, model_switch: 0, early_drop: 0 };
  for (const e of allEvents) {
    if (byReason[e.reason] !== undefined) byReason[e.reason] += 1;
  }

  const chInp = recent5h.reduce((a, s) => a + s.inputTokens, 0);
  const chCache = recent5h.reduce((a, s) => a + s.cacheReadTokens, 0);

  const reset5h = now + (isBurst ? 3.8 * HOUR : 4.55 * HOUR);
  const reset7d = now + (isBurst ? 4.2 * 24 * HOUR : 5.3 * 24 * HOUR);
  const reset3p5h = now + 4.95 * HOUR;
  const reset3p7d = now + 3.45 * 24 * HOUR;

  const history = isBurst
    ? [
        { ts: now - 60 * 60_000, buckets: { 'gemini-5h': { frac: 0.72, resetAtMs: reset5h }, 'gemini-weekly': { frac: 0.61, resetAtMs: reset7d } } },
        { ts: now - 30 * 60_000, buckets: { 'gemini-5h': { frac: 0.51, resetAtMs: reset5h }, 'gemini-weekly': { frac: 0.54, resetAtMs: reset7d } } },
        { ts: now, buckets: { 'gemini-5h': { frac: 0.34, resetAtMs: reset5h }, 'gemini-weekly': { frac: 0.46, resetAtMs: reset7d } } },
      ]
    : [
        { ts: now - 45 * 60_000, buckets: { 'gemini-5h': { frac: 0.94, resetAtMs: reset5h }, 'gemini-weekly': { frac: 0.892, resetAtMs: reset7d } } },
        { ts: now, buckets: { 'gemini-5h': { frac: 0.914, resetAtMs: reset5h }, 'gemini-weekly': { frac: 0.876, resetAtMs: reset7d } } },
      ];

  const rawBuckets = [
    {
      id: 'gemini-5h',
      group: 'Gemini Models',
      isPrimaryGemini: true,
      window: '5h',
      shortWindowLabel: '5h',
      label: 'Gemini Models · 5h',
      description: 'Models: Gemini 4 Carbon, Gemini 4 Neon, Gemini 4 Hydrogen',
      remainingFraction: isBurst ? 0.34 : 0.914,
      remainingPercent: isBurst ? 34.0 : 91.4,
      resetAtMs: reset5h,
      disabled: false,
    },
    {
      id: 'gemini-weekly',
      group: 'Gemini Models',
      isPrimaryGemini: true,
      window: 'weekly',
      shortWindowLabel: '7d',
      label: 'Gemini Models · Weekly (7d)',
      description: 'Shared 7-day rolling pool for Gemini models',
      remainingFraction: isBurst ? 0.46 : 0.876,
      remainingPercent: isBurst ? 46.0 : 87.6,
      resetAtMs: reset7d,
      disabled: false,
    },
    {
      id: '3p-5h',
      group: 'Claude and GPT models',
      isPrimaryGemini: false,
      window: '5h',
      shortWindowLabel: '5h',
      label: 'Claude & GPT · 5h',
      description: 'Claude Sonnet / Opus, GPT models',
      remainingFraction: isBurst ? 0.78 : 1.0,
      remainingPercent: isBurst ? 78.0 : 100.0,
      resetAtMs: reset3p5h,
      disabled: false,
    },
    {
      id: '3p-weekly',
      group: 'Claude and GPT models',
      isPrimaryGemini: false,
      window: 'weekly',
      shortWindowLabel: '7d',
      label: 'Claude & GPT · Weekly (7d)',
      description: 'Shared 7-day pool for third-party models',
      remainingFraction: isBurst ? 0.82 : 0.953,
      remainingPercent: isBurst ? 82.0 : 95.3,
      resetAtMs: reset3p7d,
      disabled: false,
    },
  ];

  const buckets = rawBuckets.map((b) => ({
    ...b,
    pace: computePaceForecast(b, history, now),
  }));

  return {
    etag: `mock-v21-${mode}`,
    nowMs: now,
    formula: FORMULA_SPEC,
    quota: {
      status: 'ok',
      refreshing: false,
      fetchedAtMs: now - 14_000,
      stale: false,
      errorMessage: '',
      buckets,
      credits: { balance: isBurst ? 120 : 0, overageEnabled: isBurst ? true : null },
    },
    cacheHealth: {
      scope: '5h',
      sessionCount: recent5h.length,
      hitRatio: computeCacheHitRatio(chInp, chCache),
      inputTokens: chInp,
      cacheReadTokens: chCache,
      savedEffectiveTokens: Math.round(chCache * 0.9),
      reloadCount: allEvents.length,
      wastedEffectiveTokens: allEvents.reduce((a, e) => a + e.wastedEffectiveTokens, 0),
      byReason,
      events: allEvents,
    },
    activeConversationId: MOCK_ACTIVE_CONV_ID,
    currentSession: activeSummary,
    sessions,
  };
}
