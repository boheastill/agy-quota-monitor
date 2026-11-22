/**
 * Core data engine for Antigravity Quota Monitor (pure Node.js stdlib, zero dependencies).
 *
 * Responsibilities:
 * 1. Cloud Quota State (Read-only via official `agy` CLI):
 *    Executes `agy -p "/usage" --output-format json` and `agy -p "/credits" --output-format json`
 *    sequentially in the background (avoiding CLI lock contention), with instant disk-cache
 *    hydration, event-driven post-turn refresh, and 5-minute idle caching.
 *
 * 2. Local Session Workload Analyzer (Read-only via `transcript.jsonl`):
 *    Reads `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` with
 *    bounded mtime + byte-size caching, rolling up subagent usage (`invoke_subagent`) and
 *    computing a 100% deterministic "Effective Token" workload metric across all models.
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
 * Deterministic Effective Token formula constants.
 *
 * Rationale:
 * - Uncached input tokens are the baseline unit (1.0x).
 * - Prompt cache reads are ~10% of input cost across frontier model families (0.1x).
 * - Thinking + output tokens are ~4x of input cost across frontier model families (4.0x).
 *
 * Keeping these weights fixed guarantees a rock-solid, zero-maintenance yardstick that never
 * drifts across sessions or breaks when new internal/frontier model IDs launch.
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

const IDLE_QUOTA_TTL_MS = 5 * 60 * 1000;      // 5 min fallback refresh while pane is open
const CREDITS_TTL_MS = 15 * 60 * 1000;        // Refresh credits every 15 min (unless forced)
const MIN_MANUAL_REFRESH_MS = 3 * 1000;       // 3s anti-spam throttle on manual button clicks
const POST_TURN_SETTLE_MS = 3500;             // Wait 3.5s after a new model step lands before querying cloud quota
const CLI_TIMEOUT_MS = 45_000;                // Headless `agy -p` boots an ephemeral LS (~10-20s on cold start)
const MAX_SCANNED_CONVERSATIONS = 60;         // Inspect newest 60 brain dirs for leaderboard speed
const MAX_TRANSCRIPT_CACHE = 120;             // Bounded LRU/FIFO cache size for long-running sidecar uptime
const MAX_TITLE_CACHE = 200;
const CACHE_SPIKE_THRESHOLD_TOKENS = 25_000;  // Flag cache-expiry spike when Turn 2+ step 1 has >=25k uncached input & 0 cache read

/**
 * Compute deterministic effective tokens from raw token counts.
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
 * Extract a clean, human-readable one-line prompt preview from a raw USER_INPUT content string.
 * Strips `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, and `<USER_SETTINGS_CHANGE>` system blocks.
 */
export function cleanPromptTitle(rawContent = '', maxLen = 64) {
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
      const preview = cleanPromptTitle(step.content || '', 72);
      if (!firstPromptTitle && preview) firstPromptTitle = preview;
      currentTurn = {
        turnIndex: turns.length + 1,
        prompt: preview || `Turn ${turns.length + 1}`,
        startedAt: Number.isFinite(ts) ? ts : null,
        endedAt: Number.isFinite(ts) ? ts : null,
        steps: 0,
        model: '',
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        firstStepInputTokens: null,
        firstStepCacheReadTokens: null,
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
          endedAt: Number.isFinite(ts) ? ts : null,
          steps: 0,
          model: '',
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          firstStepInputTokens: null,
          firstStepCacheReadTokens: null,
        };
        turns.push(currentTurn);
      }
      if (currentTurn.steps === 0) {
        currentTurn.firstStepInputTokens = inp;
        currentTurn.firstStepCacheReadTokens = cache;
      }
      currentTurn.steps += 1;
      if (model) currentTurn.model = model;
      if (Number.isFinite(ts)) currentTurn.endedAt = ts;
      currentTurn.inputTokens += inp;
      currentTurn.cacheReadTokens += cache;
      currentTurn.outputTokens += out;

      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      pendingSubagentCall = calls.some((c) => c && c.name === 'invoke_subagent');
      continue;
    }

    // Extract spawned subagent conversation IDs from tool result steps following invoke_subagent
    if (pendingSubagentCall && typeof step.content === 'string') {
      for (const m of step.content.matchAll(UUID_FIND_RE)) {
        childSubagentIds.add(m[1].toLowerCase());
      }
    }
  }

  const finalizedTurns = turns
    .filter((t) => t.steps > 0 || t.prompt)
    .map((t) => {
      const total = t.inputTokens + t.cacheReadTokens + t.outputTokens;
      const effective = computeEffectiveTokens(t.inputTokens, t.cacheReadTokens, t.outputTokens);
      const cacheHitRatio = computeCacheHitRatio(t.inputTokens, t.cacheReadTokens);
      const cacheExpiredSpike =
        t.turnIndex > 1 &&
        t.steps > 0 &&
        t.firstStepCacheReadTokens === 0 &&
        (t.firstStepInputTokens || 0) >= CACHE_SPIKE_THRESHOLD_TOKENS;
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
      };
    });

  return {
    firstPromptTitle,
    startedAt,
    updatedAt,
    totalSteps,
    plannerSteps,
    models: [...modelsUsed],
    inputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    effectiveTokens: computeEffectiveTokens(inputTokens, cacheReadTokens, outputTokens),
    cacheHitRatio: computeCacheHitRatio(inputTokens, cacheReadTokens),
    turns: finalizedTurns,
    childSubagentIds: [...childSubagentIds],
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

/**
 * Unwrap CLI JSON envelopes (such as `{ status: "SUCCESS", command: { name: "usage", data: {...} } }`).
 */
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
 * Normalize `agy -p "/usage" --output-format json` payload shapes into a uniform list of buckets.
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

    const tooltipParts = [groupDesc, raw.description].filter(Boolean);
    buckets.push({
      id: String(raw.id || fallbackKey || label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
      group: groupName || '',
      window: windowLabel || '',
      label,
      description: tooltipParts.join(' — '),
      remainingFraction: fraction,
      remainingPercent: Number((fraction * 100).toFixed(2)),
      resetAtMs,
      disabled,
    });
  };

  // 1. Prefer structured `groups[].buckets[]` (standard `agy` v1.5+ schema)
  if (Array.isArray(payload.groups)) {
    for (const grp of payload.groups) {
      const grpName = String(grp?.name || grp?.label || grp?.id || '').trim();
      const grpDesc = String(grp?.description || '').trim();
      const list = Array.isArray(grp?.buckets) ? grp.buckets : [];
      for (const b of list) addBucket(b, grpName, grpDesc, b?.window || b?.id || '');
    }
  }

  // 2. Top-level `buckets` or `pools` array
  for (const arrKey of ['buckets', 'pools', 'windows']) {
    if (Array.isArray(payload[arrKey])) {
      for (const b of payload[arrKey]) addBucket(b, b?.group || '', '', b?.window || b?.id || '');
    }
  }

  // 3. Dictionary map under `quota` (e.g. statusline payload `{ quota: { "gemini-5h": {...} } }`)
  const quotaObj = payload.quota && typeof payload.quota === 'object' ? payload.quota : null;
  if (quotaObj && !Array.isArray(quotaObj) && buckets.length === 0) {
    for (const [k, v] of Object.entries(quotaObj)) {
      addBucket(v, '', '', k);
    }
  }

  // 4. Direct flat object fallback
  if (buckets.length === 0 && (payload.remaining_fraction !== undefined || payload.remainingFraction !== undefined)) {
    addBucket(payload, '', '', 'primary');
  }

  return buckets;
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
// Stateful Collector Class (instantiated once per sidecar / dev server)
// ---------------------------------------------------------------------------

export class QuotaCollector {
  constructor(options = {}) {
    this.customAppDataDirs = options.appDataDirs || null;
    this.cacheFilePath = options.cacheFilePath !== undefined ? options.cacheFilePath : this._defaultCacheFilePath();
    this.transcriptCache = new Map(); // path -> { mtimeMs, size, data }
    this.titleCache = new Map();      // convId -> string | Promise
    this.resolvedAgyBin = undefined;  // undefined = unchecked, null = missing, string = path

    this.quotaState = {
      status: 'initializing', // initializing | ok | cli_missing | auth_needed | error
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
      // Ignore corrupt or unreadable cache file
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
        }),
        'utf-8'
      );
    } catch {
      // Non-fatal if cache directory is read-only
    }
  }

  /**
   * Locate Antigravity appData directories containing `brain/`.
   * Follows the exact same `ANTIGRAVITY_EXECUTABLE_DATA_DIR` traversal as builtin sidecars.
   */
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

  /**
   * Locate the `agy` CLI binary across PATH and standard installation directories
   * (including WinGet Packages so no desktop app restart is needed after `winget install`).
   */
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
          // Ignore permission errors
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
        // Continue searching
      }
    }

    this.resolvedAgyBin = null;
    return null;
  }

  /**
   * Execute a read-only `agy -p "<slashCommand>" --output-format json` call safely.
   * Immediately closes stdin so interactive login prompts never hang the child process.
   */
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
        // Ignore stdin close errors
      }
    });
  }

  /**
   * Trigger a non-blocking cloud quota refresh if needed or forced.
   * Runs `/usage` and `/credits` sequentially so two headless CLI instances never contend.
   */
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
            // Credits command is optional on some account types; keep usage success intact
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

  /**
   * Schedule a debounced cloud quota refresh 3.5s after a new conversation step completes.
   */
  schedulePostTurnRefresh() {
    if (this._postTurnTimer) clearTimeout(this._postTurnTimer);
    this._postTurnTimer = setTimeout(() => {
      this._postTurnTimer = null;
      this.triggerQuotaRefresh({ force: true });
    }, POST_TURN_SETTLE_MS);
  }

  /**
   * Fetch conversation title asynchronously via built-in `agentapi` when running inside Antigravity.
   */
  resolveAgentApiTitle(convId) {
    const cached = this.titleCache.get(convId);
    if (typeof cached === 'string') return cached;
    if (cached) return '';

    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    if (!exe && !process.env.ANTIGRAVITY_LS_ADDRESS) {
      this._setTitleCache(convId, '');
      return '';
    }
    const file = exe || 'agentapi';
    const args = [...(exe ? ['agentapi'] : []), 'get-conversation-metadata', convId];
    const p = new Promise((resolve) => {
      const child = execFile(file, args, { encoding: 'utf-8', timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve('');
        try {
          const md = JSON.parse(stdout || '{}');
          resolve(String(md.title || md.summary || md.name || md.metadata?.title || md.conversation?.title || '').trim());
        } catch {
          resolve('');
        }
      });
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

  /**
   * Read and parse a single conversation's `transcript.jsonl` with bounded mtime + size caching.
   */
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

  /**
   * Scan recent conversations, roll up child subagent tokens into parent sessions, and build snapshot.
   */
  getSnapshot({ conversationId = '', forceRefresh = false } = {}) {
    if (forceRefresh || this.quotaState.status === 'initializing' || this.quotaState.stale) {
      this.triggerQuotaRefresh({ force: forceRefresh });
    } else {
      this.triggerQuotaRefresh({ force: false });
    }

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
          // Skip folders that have no transcript yet
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

    const buildSessionSummary = (convId, includeTurns = false) => {
      const entry = rawSessions.get(convId);
      if (!entry) return null;
      const { brainDir, metrics } = entry;

      let inputTokens = metrics.inputTokens;
      let cacheReadTokens = metrics.cacheReadTokens;
      let outputTokens = metrics.outputTokens;
      let plannerSteps = metrics.plannerSteps;
      let subagentCount = 0;

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
        for (const grandChild of subMetrics.childSubagentIds) {
          if (!visited.has(grandChild)) queue.push(grandChild);
        }
      }

      const apiTitle = this.resolveAgentApiTitle(convId);
      const title = apiTitle || metrics.firstPromptTitle || `Session ${convId.slice(0, 8)}`;
      const totalTokens = inputTokens + cacheReadTokens + outputTokens;
      const effectiveTokens = computeEffectiveTokens(inputTokens, cacheReadTokens, outputTokens);
      const cacheHitRatio = computeCacheHitRatio(inputTokens, cacheReadTokens);

      const out = {
        conversationId: convId,
        title,
        isSubagent: allChildIds.has(convId),
        subagentCount,
        turnCount: metrics.turns.length,
        plannerSteps,
        models: metrics.models,
        updatedAt: metrics.updatedAt || metrics.mtimeMs,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens,
        effectiveTokens,
        cacheHitRatio,
      };
      if (includeTurns) {
        out.turns = metrics.turns;
      }
      return out;
    };

    const currentSession = activeConvId ? buildSessionSummary(activeConvId, true) : null;

    const leaderboard = [];
    for (const convId of rawSessions.keys()) {
      if (allChildIds.has(convId) && convId !== activeConvId) continue;
      const summary = buildSessionSummary(convId, false);
      if (summary && summary.totalTokens > 0) {
        leaderboard.push(summary);
      }
    }

    leaderboard.sort((a, b) => b.effectiveTokens - a.effectiveTokens);

    const etag = [
      this.quotaState.status,
      this.quotaState.refreshing ? '1' : '0',
      this.quotaState.stale ? '1' : '0',
      this.quotaState.fetchedAtMs || '0',
      activeConvId,
      newestStepMs,
      leaderboard.length,
      currentSession ? `${currentSession.effectiveTokens}:${currentSession.title}` : 'none',
    ].join('|');

    return {
      etag,
      nowMs: Date.now(),
      formula: FORMULA_SPEC,
      quota: this.quotaState,
      activeConversationId: activeConvId || null,
      currentSession,
      sessions: leaderboard.slice(0, 20),
    };
  }
}
