/**
 * Deterministic English mock snapshot generator for standalone previews & automated UI tests.
 * Uses the real `QuotaCollector` pipeline (`getSnapshot`) on realistic synthetic transcripts
 * so live context weight, 60m cache countdowns, calibrated remaining turns, and past leaks are 100% authentic.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computePaceForecast,
  FORMULA_SPEC,
  QuotaCollector,
} from './collector.mjs';

const HOUR = 3_600_000;
export const MOCK_NOW_MS = Date.parse('2026-11-26T15:30:00Z');
export const MOCK_ACTIVE_CONV_ID = '11111111-2222-3333-4444-aaaaaaaaaaaa';

function step(type, tsMs, extra = {}) {
  return JSON.stringify({ type, created_at: new Date(tsMs).toISOString(), ...extra });
}

/**
 * Supported preview modes:
 * - `'audit'` / `'expiring'` (default): Active heavy chat (316k) has 8m 40s left before 60m cache expiry + 1 other chat expiring in 14m.
 * - `'expired'`: Active heavy chat (342k) paused 1h 18m — cache already expired (10x cold reload warning) + past leaks verifiable.
 * - `'clean'`: Active medium-heavy chat (195k) warm with 46m left on cache, 88% 5h quota, 0 cold reloads.
 */
export function createMockSnapshot({ mode = 'audit' } = {}) {
  const isClean = mode === 'clean';
  const isExpired = mode === 'expired';
  const now = MOCK_NOW_MS;
  const tmp = mkdtempSync(join(tmpdir(), 'agy-qm-mock-'));

  try {
    const addConv = (id, rows) => {
      const dir = join(tmp, 'brain', id, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'transcript.jsonl'), rows.join('\n'), 'utf-8');
    };

    const lastActiveAgeMs = isClean
      ? 14 * 60_000
      : isExpired
      ? 78 * 60_000
      : 51 * 60_000 + 20_000; // 8m 40s left on 60m cache timer

    // Session 1 (Active): "Refactor Auth Middleware" (~316k context weight, ~3 steps/turn)
    addConv(MOCK_ACTIVE_CONV_ID, [
      step('USER_INPUT', now - 220 * 60_000, { content: '<USER_REQUEST>Refactor Auth Middleware</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 219 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 42_000, cache_read_tokens: 180_000, output_tokens: 4_200 }),
      step('PLANNER_RESPONSE', now - 218 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 12_000, cache_read_tokens: 222_000, output_tokens: 5_100 }),
      step('PLANNER_RESPONSE', now - 217 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 8_000, cache_read_tokens: 234_000, output_tokens: 4_800 }),
      // Idle 74m -> >60m cold reload (+218k) unless clean
      step('USER_INPUT', now - 143 * 60_000, { content: '<USER_REQUEST>Handle rotated cookie grace window on parallel 401s</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 142 * 60_000, {
        model: 'gemini-4-neon-xhigh',
        input_tokens: isClean ? 9_000 : 246_000,
        cache_read_tokens: isClean ? 242_000 : 0,
        output_tokens: 4_600,
      }),
      step('PLANNER_RESPONSE', now - 141 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 9_000, cache_read_tokens: 255_000, output_tokens: 3_900 }),
      // Switch Neon -> Carbon -> model_switch cold reload (+238k) unless clean
      step('USER_INPUT', now - 132 * 60_000, { content: '<USER_REQUEST>Audit subtle race conditions under Redis failover</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 131 * 60_000, {
        model: isClean ? 'gemini-4-neon-xhigh' : 'gemini-4-carbon-high',
        input_tokens: isClean ? 7_000 : 272_000,
        cache_read_tokens: isClean ? 264_000 : 0,
        output_tokens: 5_400,
      }),
      step('PLANNER_RESPONSE', now - 130 * 60_000, {
        model: isClean ? 'gemini-4-neon-xhigh' : 'gemini-4-carbon-high',
        input_tokens: 11_000,
        cache_read_tokens: 280_000,
        output_tokens: 4_200,
      }),
      // Latest turn (sets current context weight + live cache timer)
      step('USER_INPUT', now - lastActiveAgeMs - 45_000, { content: '<USER_REQUEST>Fix cookie expiration race in auth concurrency suite</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - lastActiveAgeMs - 20_000, {
        model: 'gemini-4-neon-xhigh',
        input_tokens: isClean ? 6_000 : 296_000,
        cache_read_tokens: isClean ? 182_000 : 0,
        output_tokens: 4_100,
      }),
      step('PLANNER_RESPONSE', now - lastActiveAgeMs, {
        model: 'gemini-4-neon-xhigh',
        input_tokens: 8_000,
        cache_read_tokens: isClean ? 187_000 : isExpired ? 334_000 : 308_000,
        output_tokens: 3_800,
      }),
    ]);

    // Session 2: "Stripe Webhook Worker" (355k context, 46m idle -> 14m left on cache!)
    addConv('22222222-2222-3333-4444-bbbbbbbbbbbb', [
      step('USER_INPUT', now - 170 * 60_000, { content: '<USER_REQUEST>Stripe Webhook Worker</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 169 * 60_000, { model: 'gemini-4-carbon-high', input_tokens: 38_000, cache_read_tokens: 260_000, output_tokens: 5_000 }),
      step('USER_INPUT', now - 163 * 60_000, { content: '<USER_REQUEST>Replay failed dead-letter events idempotently</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 162 * 60_000, {
        model: 'gemini-4-carbon-high',
        input_tokens: isClean ? 8_000 : 305_000,
        cache_read_tokens: isClean ? 298_000 : 0,
        output_tokens: 4_800,
      }),
      step('USER_INPUT', now - (isClean || isExpired ? 96 : 47) * 60_000, { content: '<USER_REQUEST>Verify Postgres advisory lock timeout</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - (isClean || isExpired ? 95 : 46) * 60_000, {
        model: 'gemini-4-carbon-high',
        input_tokens: isClean ? 6_000 : 320_000,
        cache_read_tokens: isClean ? 310_000 : 0,
        output_tokens: 4_200,
      }),
      step('PLANNER_RESPONSE', now - (isClean || isExpired ? 94 : 46) * 60_000, {
        model: 'gemini-4-carbon-high',
        input_tokens: 9_000,
        cache_read_tokens: 346_000,
        output_tokens: 3_600,
      }),
    ]);

    // Session 3: "Modbus TCP Frame Parser" (clean warm Neon session, 24m idle -> 36m left)
    addConv('33333333-2222-3333-4444-cccccccccccc', [
      step('USER_INPUT', now - 35 * 60_000, { content: '<USER_REQUEST>Modbus TCP Frame Parser</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 34 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 22_000, cache_read_tokens: 140_000, output_tokens: 4_500 }),
      step('USER_INPUT', now - 25 * 60_000, { content: '<USER_REQUEST>Verify CRC-16 check on malformed coil frame</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 24 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 7_000, cache_read_tokens: 168_000, output_tokens: 3_800 }),
    ]);

    // Session 4: "Postgres Index Migration" (older expired chat, 2h idle)
    addConv('44444444-2222-3333-4444-dddddddddddd', [
      step('USER_INPUT', now - 210 * 60_000, { content: '<USER_REQUEST>Postgres Index Migration</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 209 * 60_000, { model: 'gemini-4-neon-high', input_tokens: 18_000, cache_read_tokens: 92_000, output_tokens: 3_600 }),
      step('USER_INPUT', now - 122 * 60_000, { content: '<USER_REQUEST>Add CONCURRENTLY guard on partial index</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 121 * 60_000, {
        model: 'gemini-4-neon-high',
        input_tokens: isClean ? 4_500 : 114_000,
        cache_read_tokens: isClean ? 112_000 : 0,
        output_tokens: 3_200,
      }),
    ]);

    const collector = new QuotaCollector({ appDataDirs: [tmp], cacheFilePath: null });
    collector.triggerQuotaRefresh = () => Promise.resolve();

    const reset5h = now + (isClean ? 4.2 * HOUR : 2.1 * HOUR);
    const reset7d = now + (isClean ? 5.2 * 24 * HOUR : 3.6 * 24 * HOUR);
    const rem5hFrac = isClean ? 0.88 : isExpired ? 0.34 : 0.45;

    // Realistic history samples so `calibrateTokensPerPct5h` calibrates cleanly
    collector.quotaHistory = [
      {
        ts: now - 225 * 60_000,
        buckets: {
          'gemini-5h': { frac: isClean ? 0.96 : 0.56, resetAtMs: reset5h },
          'gemini-weekly': { frac: isClean ? 0.90 : 0.64, resetAtMs: reset7d },
        },
      },
      {
        ts: now - 10 * 60_000,
        buckets: {
          'gemini-5h': { frac: rem5hFrac, resetAtMs: reset5h },
          'gemini-weekly': { frac: isClean ? 0.88 : 0.61, resetAtMs: reset7d },
        },
      },
    ];

    const rawBuckets = [
      {
        id: 'gemini-5h',
        group: 'Gemini Models',
        isPrimaryGemini: true,
        window: '5h',
        shortWindowLabel: '5h',
        label: 'Gemini Models · 5h',
        remainingFraction: rem5hFrac,
        remainingPercent: Number((rem5hFrac * 100).toFixed(1)),
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
        remainingFraction: isClean ? 0.88 : 0.61,
        remainingPercent: isClean ? 88.0 : 61.0,
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
        remainingFraction: 1.0,
        remainingPercent: 100.0,
        resetAtMs: now + 4.9 * HOUR,
        disabled: false,
      },
      {
        id: '3p-weekly',
        group: 'Claude and GPT models',
        isPrimaryGemini: false,
        window: 'weekly',
        shortWindowLabel: '7d',
        label: 'Claude & GPT · Weekly (7d)',
        remainingFraction: 0.95,
        remainingPercent: 95.0,
        resetAtMs: now + 4.1 * 24 * HOUR,
        disabled: false,
      },
    ];

    collector.quotaState = {
      status: 'ok',
      refreshing: false,
      fetchedAtMs: now - 12_000,
      creditsFetchedAtMs: now - 12_000,
      stale: false,
      errorMessage: '',
      cliHint: '',
      buckets: rawBuckets.map((b) => ({ ...b, pace: computePaceForecast(b, collector.quotaHistory, now) })),
      credits: { balance: 0, overageEnabled: null },
    };

    const snap = collector.getSnapshot({ conversationId: MOCK_ACTIVE_CONV_ID, nowMs: now });
    return {
      ...snap,
      etag: `mock-v31-${mode}`,
      nowMs: now,
      formula: FORMULA_SPEC,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
