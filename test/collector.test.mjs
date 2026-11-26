import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  calibrateTokensPerPct5h,
  cleanPromptTitle,
  computeCacheHitRatio,
  computeEffectiveTokens,
  computePaceForecast,
  computeSessionLiveCoach,
  DEFAULT_TOKENS_PER_PCT_5H,
  extractJsonFromStdout,
  parseCreditsPayload,
  parseTranscriptJsonl,
  parseUsagePayload,
  QuotaCollector,
} from '../sidecars/quota_board/collector.mjs';
import { createMockSnapshot } from '../sidecars/quota_board/mock.mjs';

test('computeEffectiveTokens uses deterministic 1x / 0.1x / 4x weights', () => {
  assert.equal(computeEffectiveTokens(10_000, 50_000, 2_000), 23_000);
  assert.equal(computeEffectiveTokens(0, 0, 0), 0);
  assert.equal(Math.round(computeCacheHitRatio(20_000, 80_000) * 100), 80);
});

test('cleanPromptTitle strips Antigravity XML wrappers cleanly', () => {
  const raw = `<USER_REQUEST>\n研究一下当前的 AJY，看有没有插件\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is...\n</ADDITIONAL_METADATA>`;
  assert.equal(cleanPromptTitle(raw), '研究一下当前的 AJY，看有没有插件');
});

test('parseTranscriptJsonl aggregates turns, tracks live context weight, flags spikes, and extracts subagents', () => {
  const childId = '11111111-2222-3333-4444-555555555555';
  const lines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-22T07:00:00Z',
      content: '<USER_REQUEST>Build quota panel</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T07:00:05Z',
      model: 'gemini-4-carbon-high',
      input_tokens: 10_000,
      cache_read_tokens: 40_000,
      output_tokens: 1_000,
      tool_calls: [{ name: 'invoke_subagent', args: {} }],
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-22T07:00:10Z',
      content: `Subagent launched with conversationId: ${childId}`,
    }),
    JSON.stringify({
      step_index: 3,
      type: 'USER_INPUT',
      created_at: '2026-11-22T09:00:00Z',
      content: '<USER_REQUEST>Follow up after 2 hours</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T09:00:08Z',
      model: 'gemini-4-carbon-high',
      input_tokens: 60_000,
      cache_read_tokens: 0,
      output_tokens: 500,
      tool_calls: [{ name: 'read_file', args: {} }],
    }),
    JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-22T09:00:14Z',
      model: 'gemini-4-carbon-high',
      input_tokens: 2_000,
      cache_read_tokens: 61_000,
      output_tokens: 500,
    }),
  ].join('\n');

  const res = parseTranscriptJsonl(lines);
  assert.equal(res.firstPromptTitle, 'Build quota panel');
  assert.equal(res.currentContextTokens, 63_000);
  assert.equal(res.lastModel, 'gemini-4-carbon-high');
  assert.equal(res.lastStepAt, Date.parse('2026-11-22T09:00:14Z'));
  assert.equal(res.turns.length, 2);
  assert.equal(res.turns[0].cacheExpiredSpike, false);
  assert.equal(res.turns[1].cacheExpiredSpike, true);
  assert.equal(res.turns[1].cacheReload.reason, 'idle_ttl');
  assert.equal(res.turns[1].cacheReload.gapSec, 7195);
  assert.equal(res.turns[1].cacheReload.reloadedTokens, 50_000);
  assert.equal(res.turns[1].cacheReload.wastedEffectiveTokens, 45_000);
  assert.equal(res.reloadCount, 1);
  assert.equal(res.savedEffectiveTokens, Math.round(101_000 * 0.9));
  assert.deepEqual(res.childSubagentIds, [childId]);
});

test('calibrateTokensPerPct5h & computeSessionLiveCoach compute countdowns and remaining turns cleanly', () => {
  const t0 = Date.parse('2026-11-26T12:00:00Z');
  const resetAtMs = t0 + 4 * 3_600_000;

  // Fallback before >=2% drop
  const uncal = calibrateTokensPerPct5h([], []);
  assert.equal(uncal.calibrated, false);
  assert.equal(uncal.tokensPerPct, DEFAULT_TOKENS_PER_PCT_5H);

  // 5% drop over 30m with 1,400,000 effective Gemini tokens -> 280,000 tokens per 1%
  const history = [
    { ts: t0, buckets: { 'gemini-5h': { frac: 0.90, resetAtMs } } },
    { ts: t0 + 30 * 60_000, buckets: { 'gemini-5h': { frac: 0.85, resetAtMs } } },
  ];
  const fakeSessions = [
    {
      metrics: {
        turns: [
          { model: 'gemini-4-neon-xhigh', endedAt: t0 + 10 * 60_000, effectiveTokens: 800_000 },
          { model: 'gemini-4-carbon-high', endedAt: t0 + 25 * 60_000, effectiveTokens: 600_000 },
        ],
      },
    },
  ];
  const cal = calibrateTokensPerPct5h(history, fakeSessions);
  assert.equal(cal.calibrated, true);
  assert.equal(cal.tokensPerPct, 280_000);

  const metrics = {
    currentContextTokens: 320_000,
    lastStepAt: t0 + 30 * 60_000,
    lastModel: 'gemini-4-neon-xhigh',
    plannerSteps: 6,
    outputTokens: 7_200,
    turns: [{ steps: 3 }, { steps: 3 }],
  };
  const bucket5h = { remainingPercent: 50, disabled: false };

  // 10m after last step -> 50m left on cache -> 'warm'
  const warmCoach = computeSessionLiveCoach(metrics, {
    nowMs: t0 + 40 * 60_000,
    gemini5hBucket: bucket5h,
    calibration: cal,
  });
  assert.equal(warmCoach.cacheState, 'warm');
  assert.equal(warmCoach.cacheRemainingSec, 50 * 60);
  assert.equal(warmCoach.weightMultiple, 16);
  assert.equal(warmCoach.weightTier, 'very_heavy');
  assert.ok(warmCoach.turnsLeft.fresh > warmCoach.turnsLeft.warm);
  assert.ok(warmCoach.turnsLeft.warm > warmCoach.turnsLeft.cold);

  // 52m after last step -> 8m left on cache -> 'expiring'
  const expCoach = computeSessionLiveCoach(metrics, {
    nowMs: t0 + 82 * 60_000,
    gemini5hBucket: bucket5h,
    calibration: cal,
  });
  assert.equal(expCoach.cacheState, 'expiring');
  assert.equal(expCoach.cacheRemainingSec, 8 * 60);

  // 75m after last step -> 0s left -> 'expired'
  const deadCoach = computeSessionLiveCoach(metrics, {
    nowMs: t0 + 105 * 60_000,
    gemini5hBucket: bucket5h,
    calibration: cal,
  });
  assert.equal(deadCoach.cacheState, 'expired');
  assert.equal(deadCoach.cacheRemainingSec, 0);
});

test('parseUsagePayload orders Gemini 5h before 7d and separates secondary groups', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  const rawStdout = JSON.stringify({
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Claude and GPT models',
            buckets: [{ id: '3p-weekly', window: 'weekly', remaining_fraction: 0.95, reset_in_seconds: 86400 }],
          },
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Carbon',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, reset_time: '2026-11-28T09:19:13Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.965, reset_in_seconds: 3600 },
            ],
          },
        ],
      },
    },
  });

  const buckets = parseUsagePayload(extractJsonFromStdout(rawStdout), now);
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].id, 'gemini-5h');
  assert.equal(buckets[0].isPrimaryGemini, true);
  assert.equal(buckets[1].id, 'gemini-weekly');
  assert.equal(buckets[1].isPrimaryGemini, true);
  assert.equal(buckets[2].id, '3p-weekly');
  assert.equal(buckets[2].isPrimaryGemini, false);

  const credits = parseCreditsPayload({
    status: 'SUCCESS',
    command: { name: 'credits', data: { remaining_credits: 0 } },
  });
  assert.deepEqual(credits, { balance: 0, overageEnabled: null });
});

test('computePaceForecast calculates 7d time-pace marker and EWMA 5h burst runout ETA', () => {
  const hour = 3_600_000;
  const now = 1_700_000_000_000;

  const weeklyBucket = {
    id: 'gemini-weekly',
    window: 'weekly',
    remainingFraction: 0.876,
    remainingPercent: 87.6,
    resetAtMs: now + 127 * hour,
    disabled: false,
  };
  const weeklyPace = computePaceForecast(weeklyBucket, [], now);
  assert.equal(weeklyPace.windowKind, '7d');
  assert.ok(Math.abs(weeklyPace.timeRemainingFraction - 127 / 168) < 0.001);
  assert.equal(weeklyPace.willExhaustBeforeReset, false);

  const resetAtMs = now + 4 * hour;
  const history = [
    { ts: now - 60 * 60_000, buckets: { 'gemini-5h': { frac: 0.8, resetAtMs } } },
    { ts: now - 30 * 60_000, buckets: { 'gemini-5h': { frac: 0.55, resetAtMs } } },
    { ts: now, buckets: { 'gemini-5h': { frac: 0.3, resetAtMs } } },
  ];
  const burstBucket = {
    id: 'gemini-5h',
    window: '5h',
    remainingFraction: 0.3,
    remainingPercent: 30,
    resetAtMs,
    disabled: false,
  };
  const burstPace = computePaceForecast(burstBucket, history, now);
  assert.equal(burstPace.windowKind, '5h');
  assert.equal(burstPace.willExhaustBeforeReset, true);
});

test('QuotaCollector rolls up child subagents into parent session without double counting', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agy-qm-test-'));
  try {
    const parentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const childId = '99999999-8888-7777-6666-555555555555';

    const parentLogDir = join(tmp, 'brain', parentId, '.system_generated', 'logs');
    const childLogDir = join(tmp, 'brain', childId, '.system_generated', 'logs');
    mkdirSync(parentLogDir, { recursive: true });
    mkdirSync(childLogDir, { recursive: true });

    writeFileSync(
      join(parentLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Parent session task' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-carbon-high',
          input_tokens: 10_000,
          cache_read_tokens: 0,
          output_tokens: 1_000,
          tool_calls: [{ name: 'invoke_subagent' }],
        }),
        JSON.stringify({ type: 'GENERIC', content: `Spawned ${childId}` }),
      ].join('\n')
    );

    writeFileSync(
      join(childLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Subagent worker prompt' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-flash',
          input_tokens: 5_000,
          cache_read_tokens: 10_000,
          output_tokens: 500,
        }),
      ].join('\n')
    );

    const collector = new QuotaCollector({ appDataDirs: [tmp], cacheFilePath: null });
    collector.triggerQuotaRefresh = () => Promise.resolve();

    const snap = collector.getSnapshot({ conversationId: parentId });
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.currentSession.subagentCount, 1);
    assert.equal(snap.currentSession.inputTokens, 15_000);
    assert.equal(snap.currentSession.cacheReadTokens, 10_000);
    assert.equal(snap.currentSession.outputTokens, 1_500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock snapshots expose live context weight, expiring alerts, turns left, and verifiable reloads', () => {
  const mockAudit = createMockSnapshot({ mode: 'audit' });
  assert.equal(mockAudit.currentSession.live.cacheState, 'expiring');
  assert.ok(mockAudit.currentSession.live.contextTokens > 300_000);
  assert.ok(mockAudit.currentSession.live.turnsLeft.fresh > mockAudit.currentSession.live.turnsLeft.warm);
  assert.ok(mockAudit.currentSession.live.turnsLeft.warm > mockAudit.currentSession.live.turnsLeft.cold);
  assert.equal(mockAudit.expiringOtherSessions.length, 1);
  assert.ok(mockAudit.quotaAudit.findings.length >= 2);

  const mockExpired = createMockSnapshot({ mode: 'expired' });
  assert.equal(mockExpired.currentSession.live.cacheState, 'expired');

  const mockClean = createMockSnapshot({ mode: 'clean' });
  assert.equal(mockClean.currentSession.live.cacheState, 'warm');
  assert.equal(mockClean.quotaAudit.totalWastedEffectiveTokens, 0);
});

test('index.html and app.js static DOM IDs stay 100% synchronized', () => {
  const boardDir = join(__dirname, '..', 'sidecars', 'quota_board');
  const html = readFileSync(join(boardDir, 'index.html'), 'utf-8');
  const js = readFileSync(join(boardDir, 'app.js'), 'utf-8');

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const dynamicIds = new Set([
    'btn-copy-cmd',
    'btn-toggle-sec',
    'cli-cmd',
    'btn-copy-handoff',
    'live-cache-banner',
    'live-cache-title',
    'live-cache-sub',
    'btn-toggle-leaks',
  ]);
  const referencedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

  for (const id of referencedIds) {
    if (dynamicIds.has(id)) continue;
    assert.ok(htmlIds.has(id), `Missing id="${id}" in index.html required by app.js`);
  }
});
