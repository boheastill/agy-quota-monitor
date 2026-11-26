/**
 * Core data engine for Antigravity Quota Monitor v2.0 (pure Node.js stdlib, zero dependencies).
 *
 * Responsibilities:
 * 1. Cloud Quota & EWMA Pace Engine (Read-only via official `agy` CLI):
 *    - Executes `agy -p "/usage" --output-format json` and `/credits` sequentially in background.
 *    - Maintains a compact (<4 KB, max 60 points) ring buffer of historical snapshots to compute
 *      exponentially time-weighted (EWMA half-life) burn rates, runout ETAs, and 7d time-pace markers.
 *
 * 2. Local Session Workload Analyzer (Read-only via `transcript.jsonl`):
 *    - Reads `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` with
 *      bounded mtime + byte-size caching, rolling up subagent usage (`invoke_subagent`), resolving
 *      short sidebar titles via `agentapi`, and computing weighted Effective Token load.
 *
 * Nothing in this module ever mutates Antigravity state, conversations, or user settings.
 */

import { execFile } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const IS_WIN = platform() === 'win32';
const CONV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIND_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * Weighted Effective Token formula constants:
 * - Uncached input: 1.0x baseline
 * - Prompt cache read: 0.1x (~90% discount)
 * - Thinking + output: 4.0x
 */
export const WEIGHTS = Object.freeze({
  input: 1.0,
  cacheRead: 0.1,
  output: 4.0,
});

export const FORMULA_SPEC = Object.freeze({
  id: 'standard-effective-v1',
  weights: WEIGHTS,
  expression: 'input × 1 + cache_read × 0.1 + output × 4',
});

const HOUR_MS = 3_600_000;
const IDLE_QUOTA_TTL_MS = 5 * 60 * 1000;      // 5 min fallback refresh while pane is open
const CREDITS_TTL_MS = 15 * 60 * 1000;        // Refresh credits every 15 min (unless forced)
const MIN_MANUAL_REFRESH_MS = 3 * 1000;       // 3s anti-spam throttle on manual button clicks
const POST_TURN_SETTLE_MS = 3500;             // Wait 3.5s after a new model step lands before querying cloud quota
const CLI_TIMEOUT_MS = 45_000;                // Headless `agy -p` cold start safety budget
const MAX_HISTORY_POINTS = 60;                // Ring buffer cap for EWMA burn-rate history (<4 KB on disk)
const MIN_HISTORY_SAMPLE_GAP_MS = 60_000;     // Record at most 1 history sample per minute
const MAX_SCANNED_CONVERSATIONS = 60;
const MAX_TRANSCRIPT_CACHE = 120;
const MAX_TITLE_CACHE = 200;
const CACHE_SPIKE_THRESHOLD_TOKENS = 25_000;
const IDLE_CACHE_TTL_SEC = 3600;              // Empirically verified 60m hard prompt-cache TTL in Antigravity
const CACHE_EXPIRING_SOON_SEC = 15 * 60;      // Warn when <= 15m left before 60m cache cliff
const LIGHT_CONTEXT_THRESHOLD_TOKENS = 25_000;
export const BASELINE_FRESH_CONTEXT_TOKENS = 20_000; // Clean new chat (system prompt + tools + ~2k handoff brief)
export const DEFAULT_TOKENS_PER_PCT_5H = 300_000;    // Empirically measured ~30M effective-token 5h Gemini pool
const CACHE_SAVINGS_FACTOR = WEIGHTS.input - WEIGHTS.cacheRead; // 0.9x load saved per cached token

/**
 * Compute weighted effective tokens from raw token counts.
 */
export function computeEffectiveTokens(inputTokens = 0, cacheReadTokens = 0, outputTokens = 0) {
  const inp = Math.max(0, Number(inputTokens) || 0);
  const cache = Math.max(0, Number(cacheReadTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  return Math.round(inp * WEIGHTS.input + cache * WEIGHTS.cacheRead + out * WEIGHTS.output);
}

/**
 * Compute prompt cache hit ratio (0..1) over total prompt context tokens.
 */
export function computeCacheHitRatio(inputTokens = 0, cacheReadTokens = 0) {
  const inp = Math.max(0, Number(inputTokens) || 0);
  const cache = Math.max(0, Number(cacheReadTokens) || 0);
  const denom = inp + cache;
  return denom > 0 ? cache / denom : 0;
}

/**
 * Extract a clean, concise single-line title from raw USER_INPUT content.
 */
export function cleanPromptTitle(rawContent = '', maxLen = 42) {
  const text = String(rawContent ?? '');
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  let body = reqMatch ? reqMatch[1] : text;
  body = body
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return '';
  return body.length > maxLen ? `${body.slice(0, maxLen - 1).trimEnd()}…` : body;
}

/**
 * Infer canonical window duration in milliseconds (`5h`, `7d`, `24h`) from bucket metadata.
 */
export function inferWindowDurationMs(windowStr = '', idStr = '') {
  const combined = `${windowStr} ${idStr}`.toLowerCase();
  if (/\b5h(r|ours?)?\b/.test(combined)) return 5 * HOUR_MS;
  if (/\b(weekly|week|7d|1w)\b/.test(combined)) return 7 * 24 * HOUR_MS;
  if (/\b(daily|24h|1d)\b/.test(combined)) return 24 * HOUR_MS;
  return null;
}

/**
 * Compute Exponentially Time-Weighted Moving Average (EWMA half-life) burn rate & runout forecast.
 *
 * Formula over irregular sample intervals [t_{i-1}, t_i]:
 *   decay_i = 2^(-(nowMs - t_mid) / halfLifeMs)
 *   ewmaRatePerHour = sum(decay_i * deltaUsed_i) / sum(decay_i * deltaHours_i)
 *
 * Blends cycle-elapsed baseline rate with recent EWMA rate:
 * - `5h` pool uses a 30-minute half-life (responsive to active coding bursts).
 * - `7d` pool uses a 12-hour half-life blended with the 7-day cycle baseline + Time-Pace marker.
 */
export function computePaceForecast(bucket, history = [], nowMs = Date.now()) {
  if (!bucket || bucket.disabled) return null;

  const windowMs = inferWindowDurationMs(bucket.window, bucket.id);
  const isShortWindow = windowMs !== null && windowMs <= 6 * HOUR_MS;
  const halfLifeMs = isShortWindow ? 0.5 * HOUR_MS : 12 * HOUR_MS;

  let timeRemainingFraction = null;
  let paceDeltaPercent = null;
  let remainingHours = null;
  let baselineRatePerHour = null;

  if (windowMs && bucket.resetAtMs) {
    const remMs = Math.max(0, Math.min(windowMs, bucket.resetAtMs - nowMs));
    const elapsedMs = Math.max(0, windowMs - remMs);
    remainingHours = remMs / HOUR_MS;
    timeRemainingFraction = Number((remMs / windowMs).toFixed(4));
    paceDeltaPercent = Number(((bucket.remainingFraction - timeRemainingFraction) * 100).toFixed(1));

    // Once at least 5 minutes into the window, cycle baseline rate is well-defined
    if (elapsedMs >= 5 * 60_000) {
      const usedFrac = Math.max(0, 1 - bucket.remainingFraction);
      baselineRatePerHour = usedFrac / (elapsedMs / HOUR_MS);
    }
  }

  // Compute continuous-time half-life EWMA burn rate from ring buffer samples in the SAME reset cycle
  let weightedUsed = 0;
  let weightedHours = 0;
  const maxLookbackMs = halfLifeMs * 5;

  if (Array.isArray(history) && history.length >= 2) {
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      const dtMs = (curr?.ts || 0) - (prev?.ts || 0);
      if (dtMs < 15_000 || nowMs - curr.ts > maxLookbackMs) continue;

      const bPrev = prev.buckets?.[bucket.id];
      const bCurr = curr.buckets?.[bucket.id];
      if (!bPrev || !bCurr) continue;

      // Skip across window resets (resetAtMs jumped forward or fraction jumped up)
      if (bPrev.resetAtMs && bCurr.resetAtMs && Math.abs(bCurr.resetAtMs - bPrev.resetAtMs) > 10 * 60_000) {
        continue;
      }
      if (bCurr.frac > bPrev.frac + 0.002) continue;

      const deltaUsed = Math.max(0, bPrev.frac - bCurr.frac);
      const dtHours = dtMs / HOUR_MS;
      const midTs = (prev.ts + curr.ts) / 2;
      const decay = Math.pow(2, -Math.max(0, nowMs - midTs) / halfLifeMs);

      weightedUsed += decay * deltaUsed;
      weightedHours += decay * dtHours;
    }
  }

  const ewmaRatePerHour = weightedHours > 0.02 ? weightedUsed / weightedHours : null;

  // Smoothly blend baseline rate and recent EWMA rate based on observed EWMA coverage
  let effectiveRatePerHour = 0;
  if (ewmaRatePerHour !== null && baselineRatePerHour !== null) {
    const ewmaTargetSpanHours = isShortWindow ? 0.5 : 6.0;
    const maxEwmaShare = isShortWindow ? 0.85 : 0.65;
    const alpha = Math.min(maxEwmaShare, (weightedHours / ewmaTargetSpanHours) * maxEwmaShare);
    effectiveRatePerHour = alpha * ewmaRatePerHour + (1 - alpha) * baselineRatePerHour;
  } else if (ewmaRatePerHour !== null) {
    effectiveRatePerHour = ewmaRatePerHour;
  } else if (baselineRatePerHour !== null) {
    effectiveRatePerHour = baselineRatePerHour;
  }

  let willExhaustBeforeReset = false;
  let estimatedTimeLeftSec = null;
  let projectedRemainingPercent = null;

  if (remainingHours !== null) {
    if (effectiveRatePerHour > 1e-6) {
      const hoursToZero = bucket.remainingFraction / effectiveRatePerHour;
      if (hoursToZero < remainingHours * 0.98) {
        willExhaustBeforeReset = true;
        estimatedTimeLeftSec = Math.max(60, Math.round(hoursToZero * 3600));
      } else {
        const projFrac = Math.max(0, Math.min(1, bucket.remainingFraction - effectiveRatePerHour * remainingHours));
        projectedRemainingPercent = Math.round(projFrac * 100);
      }
    } else {
      projectedRemainingPercent = Math.round(bucket.remainingFraction * 100);
    }
  }

  let status = 'comfortable';
  if (bucket.remainingFraction <= 0.05 || (willExhaustBeforeReset && (paceDeltaPercent ?? 0) < -15)) {
    status = 'exhausting';
  } else if (willExhaustBeforeReset || bucket.remainingFraction < 0.2) {
    status = 'tight';
  } else if ((paceDeltaPercent ?? 0) < -5 || (projectedRemainingPercent !== null && projectedRemainingPercent < 15)) {
    status = 'steady';
  }

  return {
    windowKind: isShortWindow ? '5h' : windowMs === 7 * 24 * HOUR_MS ? '7d' : 'other',
    halfLifeMinutes: Math.round(halfLifeMs / 60_000),
    timeRemainingFraction,
    paceDeltaPercent,
    burnRatePctPerHour: Number((effectiveRatePerHour * 100).toFixed(2)),
    willExhaustBeforeReset,
    estimatedTimeLeftSec,
    projectedRemainingPercent,
    status,
  };
}

/**
 * Parse JSON Lines content of a `transcript.jsonl` file into structured turn & token metrics.
 */
export function parseTranscriptJsonl(jsonlText = '') {
  const turns = [];
  const modelsUsed = new Set();
  const childSubagentIds = new Set();

  let currentTurn = null;
  let pendingSubagentCall = false;
  let firstPromptTitle = '';
  let totalSteps = 0;
  let plannerSteps = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let startedAt = null;
  let updatedAt = null;
  let lastStepAt = null;
  let lastModel = '';
  let currentContextTokens = 0;

  const lines = String(jsonlText ?? '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    totalSteps += 1;
    const ts = typeof step.created_at === 'string' ? Date.parse(step.created_at) : NaN;
    if (Number.isFinite(ts)) {
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (updatedAt === null || ts > updatedAt) updatedAt = ts;
    }

    if (step.type === 'USER_INPUT') {
      const preview = cleanPromptTitle(step.content || '', 48);
      if (!firstPromptTitle && preview) firstPromptTitle = preview;
      currentTurn = {
        turnIndex: turns.length + 1,
        prompt: preview || `Turn ${turns.length + 1}`,
        startedAt: Number.isFinite(ts) ? ts : null,
        firstStepAt: null,
        endedAt: Number.isFinite(ts) ? ts : null,
        steps: 0,
        model: '',
        firstStepModel: '',
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        firstStepInputTokens: null,
        firstStepCacheReadTokens: null,
        peakContextTokens: 0,
      };
      turns.push(currentTurn);
      pendingSubagentCall = false;
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      plannerSteps += 1;
      const inp = Math.max(0, Number(step.input_tokens) || 0);
      const cache = Math.max(0, Number(step.cache_read_tokens) || 0);
      const out = Math.max(0, Number(step.output_tokens) || 0);
      const model = typeof step.model === 'string' ? step.model : '';
      if (model) modelsUsed.add(model);

      inputTokens += inp;
      cacheReadTokens += cache;
      outputTokens += out;

      if (!currentTurn) {
        currentTurn = {
          turnIndex: turns.length + 1,
          prompt: firstPromptTitle || 'Session start',
          startedAt: Number.isFinite(ts) ? ts : null,
          firstStepAt: null,
          endedAt: Number.isFinite(ts) ? ts : null,
          steps: 0,
          model: '',
          firstStepModel: '',
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          firstStepInputTokens: null,
          firstStepCacheReadTokens: null,
          peakContextTokens: 0,
        };
        turns.push(currentTurn);
      }
      if (currentTurn.steps === 0) {
        currentTurn.firstStepInputTokens = inp;
        currentTurn.firstStepCacheReadTokens = cache;
        currentTurn.firstStepAt = Number.isFinite(ts) ? ts : null;
        if (model) currentTurn.firstStepModel = model;
      }
      currentTurn.steps += 1;
      if (model) currentTurn.model = model;
      if (Number.isFinite(ts)) currentTurn.endedAt = ts;
      currentTurn.inputTokens += inp;
      currentTurn.cacheReadTokens += cache;
      currentTurn.outputTokens += out;
      const stepCtx = inp + cache;
      if (stepCtx > currentTurn.peakContextTokens) {
        currentTurn.peakContextTokens = stepCtx;
      }
      if (stepCtx > 0) {
        currentContextTokens = stepCtx;
      }
      if (inp + cache + out > 0) {
        if (Number.isFinite(ts)) lastStepAt = ts;
        if (model) lastModel = model;
      }

      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      pendingSubagentCall = calls.some((c) => c && c.name === 'invoke_subagent');
      continue;
    }

    if (pendingSubagentCall && typeof step.content === 'string') {
      for (const m of step.content.matchAll(UUID_FIND_RE)) {
        childSubagentIds.add(m[1].toLowerCase());
      }
    }
  }

  let runningPeakContext = 0;
  let prevEndedAt = null;
  let prevModel = '';
  const cacheReloads = [];

  const finalizedTurns = turns
    .filter((t) => t.steps > 0 || t.prompt)
    .map((t) => {
      const total = t.inputTokens + t.cacheReadTokens + t.outputTokens;
      const effective = computeEffectiveTokens(t.inputTokens, t.cacheReadTokens, t.outputTokens);
      const cacheHitRatio = computeCacheHitRatio(t.inputTokens, t.cacheReadTokens);

      const firstInp = t.firstStepInputTokens || 0;
      const firstCache = t.firstStepCacheReadTokens ?? 0;
      const isFullColdMiss =
        t.turnIndex > 1 &&
        t.steps > 0 &&
        firstCache === 0 &&
        firstInp >= CACHE_SPIKE_THRESHOLD_TOKENS;
      const isMajorPrefixMiss =
        t.turnIndex > 1 &&
        t.steps > 0 &&
        runningPeakContext >= 30_000 &&
        firstInp >= CACHE_SPIKE_THRESHOLD_TOKENS &&
        firstInp > firstCache * 1.5 &&
        firstInp >= runningPeakContext * 0.5;

      const cacheExpiredSpike = isFullColdMiss || isMajorPrefixMiss;
      let cacheReload = null;

      if (cacheExpiredSpike) {
        const refStart = t.startedAt ?? t.firstStepAt;
        const gapSec =
          prevEndedAt !== null && refStart !== null && refStart >= prevEndedAt
            ? Math.round((refStart - prevEndedAt) / 1000)
            : null;
        const currFirstModel = t.firstStepModel || t.model || '';
        let reason = 'early_drop';
        if (prevModel && currFirstModel && prevModel !== currFirstModel) {
          reason = 'model_switch';
        } else if (gapSec !== null && gapSec >= IDLE_CACHE_TTL_SEC) {
          reason = 'idle_ttl';
        }

        const reloadedTokens =
          runningPeakContext > 0 ? Math.min(firstInp, runningPeakContext) : firstInp;
        const wastedEffectiveTokens = Math.round(reloadedTokens * CACHE_SAVINGS_FACTOR);

        cacheReload = {
          turnIndex: t.turnIndex,
          prompt: t.prompt,
          reason,
          gapSec,
          prevModel: prevModel || null,
          model: currFirstModel || null,
          reloadedTokens,
          wastedEffectiveTokens,
          atMs: t.firstStepAt || t.startedAt || null,
        };
        cacheReloads.push(cacheReload);
      }

      if (t.steps > 0) {
        if (t.peakContextTokens > runningPeakContext) {
          runningPeakContext = t.peakContextTokens;
        }
        if (t.endedAt !== null) prevEndedAt = t.endedAt;
        if (t.model) prevModel = t.model;
      }

      return {
        turnIndex: t.turnIndex,
        prompt: t.prompt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        steps: t.steps,
        model: t.model,
        inputTokens: t.inputTokens,
        cacheReadTokens: t.cacheReadTokens,
        outputTokens: t.outputTokens,
        totalTokens: total,
        effectiveTokens: effective,
        cacheHitRatio,
        cacheExpiredSpike,
        cacheReload,
      };
    });

  const savedEffectiveTokens = Math.round(cacheReadTokens * CACHE_SAVINGS_FACTOR);
  const wastedEffectiveTokens = cacheReloads.reduce((acc, r) => acc + r.wastedEffectiveTokens, 0);

  return {
    firstPromptTitle,
    startedAt,
    updatedAt,
    lastStepAt: lastStepAt ?? updatedAt,
    lastModel,
    currentContextTokens: currentContextTokens || runningPeakContext,
    totalSteps,
    plannerSteps,
    models: [...modelsUsed],
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    effectiveTokens: computeEffectiveTokens(inputTokens, cacheReadTokens, outputTokens),
    cacheHitRatio: computeCacheHitRatio(inputTokens, cacheReadTokens),
    savedEffectiveTokens,
    reloadCount: cacheReloads.length,
    wastedEffectiveTokens,
    cacheReloads,
    turns: finalizedTurns,
    childSubagentIds: [...childSubagentIds],
  };
}

/**
 * Auto-calibrate how many local weighted Effective Tokens correspond to 1% of the Gemini 5h pool
 * by correlating persisted `/usage` history drops with local Gemini turn timestamps in the same cycle.
 * Falls back to `DEFAULT_TOKENS_PER_PCT_5H` (~300k / 1%) until at least a 2% drop is observed.
 */
export function calibrateTokensPerPct5h(quotaHistory = [], rawSessionsIter = []) {
  if (!Array.isArray(quotaHistory) || quotaHistory.length < 2) {
    return { tokensPerPct: DEFAULT_TOKENS_PER_PCT_5H, calibrated: false, observedDropPct: 0 };
  }

  // Group contiguous history points belonging to the latest Gemini 5h reset cycle
  const valid = [];
  for (const pt of quotaHistory) {
    const b = pt?.buckets?.['gemini-5h'];
    if (!b || typeof b.frac !== 'number' || !Number.isFinite(pt.ts)) continue;
    valid.push({ ts: pt.ts, frac: b.frac, resetAtMs: b.resetAtMs || 0 });
  }
  if (valid.length < 2) {
    return { tokensPerPct: DEFAULT_TOKENS_PER_PCT_5H, calibrated: false, observedDropPct: 0 };
  }

  const latest = valid[valid.length - 1];
  let startIdx = valid.length - 1;
  for (let i = valid.length - 2; i >= 0; i--) {
    const prev = valid[i];
    const next = valid[i + 1];
    if (latest.resetAtMs && prev.resetAtMs && Math.abs(latest.resetAtMs - prev.resetAtMs) > 10 * 60_000) {
      break;
    }
    if (next.frac > prev.frac + 0.015) {
      break; // Pool reset upward between prev and next
    }
    startIdx = i;
  }

  const startPt = valid[startIdx];
  const dropPct = (startPt.frac - latest.frac) * 100;
  if (dropPct < 2.0 || latest.ts <= startPt.ts) {
    return { tokensPerPct: DEFAULT_TOKENS_PER_PCT_5H, calibrated: false, observedDropPct: 0 };
  }

  let observedEff = 0;
  for (const item of rawSessionsIter) {
    const metrics = item?.metrics || item;
    if (!metrics || !Array.isArray(metrics.turns)) continue;
    for (const tr of metrics.turns) {
      const m = String(tr.model || '').toLowerCase();
      if (m && (m.includes('claude') || m.includes('gpt') || m.includes('sonnet') || m.includes('opus'))) {
        continue;
      }
      const refTs = tr.endedAt ?? tr.startedAt;
      if (refTs && refTs >= startPt.ts - 15_000 && refTs <= latest.ts + 5_000) {
        observedEff += tr.effectiveTokens || 0;
      }
    }
  }

  if (observedEff < 40_000) {
    return { tokensPerPct: DEFAULT_TOKENS_PER_PCT_5H, calibrated: false, observedDropPct: 0 };
  }

  const rawRate = observedEff / dropPct;
  const clamped = Math.round(Math.max(60_000, Math.min(2_000_000, rawRate)));
  return {
    tokensPerPct: clamped,
    calibrated: true,
    observedDropPct: Number(dropPct.toFixed(1)),
  };
}

/**
 * Compute live plain-language coaching metrics for a session:
 * - Current context "backpack weight" & multiple vs a fresh 20k chat
 * - Live 60m prompt-cache countdown & state (`light` | `warm` | `expiring` | `expired`)
 * - Estimated remaining turns on the 5h pool for:
 *     (1) staying warm (<60m), (2) cold / model-switched turns, (3) summarizing 2k into a fresh chat.
 */
export function computeSessionLiveCoach(metrics, { nowMs = Date.now(), gemini5hBucket = null, calibration = null } = {}) {
  const contextTokens = Math.max(0, Number(metrics?.currentContextTokens) || 0);
  const lastStepAt = metrics?.lastStepAt ?? metrics?.updatedAt ?? null;
  const idleSec =
    lastStepAt !== null && Number.isFinite(lastStepAt)
      ? Math.max(0, Math.round((nowMs - lastStepAt) / 1000))
      : null;
  const cacheExpiresAtMs =
    lastStepAt !== null && Number.isFinite(lastStepAt)
      ? lastStepAt + IDLE_CACHE_TTL_SEC * 1000
      : null;
  const cacheRemainingSec =
    cacheExpiresAtMs !== null ? Math.max(0, Math.round((cacheExpiresAtMs - nowMs) / 1000)) : 0;

  let cacheState = 'light';
  if (contextTokens >= LIGHT_CONTEXT_THRESHOLD_TOKENS) {
    if (idleSec === null) cacheState = 'unknown';
    else if (cacheRemainingSec <= 0) cacheState = 'expired';
    else if (cacheRemainingSec <= CACHE_EXPIRING_SOON_SEC) cacheState = 'expiring';
    else cacheState = 'warm';
  }

  const effectiveCtx = Math.max(BASELINE_FRESH_CONTEXT_TOKENS, contextTokens);
  const weightMultiple = Math.max(1, Number((effectiveCtx / BASELINE_FRESH_CONTEXT_TOKENS).toFixed(1)));

  let weightTier = 'light';
  if (contextTokens >= 300_000) weightTier = 'very_heavy';
  else if (contextTokens >= 150_000) weightTier = 'heavy';
  else if (contextTokens >= 45_000) weightTier = 'medium';

  const turnsArr = Array.isArray(metrics?.turns) ? metrics.turns.filter((t) => (t.steps || 0) > 0) : [];
  const turnDenom = Math.max(1, turnsArr.length || metrics?.turnCount || 1);
  const mainSteps = Math.max(0, Number(metrics?.plannerSteps) || 0);
  const rawStepsPerTurn = mainSteps > 0 ? mainSteps / turnDenom : 4;
  const avgStepsPerTurn = Number(Math.max(1, Math.min(12, rawStepsPerTurn)).toFixed(1));
  const simSteps = Math.max(1, Math.round(avgStepsPerTurn));

  const avgOutPerStep =
    mainSteps > 0
      ? Math.max(600, Math.min(3500, Math.round((Number(metrics?.outputTokens) || 1200) / mainSteps)))
      : 1200;
  const newInpPerStep = 2_500;

  const warmStepLoad = effectiveCtx * WEIGHTS.cacheRead + newInpPerStep * WEIGHTS.input + avgOutPerStep * WEIGHTS.output;
  const coldFirstStepLoad = effectiveCtx * WEIGHTS.input + newInpPerStep * WEIGHTS.input + avgOutPerStep * WEIGHTS.output;
  const freshStepLoad =
    BASELINE_FRESH_CONTEXT_TOKENS * WEIGHTS.cacheRead + newInpPerStep * WEIGHTS.input + avgOutPerStep * WEIGHTS.output;

  const warmTurnLoad = Math.round(simSteps * warmStepLoad);
  const coldTurnLoad = Math.round(coldFirstStepLoad + Math.max(0, simSteps - 1) * warmStepLoad);
  const freshTurnLoad = Math.round(simSteps * freshStepLoad + 2_000);

  const singleStepWarmLoad = Math.round(warmStepLoad);
  const singleStepColdLoad = Math.round(coldFirstStepLoad);

  const tokensPerPct = calibration?.tokensPerPct || DEFAULT_TOKENS_PER_PCT_5H;
  const remPct =
    gemini5hBucket && !gemini5hBucket.disabled && typeof gemini5hBucket.remainingPercent === 'number'
      ? gemini5hBucket.remainingPercent
      : null;
  const remBudgetEff = remPct !== null ? remPct * tokensPerPct : null;

  const turnsLeft =
    remBudgetEff !== null
      ? {
          warm: Math.max(0, Math.floor(remBudgetEff / Math.max(1, warmTurnLoad))),
          cold: Math.max(0, Math.floor(remBudgetEff / Math.max(1, coldTurnLoad))),
          fresh: Math.max(0, Math.floor(remBudgetEff / Math.max(1, freshTurnLoad))),
          singleWarm: Math.max(0, Math.floor(remBudgetEff / Math.max(1, singleStepWarmLoad))),
          singleCold: Math.max(0, Math.floor(remBudgetEff / Math.max(1, singleStepColdLoad))),
        }
      : null;

  return {
    contextTokens,
    lastStepAt,
    lastModel: metrics?.lastModel || '',
    idleSec,
    cacheExpiresAtMs,
    cacheRemainingSec,
    cacheState,
    weightMultiple,
    weightTier,
    avgStepsPerTurn,
    perTurnLoad: {
      warm: warmTurnLoad,
      cold: coldTurnLoad,
      fresh: freshTurnLoad,
    },
    remaining5hPercent: remPct,
    calibrated: Boolean(calibration?.calibrated),
    turnsLeft,
  };
}

/**
 * Extract first valid JSON object from CLI stdout (tolerates leading info lines or ANSI codes).
 */
export function extractJsonFromStdout(raw = '') {
  const cleaned = String(raw ?? '').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function unwrapCliEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.command && typeof payload.command.data === 'object' && payload.command.data !== null) {
    return payload.command.data;
  }
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  if (payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
    return payload.result;
  }
  return payload;
}

/**
 * Normalize `agy -p "/usage" --output-format json` payload shapes into a uniform list of buckets,
 * ordered with short-term (`5h`) windows before weekly (`7d`) windows within each group.
 */
export function parseUsagePayload(rawPayload, fetchedAtMs = Date.now()) {
  const payload = unwrapCliEnvelope(rawPayload);
  if (!payload || typeof payload !== 'object') return [];
  const buckets = [];
  const seenKeys = new Set();

  const addBucket = (raw, groupName = '', groupDesc = '', fallbackKey = '') => {
    if (!raw || typeof raw !== 'object') return;
    const fracRaw =
      raw.remaining_fraction ??
      raw.remainingFraction ??
      (typeof raw.remaining_percent === 'number' ? raw.remaining_percent / 100 : undefined) ??
      (typeof raw.remainingPercent === 'number' ? raw.remainingPercent / 100 : undefined);

    const disabled = Boolean(raw.disabled || raw.is_disabled || raw.status === 'disabled');
    if (fracRaw === undefined && !disabled) return;

    const fraction = fracRaw === undefined ? 0 : Math.max(0, Math.min(1, Number(fracRaw)));
    if (!Number.isFinite(fraction)) return;

    const windowLabel = String(raw.window || raw.period || raw.id || fallbackKey || '').trim();
    const label = formatBucketLabel(groupName, windowLabel, raw.name || raw.label || fallbackKey);
    const id = String(raw.id || fallbackKey || label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

    let resetAtMs = null;
    const resetTimeStr = raw.reset_time ?? raw.resetTime ?? raw.resets_at ?? raw.resetsAt;
    const resetInSec = raw.reset_in_seconds ?? raw.resetInSeconds;
    if (typeof resetTimeStr === 'string' && resetTimeStr) {
      const parsed = Date.parse(resetTimeStr);
      if (Number.isFinite(parsed)) resetAtMs = parsed;
    } else if (typeof resetTimeStr === 'number' && Number.isFinite(resetTimeStr)) {
      resetAtMs = resetTimeStr > 1e12 ? resetTimeStr : resetTimeStr * 1000;
    }
    if (resetAtMs === null && typeof resetInSec === 'number' && Number.isFinite(resetInSec) && resetInSec > 0) {
      resetAtMs = fetchedAtMs + Math.round(resetInSec * 1000);
    }

    const dedupKey = `${label.toLowerCase()}|${fraction.toFixed(4)}|${resetAtMs ? Math.round(resetAtMs / 60000) : 'none'}`;
    if (seenKeys.has(dedupKey)) return;
    seenKeys.add(dedupKey);

    const isPrimaryGemini = /gemini/i.test(`${groupName} ${id} ${label}`) && !/3p|claude|gpt/i.test(`${groupName} ${id}`);
    const tooltipParts = [groupDesc, raw.description].filter(Boolean);

    buckets.push({
      id,
      group: groupName || (isPrimaryGemini ? 'Gemini Models' : 'Other Models'),
      isPrimaryGemini,
      window: windowLabel || '',
      shortWindowLabel: shortWindowTag(windowLabel, id),
      label,
      description: tooltipParts.join(' — '),
      remainingFraction: fraction,
      remainingPercent: Number((fraction * 100).toFixed(2)),
      resetAtMs,
      disabled,
    });
  };

  if (Array.isArray(payload.groups)) {
    for (const grp of payload.groups) {
      const grpName = String(grp?.name || grp?.label || grp?.id || '').trim();
      const grpDesc = String(grp?.description || '').trim();
      const list = Array.isArray(grp?.buckets) ? grp.buckets : [];
      for (const b of list) addBucket(b, grpName, grpDesc, b?.window || b?.id || '');
    }
  }

  for (const arrKey of ['buckets', 'pools', 'windows']) {
    if (Array.isArray(payload[arrKey])) {
      for (const b of payload[arrKey]) addBucket(b, b?.group || '', '', b?.window || b?.id || '');
    }
  }

  const quotaObj = payload.quota && typeof payload.quota === 'object' ? payload.quota : null;
  if (quotaObj && !Array.isArray(quotaObj) && buckets.length === 0) {
    for (const [k, v] of Object.entries(quotaObj)) {
      addBucket(v, '', '', k);
    }
  }

  if (buckets.length === 0 && (payload.remaining_fraction !== undefined || payload.remainingFraction !== undefined)) {
    addBucket(payload, '', '', 'primary');
  }

  // Sort primary Gemini first, and within each group put short windows (5h) before long windows (7d)
  buckets.sort((a, b) => {
    if (a.isPrimaryGemini !== b.isPrimaryGemini) return a.isPrimaryGemini ? -1 : 1;
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    const durA = inferWindowDurationMs(a.window, a.id) ?? 9e12;
    const durB = inferWindowDurationMs(b.window, b.id) ?? 9e12;
    return durA - durB;
  });

  return buckets;
}

function shortWindowTag(windowStr, idStr) {
  const combined = `${windowStr} ${idStr}`.toLowerCase();
  if (/\b5h(r|ours?)?\b/.test(combined)) return '5h';
  if (/\b(weekly|week|7d|1w)\b/.test(combined)) return '7d';
  if (/\b(daily|24h|1d)\b/.test(combined)) return '24h';
  return windowStr || 'Pool';
}

function formatBucketLabel(group, windowStr, rawName) {
  const cleanName = String(rawName || '').trim();
  const win = String(windowStr || '').trim();
  const grp = String(group || '').trim();
  if (grp && win) return `${grp} · ${humanizeWindow(win)}`;
  if (cleanName && win && !cleanName.toLowerCase().includes(win.toLowerCase())) {
    return `${humanizeKey(cleanName)} · ${humanizeWindow(win)}`;
  }
  if (cleanName) return humanizeKey(cleanName);
  if (win) return humanizeWindow(win);
  return 'Model Quota';
}

function humanizeWindow(w) {
  const lower = w.toLowerCase();
  if (lower === '5h' || lower === '5hr' || lower === '5hours') return '5h';
  if (lower === '7d' || lower === '1w' || lower === 'weekly' || lower === 'week') return 'Weekly (7d)';
  if (lower === '1d' || lower === '24h' || lower === 'daily') return '24h';
  return w;
}

function humanizeKey(key) {
  return String(key)
    .replace(/[-_]+/g, ' ')
    .replace(/\bgemini\b/gi, 'Gemini')
    .replace(/\b3p\b/gi, 'Third-Party')
    .replace(/\b5h\b/gi, '5h')
    .replace(/\b7d\b/gi, '7d')
    .replace(/\bweekly\b/gi, 'Weekly')
    .replace(/\bprimary\b/gi, 'Primary Pool')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Normalize `agy -p "/credits" --output-format json` payload when available.
 */
export function parseCreditsPayload(rawPayload) {
  const payload = unwrapCliEnvelope(rawPayload);
  if (!payload || typeof payload !== 'object') return null;
  const src = payload.credits && typeof payload.credits === 'object' ? payload.credits : payload;
  const balanceRaw =
    src.remaining_credits ??
    src.remainingCredits ??
    src.balance ??
    src.remaining ??
    src.available ??
    src.ai_credits ??
    src.aiCredits ??
    (typeof payload.credits === 'number' ? payload.credits : undefined);

  const overageEnabled =
    src.useG1Credits ??
    src.use_g1_credits ??
    src.overage_enabled ??
    src.overageEnabled ??
    rawPayload?.useG1Credits ??
    null;

  if (balanceRaw === undefined && overageEnabled === null) return null;
  const balance = balanceRaw !== undefined && Number.isFinite(Number(balanceRaw)) ? Number(balanceRaw) : null;
  return {
    balance,
    overageEnabled: typeof overageEnabled === 'boolean' ? overageEnabled : null,
  };
}

// ---------------------------------------------------------------------------
// Stateful Collector Class
// ---------------------------------------------------------------------------

export class QuotaCollector {
  constructor(options = {}) {
    this.customAppDataDirs = options.appDataDirs || null;
    this.cacheFilePath = options.cacheFilePath !== undefined ? options.cacheFilePath : this._defaultCacheFilePath();
    this.transcriptCache = new Map();
    this.titleCache = new Map();
    this.resolvedAgyBin = undefined;
    this.resolvedAgentApi = undefined;
    this.quotaHistory = []; // [{ ts, buckets: { [id]: { frac, resetAtMs } } }]

    this.quotaState = {
      status: 'initializing',
      refreshing: false,
      fetchedAtMs: null,
      creditsFetchedAtMs: null,
      stale: false,
      errorMessage: '',
      cliHint: IS_WIN
        ? 'winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | sh',
      buckets: [],
      credits: null,
    };

    this._loadPersistedQuotaCache();
    this._inFlightPromise = null;
    this._lastRefreshTriggerMs = 0;
    this._observedLatestStepMs = 0;
    this._postTurnTimer = null;
  }

  _defaultCacheFilePath() {
    const base = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(tmpdir(), 'agy-quota-monitor');
    return join(base, 'quota_snapshot_cache.json');
  }

  _loadPersistedQuotaCache() {
    if (!this.cacheFilePath) return;
    try {
      if (!existsSync(this.cacheFilePath)) return;
      const saved = JSON.parse(readFileSync(this.cacheFilePath, 'utf-8'));
      if (Array.isArray(saved?.history)) {
        this.quotaHistory = saved.history.slice(-MAX_HISTORY_POINTS);
      }
      if (saved && Array.isArray(saved.buckets) && saved.buckets.length > 0) {
        this.quotaState = {
          ...this.quotaState,
          status: 'ok',
          stale: true,
          fetchedAtMs: saved.fetchedAtMs || null,
          creditsFetchedAtMs: saved.creditsFetchedAtMs || null,
          buckets: saved.buckets,
          credits: saved.credits || null,
        };
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  _recordHistorySample(buckets, ts) {
    if (!Array.isArray(buckets) || buckets.length === 0) return;
    const last = this.quotaHistory[this.quotaHistory.length - 1];
    if (last && ts - last.ts < MIN_HISTORY_SAMPLE_GAP_MS) {
      // Update latest sample in place when refreshed rapidly within the same minute
      for (const b of buckets) {
        if (!b.disabled) last.buckets[b.id] = { frac: b.remainingFraction, resetAtMs: b.resetAtMs };
      }
      last.ts = ts;
      return;
    }

    const map = {};
    for (const b of buckets) {
      if (!b.disabled) map[b.id] = { frac: b.remainingFraction, resetAtMs: b.resetAtMs };
    }
    this.quotaHistory.push({ ts, buckets: map });
    if (this.quotaHistory.length > MAX_HISTORY_POINTS) {
      this.quotaHistory = this.quotaHistory.slice(-MAX_HISTORY_POINTS);
    }
  }

  _savePersistedQuotaCache() {
    if (!this.cacheFilePath) return;
    try {
      mkdirSync(dirname(this.cacheFilePath), { recursive: true });
      writeFileSync(
        this.cacheFilePath,
        JSON.stringify({
          fetchedAtMs: this.quotaState.fetchedAtMs,
          creditsFetchedAtMs: this.quotaState.creditsFetchedAtMs,
          buckets: this.quotaState.buckets,
          credits: this.quotaState.credits,
          history: this.quotaHistory,
        }),
        'utf-8'
      );
    } catch {
      // Non-fatal
    }
  }

  findAppDataDirs() {
    if (Array.isArray(this.customAppDataDirs)) return this.customAppDataDirs;

    const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    if (dataDir) {
      for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
        if (basename(d) !== 'sidecar_data') continue;
        const appData = dirname(d);
        return existsSync(join(appData, 'brain')) ? [appData] : [];
      }
    }

    const geminiRoot = join(homedir(), '.gemini');
    return ['antigravity', 'antigravity-ide', 'antigravity-cli']
      .map((name) => join(geminiRoot, name))
      .filter((dir) => existsSync(join(dir, 'brain')));
  }

  resolveAgyBinary() {
    if (this.resolvedAgyBin !== undefined && this.resolvedAgyBin !== null) {
      if (existsSync(this.resolvedAgyBin)) return this.resolvedAgyBin;
    }

    const candidates = [];
    if (process.env.AGY_BIN) candidates.push(process.env.AGY_BIN);

    const home = homedir();
    if (IS_WIN) {
      const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
      const roamApp = process.env.APPDATA || join(home, 'AppData', 'Roaming');
      candidates.push(
        join(localApp, 'Microsoft', 'WinGet', 'Links', 'agy.exe'),
        join(localApp, 'Programs', 'agy', 'agy.exe'),
        join(localApp, 'Programs', 'Antigravity', 'agy.exe'),
        join(localApp, 'Google', 'Antigravity', 'agy.exe'),
        join(home, '.antigravity', 'bin', 'agy.exe'),
        join(home, '.gemini', 'bin', 'agy.exe'),
        join(roamApp, 'npm', 'agy.cmd')
      );
      const wingetPkgs = join(localApp, 'Microsoft', 'WinGet', 'Packages');
      if (existsSync(wingetPkgs)) {
        try {
          for (const entry of readdirSync(wingetPkgs)) {
            if (entry.toLowerCase().includes('antigravity')) {
              const pkgRoot = join(wingetPkgs, entry);
              const directExe = join(pkgRoot, 'agy.exe');
              if (existsSync(directExe)) candidates.unshift(directExe);
              const binExe = join(pkgRoot, 'bin', 'agy.exe');
              if (existsSync(binExe)) candidates.unshift(binExe);
            }
          }
        } catch {
          // Ignore
        }
      }
    } else {
      candidates.push(
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
        join(home, '.antigravity', 'bin', 'agy'),
        join(home, '.local', 'bin', 'agy'),
        join(home, '.gemini', 'bin', 'agy')
      );
    }

    const pathSep = IS_WIN ? ';' : ':';
    const pathExts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
    for (const dir of String(process.env.PATH || '').split(pathSep)) {
      if (!dir) continue;
      for (const ext of pathExts) {
        candidates.push(join(dir.trim(), `agy${ext}`));
      }
    }

    for (const candidate of candidates) {
      try {
        accessSync(candidate, IS_WIN ? fsConstants.F_OK : fsConstants.X_OK);
        if (statSync(candidate).isFile()) {
          this.resolvedAgyBin = candidate;
          return candidate;
        }
      } catch {
        // Continue
      }
    }

    this.resolvedAgyBin = null;
    return null;
  }

  execAgyJson(binPath, slashCommand) {
    const allowedCommands = new Set(['/usage', '/credits']);
    if (!allowedCommands.has(slashCommand)) {
      return Promise.reject(new Error(`Unsupported command: ${slashCommand}`));
    }

    return new Promise((resolve, reject) => {
      const isBatchWrapper = IS_WIN && /\.(cmd|bat)$/i.test(binPath);
      const file = isBatchWrapper ? (process.env.ComSpec || 'cmd.exe') : binPath;
      const args = isBatchWrapper
        ? ['/d', '/s', '/c', `"${binPath}" -p "${slashCommand}" --output-format json`]
        : ['-p', slashCommand, '--output-format', 'json'];

      const child = execFile(
        file,
        args,
        {
          encoding: 'utf-8',
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          windowsVerbatimArguments: isBatchWrapper,
        },
        (err, stdout, stderr) => {
          const parsed = extractJsonFromStdout(stdout);
          if (parsed && parsed.status !== 'ERROR') return resolve(parsed);
          if (err || parsed?.status === 'ERROR') {
            const combined = `${parsed?.error || ''} ${stderr || ''} ${stdout || ''} ${err?.message || ''}`.trim();
            return reject(new Error(combined || 'Failed to run agy CLI'));
          }
          reject(new Error('Empty or non-JSON output from agy CLI'));
        }
      );

      try {
        child.stdin?.end();
      } catch {
        // Ignore
      }
    });
  }

  triggerQuotaRefresh({ force = false } = {}) {
    if (this._inFlightPromise) return this._inFlightPromise;

    const now = Date.now();
    if (force && now - this._lastRefreshTriggerMs < MIN_MANUAL_REFRESH_MS) {
      return Promise.resolve();
    }
    if (
      !force &&
      !this.quotaState.stale &&
      this.quotaState.fetchedAtMs &&
      now - this.quotaState.fetchedAtMs < IDLE_QUOTA_TTL_MS
    ) {
      return Promise.resolve();
    }

    this._lastRefreshTriggerMs = now;
    this.quotaState.refreshing = true;

    this._inFlightPromise = (async () => {
      const bin = this.resolveAgyBinary();
      if (!bin) {
        this.quotaState = {
          ...this.quotaState,
          status: 'cli_missing',
          refreshing: false,
          errorMessage: 'agy CLI not detected on this machine.',
        };
        return;
      }

      try {
        const usageRaw = await this.execAgyJson(bin, '/usage');
        const fetchedAtMs = Date.now();
        const buckets = parseUsagePayload(usageRaw, fetchedAtMs);
        this._recordHistorySample(buckets, fetchedAtMs);

        let credits = this.quotaState.credits;
        let creditsFetchedAtMs = this.quotaState.creditsFetchedAtMs;
        const needCredits =
          force ||
          credits === null ||
          !creditsFetchedAtMs ||
          fetchedAtMs - creditsFetchedAtMs >= CREDITS_TTL_MS;

        if (needCredits) {
          try {
            const creditsRaw = await this.execAgyJson(bin, '/credits');
            const parsedCredits = parseCreditsPayload(creditsRaw);
            if (parsedCredits) {
              credits = parsedCredits;
              creditsFetchedAtMs = Date.now();
            }
          } catch {
            // Optional
          }
        }

        this.quotaState = {
          ...this.quotaState,
          status: 'ok',
          refreshing: false,
          fetchedAtMs,
          creditsFetchedAtMs,
          stale: false,
          errorMessage: '',
          buckets,
          credits,
        };
        this._savePersistedQuotaCache();
      } catch (err) {
        const msg = String(err?.message || err || 'Unknown error');
        const isAuth = /auth|login|sign.?in|unauthenticated|credential|oauth/i.test(msg);
        const hasPreviousGood = this.quotaState.buckets.length > 0;

        this.quotaState = {
          ...this.quotaState,
          status: hasPreviousGood ? 'ok' : isAuth ? 'auth_needed' : 'error',
          stale: hasPreviousGood,
          refreshing: false,
          errorMessage: msg.slice(0, 240),
        };
      } finally {
        this._inFlightPromise = null;
      }
    })();

    return this._inFlightPromise;
  }

  schedulePostTurnRefresh() {
    if (this._postTurnTimer) clearTimeout(this._postTurnTimer);
    this._postTurnTimer = setTimeout(() => {
      this._postTurnTimer = null;
      this.triggerQuotaRefresh({ force: true });
    }, POST_TURN_SETTLE_MS);
  }

  /**
   * Resolve the `agentapi` helper binary across env vars and standard Windows/macOS/Linux locations
   * so short sidebar titles (e.g. `额度实时显示插件`) resolve cleanly without `.bat` spawn failures.
   */
  _resolveAgentApiExecutable() {
    if (this.resolvedAgentApi !== undefined) return this.resolvedAgentApi;

    const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    if (envExe && existsSync(envExe)) {
      this.resolvedAgentApi = { file: envExe, prefixArgs: ['agentapi'], isBat: /\.(cmd|bat)$/i.test(envExe) };
      return this.resolvedAgentApi;
    }

    const home = homedir();
    if (IS_WIN) {
      const localApp = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
      const lsExe = join(localApp, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
      if (existsSync(lsExe)) {
        this.resolvedAgentApi = { file: lsExe, prefixArgs: ['agentapi'], isBat: false };
        return this.resolvedAgentApi;
      }
      const batPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi.bat');
      if (existsSync(batPath)) {
        this.resolvedAgentApi = { file: batPath, prefixArgs: [], isBat: true };
        return this.resolvedAgentApi;
      }
    } else {
      const shPath = join(home, '.gemini', 'antigravity', 'bin', 'agentapi');
      if (existsSync(shPath)) {
        this.resolvedAgentApi = { file: shPath, prefixArgs: [], isBat: false };
        return this.resolvedAgentApi;
      }
    }

    this.resolvedAgentApi = null;
    return null;
  }

  resolveAgentApiTitle(convId) {
    const cached = this.titleCache.get(convId);
    if (typeof cached === 'string') return cached;
    if (cached) return '';

    if (!process.env.ANTIGRAVITY_LS_ADDRESS) {
      this._setTitleCache(convId, '');
      return '';
    }

    const resolved = this._resolveAgentApiExecutable();
    if (!resolved) {
      this._setTitleCache(convId, '');
      return '';
    }

    const file = resolved.isBat ? (process.env.ComSpec || 'cmd.exe') : resolved.file;
    const args = resolved.isBat
      ? ['/d', '/s', '/c', `"${resolved.file}" get-conversation-metadata ${convId}`]
      : [...resolved.prefixArgs, 'get-conversation-metadata', convId];

    const p = new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        {
          encoding: 'utf-8',
          timeout: 4000,
          windowsHide: true,
          windowsVerbatimArguments: resolved.isBat,
        },
        (err, stdout) => {
          if (err) return resolve('');
          try {
            const md = JSON.parse(stdout || '{}');
            resolve(
              String(md.title || md.summary || md.name || md.metadata?.title || md.conversation?.title || '').trim()
            );
          } catch {
            resolve('');
          }
        }
      );
      try {
        child.stdin?.end();
      } catch {
        // Ignore
      }
    }).then((title) => {
      this._setTitleCache(convId, title);
      return title;
    });
    this._setTitleCache(convId, p);
    return '';
  }

  _setTitleCache(key, val) {
    if (!this.titleCache.has(key) && this.titleCache.size >= MAX_TITLE_CACHE) {
      const oldest = this.titleCache.keys().next().value;
      if (oldest !== undefined) this.titleCache.delete(oldest);
    }
    this.titleCache.set(key, val);
  }

  readConversationMetrics(brainDir, convId) {
    if (!CONV_ID_RE.test(convId)) return null;
    const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
    let st;
    try {
      st = statSync(transcriptPath);
    } catch {
      return null;
    }

    const cached = this.transcriptCache.get(transcriptPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }

    let parsed;
    try {
      const content = readFileSync(transcriptPath, 'utf-8');
      parsed = parseTranscriptJsonl(content);
    } catch {
      return null;
    }

    const data = {
      conversationId: convId,
      mtimeMs: st.mtimeMs,
      ...parsed,
    };
    if (!this.transcriptCache.has(transcriptPath) && this.transcriptCache.size >= MAX_TRANSCRIPT_CACHE) {
      const oldest = this.transcriptCache.keys().next().value;
      if (oldest !== undefined) this.transcriptCache.delete(oldest);
    }
    this.transcriptCache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  }

  getSnapshot({ conversationId = '', forceRefresh = false, nowMs: customNowMs } = {}) {
    if (forceRefresh || this.quotaState.status === 'initializing' || this.quotaState.stale) {
      this.triggerQuotaRefresh({ force: forceRefresh });
    } else {
      this.triggerQuotaRefresh({ force: false });
    }

    const nowMs = typeof customNowMs === 'number' && Number.isFinite(customNowMs) ? customNowMs : Date.now();
    const activeConvId = CONV_ID_RE.test(conversationId) ? conversationId.toLowerCase() : '';
    const appDataDirs = this.findAppDataDirs();

    const dirEntries = [];
    for (const appData of appDataDirs) {
      const brainDir = join(appData, 'brain');
      let children;
      try {
        children = readdirSync(brainDir);
      } catch {
        continue;
      }
      for (const name of children) {
        if (!CONV_ID_RE.test(name)) continue;
        const lower = name.toLowerCase();
        const transcriptPath = join(brainDir, name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const st = statSync(transcriptPath);
          dirEntries.push({ brainDir, convId: lower, rawName: name, mtimeMs: st.mtimeMs });
        } catch {
          // Ignore empty conversation dir
        }
      }
    }

    dirEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = dirEntries.slice(0, MAX_SCANNED_CONVERSATIONS);
    if (activeConvId && !selected.some((e) => e.convId === activeConvId)) {
      const match = dirEntries.find((e) => e.convId === activeConvId);
      if (match) selected.push(match);
    }

    const rawSessions = new Map();
    let newestStepMs = 0;

    for (const item of selected) {
      const metrics = this.readConversationMetrics(item.brainDir, item.rawName);
      if (!metrics) continue;
      rawSessions.set(item.convId, { brainDir: item.brainDir, metrics });
      if (metrics.plannerSteps > 0 && item.mtimeMs > newestStepMs) {
        newestStepMs = item.mtimeMs;
      }
    }

    if (this._observedLatestStepMs > 0 && newestStepMs > this._observedLatestStepMs) {
      this.schedulePostTurnRefresh();
    }
    if (newestStepMs > this._observedLatestStepMs) {
      this._observedLatestStepMs = newestStepMs;
    }

    const allChildIds = new Set();
    for (const { metrics } of rawSessions.values()) {
      for (const childId of metrics.childSubagentIds) {
        if (childId !== metrics.conversationId.toLowerCase()) {
          allChildIds.add(childId);
        }
      }
    }

    const calibration = calibrateTokensPerPct5h(this.quotaHistory, rawSessions.values());
    const gemini5hBucket =
      (this.quotaState.buckets || []).find((b) => b.isPrimaryGemini && b.shortWindowLabel === '5h' && !b.disabled) ||
      (this.quotaState.buckets || []).find((b) => !b.disabled) ||
      null;

    const buildSessionSummary = (convId, includeTurns = false) => {
      const entry = rawSessions.get(convId);
      if (!entry) return null;
      const { brainDir, metrics } = entry;

      let inputTokens = metrics.inputTokens;
      let cacheReadTokens = metrics.cacheReadTokens;
      let outputTokens = metrics.outputTokens;
      let plannerSteps = metrics.plannerSteps;
      let subagentCount = 0;

      const apiTitle = this.resolveAgentApiTitle(convId);
      const title = apiTitle || metrics.firstPromptTitle || `Session ${convId.slice(0, 8)}`;

      const mergedReloads = (metrics.cacheReloads || []).map((r) => ({
        ...r,
        conversationId: convId,
        sessionTitle: title,
        isSubagent: false,
      }));

      const visited = new Set([convId]);
      const queue = [...metrics.childSubagentIds];
      while (queue.length > 0) {
        const subId = queue.shift();
        if (!subId || visited.has(subId)) continue;
        visited.add(subId);
        const subMetrics =
          rawSessions.get(subId)?.metrics || this.readConversationMetrics(brainDir, subId);
        if (!subMetrics) continue;
        subagentCount += 1;
        inputTokens += subMetrics.inputTokens;
        cacheReadTokens += subMetrics.cacheReadTokens;
        outputTokens += subMetrics.outputTokens;
        plannerSteps += subMetrics.plannerSteps;
        for (const r of subMetrics.cacheReloads || []) {
          mergedReloads.push({
            ...r,
            conversationId: convId,
            sessionTitle: title,
            isSubagent: true,
          });
        }
        for (const grandChild of subMetrics.childSubagentIds) {
          if (!visited.has(grandChild)) queue.push(grandChild);
        }
      }

      const totalTokens = inputTokens + cacheReadTokens + outputTokens;
      const effectiveTokens = computeEffectiveTokens(inputTokens, cacheReadTokens, outputTokens);
      const cacheHitRatio = computeCacheHitRatio(inputTokens, cacheReadTokens);
      const savedEffectiveTokens = Math.round(cacheReadTokens * CACHE_SAVINGS_FACTOR);
      const reloadCount = mergedReloads.length;
      const wastedEffectiveTokens = mergedReloads.reduce((acc, r) => acc + r.wastedEffectiveTokens, 0);

      const live = computeSessionLiveCoach(metrics, {
        nowMs,
        gemini5hBucket,
        calibration,
      });

      const out = {
        conversationId: convId,
        title,
        isSubagent: allChildIds.has(convId),
        subagentCount,
        turnCount: metrics.turns.length,
        plannerSteps,
        models: metrics.models,
        updatedAt: metrics.updatedAt || metrics.mtimeMs,
        currentContextTokens: live.contextTokens,
        live,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens,
        effectiveTokens,
        cacheHitRatio,
        savedEffectiveTokens,
        reloadCount,
        wastedEffectiveTokens,
      };
      if (includeTurns) {
        out.turns = metrics.turns;
        out.cacheReloads = mergedReloads;
      }
      return { summary: out, reloads: mergedReloads };
    };

    const currentBuilt = activeConvId ? buildSessionSummary(activeConvId, true) : null;
    const currentSession = currentBuilt ? currentBuilt.summary : null;

    const leaderboard = [];
    const reloadsByConv = new Map();
    if (currentBuilt) {
      reloadsByConv.set(activeConvId, currentBuilt.reloads);
    }

    for (const convId of rawSessions.keys()) {
      if (allChildIds.has(convId) && convId !== activeConvId) continue;
      const built = buildSessionSummary(convId, false);
      if (built && built.summary.totalTokens > 0) {
        leaderboard.push(built.summary);
        reloadsByConv.set(convId, built.reloads);
      }
    }
    leaderboard.sort((a, b) => b.effectiveTokens - a.effectiveTokens);

    // Build Quota Audit across all recent scanned sessions:
    // Answers: Where could prompt cache have worked but didn't? Why? How much % of total spend? Which sessions? What fixes it? + Collapsible Evidence.
    const auditBuckets = new Map(); // reason -> { id, count, wastedEffectiveTokens, reloadedTokens, sessionMap, modelCounts, events }
    let auditTotalEff = 0;
    let auditTotalSaved = 0;
    let auditTotalWasted = 0;
    let auditTotalTurns = 0;
    let auditTotalInput = 0;
    let auditTotalCache = 0;

    for (const s of leaderboard) {
      auditTotalEff += s.effectiveTokens;
      auditTotalSaved += s.savedEffectiveTokens || 0;
      auditTotalTurns += s.turnCount || 0;
      auditTotalInput += s.inputTokens || 0;
      auditTotalCache += s.cacheReadTokens || 0;

      const evs = reloadsByConv.get(s.conversationId) || [];
      for (const ev of evs) {
        auditTotalWasted += ev.wastedEffectiveTokens;
        let bucket = auditBuckets.get(ev.reason);
        if (!bucket) {
          bucket = {
            id: ev.reason,
            count: 0,
            wastedEffectiveTokens: 0,
            reloadedTokens: 0,
            sessionMap: new Map(),
            modelCounts: new Map(),
            events: [],
          };
          auditBuckets.set(ev.reason, bucket);
        }
        bucket.count += 1;
        bucket.wastedEffectiveTokens += ev.wastedEffectiveTokens;
        bucket.reloadedTokens += ev.reloadedTokens || 0;

        const mKey = ev.model || ev.prevModel || '';
        if (mKey) bucket.modelCounts.set(mKey, (bucket.modelCounts.get(mKey) || 0) + 1);

        const prevSess = bucket.sessionMap.get(s.conversationId) || {
          conversationId: s.conversationId,
          title: s.title,
          count: 0,
          wastedEffectiveTokens: 0,
        };
        prevSess.count += 1;
        prevSess.wastedEffectiveTokens += ev.wastedEffectiveTokens;
        bucket.sessionMap.set(s.conversationId, prevSess);

        bucket.events.push({
          ...ev,
          isCurrentSession: Boolean(activeConvId && s.conversationId === activeConvId),
        });
      }
    }

    const auditFindings = [...auditBuckets.values()]
      .map((b) => {
        const topSessions = [...b.sessionMap.values()]
          .sort((a, b2) => b2.wastedEffectiveTokens - a.wastedEffectiveTokens)
          .slice(0, 3);
        const topModels = [...b.modelCounts.entries()]
          .sort((a, b2) => b2[1] - a[1])
          .map(([model, count]) => ({ model, count }));
        const evidence = b.events
          .slice()
          .sort((a, b2) => b2.wastedEffectiveTokens - a.wastedEffectiveTokens)
          .slice(0, 10);

        return {
          id: b.id,
          count: b.count,
          wastedEffectiveTokens: b.wastedEffectiveTokens,
          reloadedTokens: b.reloadedTokens,
          percentOfTotalSpend:
            auditTotalEff > 0
              ? Number(((b.wastedEffectiveTokens / auditTotalEff) * 100).toFixed(1))
              : 0,
          percentOfWaste:
            auditTotalWasted > 0
              ? Number(((b.wastedEffectiveTokens / auditTotalWasted) * 100).toFixed(1))
              : 0,
          dominantModel: topModels[0]?.model || null,
          topSessions,
          evidence,
        };
      })
      .sort((a, b) => b.wastedEffectiveTokens - a.wastedEffectiveTokens);

    const quotaAudit = {
      sessionCount: leaderboard.length,
      turnCount: auditTotalTurns,
      totalEffectiveTokens: auditTotalEff,
      totalSavedEffectiveTokens: auditTotalSaved,
      totalWastedEffectiveTokens: auditTotalWasted,
      wastedPercentOfTotal:
        auditTotalEff > 0
          ? Number(((auditTotalWasted / auditTotalEff) * 100).toFixed(1))
          : 0,
      overallCacheHitRatio: computeCacheHitRatio(auditTotalInput, auditTotalCache),
      findings: auditFindings,
    };

    // Keep legacy cacheHealth summary scoped to active 5h window for backward compatibility
    const recent5h = leaderboard.filter((s) => s.updatedAt && nowMs - s.updatedAt <= 5 * HOUR_MS);
    const scopeSessions =
      recent5h.length > 0
        ? recent5h
        : currentSession
        ? [currentSession]
        : leaderboard.slice(0, 6);
    const scopeKind = recent5h.length > 0 ? '5h' : 'recent';

    let chInput = 0;
    let chCache = 0;
    let chSaved = 0;
    let chWasted = 0;
    const chEvents = [];
    const byReason = { idle_ttl: 0, model_switch: 0, early_drop: 0 };

    for (const s of scopeSessions) {
      chInput += s.inputTokens;
      chCache += s.cacheReadTokens;
      chSaved += s.savedEffectiveTokens || 0;
      chWasted += s.wastedEffectiveTokens || 0;
      const evs = reloadsByConv.get(s.conversationId) || [];
      for (const ev of evs) {
        if (byReason[ev.reason] !== undefined) byReason[ev.reason] += 1;
        chEvents.push({
          ...ev,
          isCurrentSession: Boolean(activeConvId && s.conversationId === activeConvId),
        });
      }
    }

    chEvents.sort((a, b) => {
      if ((b.atMs || 0) !== (a.atMs || 0)) return (b.atMs || 0) - (a.atMs || 0);
      if (a.isCurrentSession !== b.isCurrentSession) return a.isCurrentSession ? -1 : 1;
      return b.wastedEffectiveTokens - a.wastedEffectiveTokens;
    });

    const cacheHealth =
      scopeSessions.length > 0
        ? {
            scope: scopeKind,
            sessionCount: scopeSessions.length,
            hitRatio: computeCacheHitRatio(chInput, chCache),
            inputTokens: chInput,
            cacheReadTokens: chCache,
            savedEffectiveTokens: chSaved,
            reloadCount: chEvents.length,
            wastedEffectiveTokens: chWasted,
            byReason,
            events: chEvents.slice(0, 8),
          }
        : null;

    // Enrich buckets with live EWMA half-life pace forecasts
    const enrichedBuckets = (this.quotaState.buckets || []).map((b) => ({
      ...b,
      pace: computePaceForecast(b, this.quotaHistory, nowMs),
    }));

    // Other heavy sessions whose 60m warm cache is within 20 minutes of expiring
    const expiringOtherSessions = leaderboard
      .filter(
        (s) =>
          s.conversationId !== activeConvId &&
          s.live &&
          s.live.contextTokens >= 50_000 &&
          s.live.cacheRemainingSec > 0 &&
          s.live.cacheRemainingSec <= 20 * 60
      )
      .sort((a, b) => a.live.cacheRemainingSec - b.live.cacheRemainingSec)
      .slice(0, 3)
      .map((s) => ({
        conversationId: s.conversationId,
        title: s.title,
        contextTokens: s.live.contextTokens,
        cacheExpiresAtMs: s.live.cacheExpiresAtMs,
        cacheRemainingSec: s.live.cacheRemainingSec,
      }));

    const resolvedTitlesSig = leaderboard
      .slice(0, 10)
      .map((s) => s.title)
      .join('~');

    const etag = [
      this.quotaState.status,
      this.quotaState.refreshing ? '1' : '0',
      this.quotaState.stale ? '1' : '0',
      this.quotaState.fetchedAtMs || '0',
      activeConvId,
      newestStepMs,
      leaderboard.length,
      auditTotalWasted,
      expiringOtherSessions.map((e) => `${e.conversationId.slice(0, 6)}:${Math.floor(e.cacheRemainingSec / 30)}`).join(','),
      currentSession
        ? `${currentSession.effectiveTokens}:${currentSession.reloadCount}:${currentSession.live?.cacheState}:${currentSession.title}`
        : 'none',
      resolvedTitlesSig,
    ].join('|');

    return {
      etag,
      nowMs,
      formula: FORMULA_SPEC,
      calibration,
      quota: {
        ...this.quotaState,
        buckets: enrichedBuckets,
      },
      quotaAudit,
      cacheHealth,
      expiringOtherSessions,
      activeConversationId: activeConvId || null,
      currentSession,
      sessions: leaderboard.slice(0, 15),
    };
  }
}
