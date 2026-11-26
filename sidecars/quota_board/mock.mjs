/**
 * Deterministic English mock snapshot generator for standalone previews & automated UI tests.
 * Uses the real `QuotaCollector` pipeline (`getSnapshot`) on realistic synthetic transcripts
 * so `quotaAudit`, percentages, session attribution, and Evidence rows are 100% authentic.
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

export function createMockSnapshot({ mode = 'audit' } = {}) {
  const isClean = mode === 'clean';
  const now = MOCK_NOW_MS;
  const tmp = mkdtempSync(join(tmpdir(), 'agy-qm-mock-'));

  try {
    const addConv = (id, title, rows) => {
      const dir = join(tmp, 'brain', id, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'transcript.jsonl'), rows.join('\n'), 'utf-8');
    };

    // Session 1 (Active): Rich realistic session (~3.8M est load) with 1 >60m idle, 1 switch, 1 sub-60m Carbon drop
    addConv(MOCK_ACTIVE_CONV_ID, 'Refactor Auth Middleware', [
      step('USER_INPUT', now - 190 * 60_000, { content: '<USER_REQUEST>Refactor Auth Middleware</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 189 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 45_000, cache_read_tokens: 240_000, output_tokens: 9_000 }),
      step('PLANNER_RESPONSE', now - 188 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 18_000, cache_read_tokens: 980_000, output_tokens: 16_000 }),
      step('USER_INPUT', now - 185 * 60_000, { content: '<USER_REQUEST>Add single-flight mutex around refresh rotation</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 184 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 14_000, cache_read_tokens: 1_240_000, output_tokens: 18_000 }),
      // Idle 76m -> >60m cold reload (+216k)
      step('USER_INPUT', now - 108 * 60_000, { content: '<USER_REQUEST>Handle rotated cookie grace window on parallel 401s</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 107 * 60_000, {
        model: 'gemini-4-neon-xhigh',
        input_tokens: isClean ? 9_000 : 240_000,
        cache_read_tokens: isClean ? 280_000 : 0,
        output_tokens: 8_400,
      }),
      // Switch Neon -> Carbon after 6m -> mid-thread switch reload (+225k)
      step('USER_INPUT', now - 101 * 60_000, { content: '<USER_REQUEST>Audit subtle race conditions under Redis failover</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 100 * 60_000, {
        model: isClean ? 'gemini-4-neon-xhigh' : 'gemini-4-carbon-high',
        input_tokens: isClean ? 7_000 : 250_000,
        cache_read_tokens: isClean ? 295_000 : 0,
        output_tokens: 9_200,
      }),
      // Warm steps followed by sub-60m Carbon drop (+234k)
      step('PLANNER_RESPONSE', now - 99 * 60_000, { model: isClean ? 'gemini-4-neon-xhigh' : 'gemini-4-carbon-high', input_tokens: 12_000, cache_read_tokens: 820_000, output_tokens: 12_000 }),
      step('USER_INPUT', now - 94 * 60_000, { content: '<USER_REQUEST>Fix cookie expiration race in test suite</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 93 * 60_000, {
        model: isClean ? 'gemini-4-neon-xhigh' : 'gemini-4-carbon-high',
        input_tokens: isClean ? 6_000 : 260_000,
        cache_read_tokens: isClean ? 310_000 : 0,
        output_tokens: 7_500,
      }),
    ]);

    // Session 2: Heavy Carbon capacity drop within 4m + >60m idle
    addConv('22222222-2222-3333-4444-bbbbbbbbbbbb', 'Stripe Webhook Worker', [
      step('USER_INPUT', now - 170 * 60_000, { content: '<USER_REQUEST>Stripe Webhook Worker</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 169 * 60_000, { model: 'gemini-4-carbon-high', input_tokens: 38_000, cache_read_tokens: 1_120_000, output_tokens: 14_000 }),
      step('USER_INPUT', now - 164 * 60_000, { content: '<USER_REQUEST>Replay failed dead-letter events idempotently</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 163 * 60_000, {
        model: 'gemini-4-carbon-high',
        input_tokens: isClean ? 8_000 : 280_000,
        cache_read_tokens: isClean ? 340_000 : 0,
        output_tokens: 9_000,
      }),
      step('PLANNER_RESPONSE', now - 162 * 60_000, { model: 'gemini-4-carbon-high', input_tokens: 11_000, cache_read_tokens: 920_000, output_tokens: 11_000 }),
      step('USER_INPUT', now - 40 * 60_000, { content: '<USER_REQUEST>Verify Postgres advisory lock timeout</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 39 * 60_000, {
        model: 'gemini-4-carbon-high',
        input_tokens: isClean ? 6_000 : 295_000,
        cache_read_tokens: isClean ? 360_000 : 0,
        output_tokens: 6_200,
      }),
    ]);

    // Session 3: Clean warm Neon session (~98% cache hit, zero waste)
    addConv('33333333-2222-3333-4444-cccccccccccc', 'Modbus TCP Frame Parser', [
      step('USER_INPUT', now - 90 * 60_000, { content: '<USER_REQUEST>Modbus TCP Frame Parser</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 89 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 24_000, cache_read_tokens: 1_450_000, output_tokens: 19_000 }),
      step('USER_INPUT', now - 82 * 60_000, { content: '<USER_REQUEST>Verify CRC-16 check on malformed coil frame</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 81 * 60_000, { model: 'gemini-4-neon-xhigh', input_tokens: 9_000, cache_read_tokens: 1_120_000, output_tokens: 12_500 }),
    ]);

    // Session 4: Small session with 1 >60m idle reload (+95k)
    addConv('44444444-2222-3333-4444-dddddddddddd', 'Postgres Index Migration', [
      step('USER_INPUT', now - 210 * 60_000, { content: '<USER_REQUEST>Postgres Index Migration</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 209 * 60_000, { model: 'gemini-4-neon-high', input_tokens: 18_000, cache_read_tokens: 620_000, output_tokens: 11_000 }),
      step('USER_INPUT', now - 110 * 60_000, { content: '<USER_REQUEST>Add CONCURRENTLY guard on partial index</USER_REQUEST>' }),
      step('PLANNER_RESPONSE', now - 109 * 60_000, {
        model: 'gemini-4-neon-high',
        input_tokens: isClean ? 4_500 : 105_000,
        cache_read_tokens: isClean ? 108_000 : 0,
        output_tokens: 5_200,
      }),
    ]);

    const collector = new QuotaCollector({ appDataDirs: [tmp], cacheFilePath: null });
    collector.triggerQuotaRefresh = () => Promise.resolve();

    const reset5h = now + (isClean ? 4.4 * HOUR : 2.1 * HOUR);
    const reset7d = now + (isClean ? 5.2 * 24 * HOUR : 3.6 * 24 * HOUR);
    const rawBuckets = [
      {
        id: 'gemini-5h',
        group: 'Gemini Models',
        isPrimaryGemini: true,
        window: '5h',
        shortWindowLabel: '5h',
        label: 'Gemini Models · 5h',
        remainingFraction: isClean ? 0.91 : 0.42,
        remainingPercent: isClean ? 91.0 : 42.0,
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
      fetchedAtMs: now - 14_000,
      creditsFetchedAtMs: now - 14_000,
      stale: false,
      errorMessage: '',
      cliHint: '',
      buckets: rawBuckets.map((b) => ({ ...b, pace: computePaceForecast(b, [], now) })),
      credits: { balance: 0, overageEnabled: null },
    };

    const snap = collector.getSnapshot({ conversationId: MOCK_ACTIVE_CONV_ID });
    return {
      ...snap,
      etag: `mock-v3-${mode}`,
      nowMs: now,
      formula: FORMULA_SPEC,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
