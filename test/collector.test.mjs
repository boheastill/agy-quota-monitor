import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanPromptTitle,
  computeCacheHitRatio,
  computeEffectiveTokens,
  extractJsonFromStdout,
  parseCreditsPayload,
  parseTranscriptJsonl,
  parseUsagePayload,
  QuotaCollector,
} from '../sidecars/quota_board/collector.mjs';

test('computeEffectiveTokens uses deterministic 1x / 0.1x / 4x weights', () => {
  // 10,000 * 1 + 50,000 * 0.1 + 2,000 * 4 = 10,000 + 5,000 + 8,000 = 23,000
  assert.equal(computeEffectiveTokens(10_000, 50_000, 2_000), 23_000);
  assert.equal(computeEffectiveTokens(0, 0, 0), 0);
  assert.equal(Math.round(computeCacheHitRatio(20_000, 80_000) * 100), 80);
});

test('cleanPromptTitle strips Antigravity XML wrappers cleanly', () => {
  const raw = `<USER_REQUEST>\n研究一下当前的 AJY，看有没有插件\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is...\n</ADDITIONAL_METADATA>`;
  assert.equal(cleanPromptTitle(raw), '研究一下当前的 AJY，看有没有插件');
});

test('parseTranscriptJsonl aggregates turns, flags cache-expiry spikes, and extracts subagents', () => {
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
  assert.equal(res.turns.length, 2);
  assert.equal(res.turns[0].cacheExpiredSpike, false);
  assert.equal(res.turns[1].cacheExpiredSpike, true, 'First step cache miss in Turn 2+ should be flagged even if subsequent steps hit cache');
  assert.deepEqual(res.childSubagentIds, [childId]);
  assert.equal(res.inputTokens, 72_000);
  assert.equal(res.cacheReadTokens, 101_000);
  assert.equal(res.outputTokens, 2_000);
  assert.equal(res.effectiveTokens, computeEffectiveTokens(72_000, 101_000, 2_000));
});

test('parseUsagePayload normalizes real agy v1.5+ command.data envelopes and quota maps', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  const rawStdout = JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.917245, reset_time: '2026-11-28T09:19:13Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.963661, reset_in_seconds: 3600 },
            ],
          },
        ],
      },
    },
  });

  const json = extractJsonFromStdout(rawStdout);
  const buckets = parseUsagePayload(json, now);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].label, 'Gemini Models · Weekly (7d)');
  assert.equal(buckets[0].remainingPercent, 91.72);
  assert.match(buckets[0].description, /Gemini 4 Carbon/);
  assert.equal(buckets[1].label, 'Gemini Models · 5h');
  assert.equal(buckets[1].remainingPercent, 96.37);
  assert.equal(buckets[1].resetAtMs, now + 3600 * 1000);

  const creditsEnvelope = {
    status: 'SUCCESS',
    command: {
      name: 'credits',
      data: { remaining_credits: 42, upgrade_uri: 'https://antigravity.google/g1-upgrade' },
    },
  };
  const credits = parseCreditsPayload(creditsEnvelope);
  assert.deepEqual(credits, { balance: 42, overageEnabled: null });
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
    // Stub CLI refresh so unit test stays purely offline
    collector.triggerQuotaRefresh = () => Promise.resolve();

    const snap = collector.getSnapshot({ conversationId: parentId });
    assert.equal(snap.sessions.length, 1, 'Child subagent should not appear as separate top-level row');
    assert.equal(snap.currentSession.subagentCount, 1);
    assert.equal(snap.currentSession.inputTokens, 15_000);
    assert.equal(snap.currentSession.cacheReadTokens, 10_000);
    assert.equal(snap.currentSession.outputTokens, 1_500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
