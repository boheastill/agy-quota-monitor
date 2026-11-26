/**
 * Antigravity Quota Monitor v3.1 — Restrained Engineer Session Telemetry & Cache TTL View.
 *
 * Surfaces three practical signals for the active session:
 *   1. Current context footprint (tokens × avg internal tool steps per turn)
 *   2. Live 60-minute prompt-cache TTL countdown (0.1× cached prefix vs 1.0× uncached reload)
 *   3. Auto-calibrated remaining turns on the 5h pool (warm vs cold vs compact handoff to a new session)
 */
(() => {
  const POLL_INTERVAL_MS = 2500;
  const COUNTDOWN_TICK_MS = 1000;
  const MAX_VISIBLE_SESSIONS = 5;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const I18N = {
    zh: {
      title: '额度与缓存',
      toggleLang: 'EN',
      infoAuditTitle: '上下文体积与 60 分钟缓存机制',
      infoAuditDesc:
        '每次发送消息，系统都会在每一步内部工具调用中携带完整历史上下文。同模型在 60 分钟内续聊可命中前缀缓存（约 0.1× 成本）；闲置超过 60 分钟、中途切换模型、或让新会话直接读取旧会话原始记录，都会触发 1.0× 全量未缓存读取。',
      infoLoadTitle: '折算口径与轮数校准',
      infoLoadExpr: '折算消耗 = 新输入 × 1 + 缓存读取 × 0.1 + 思考输出 × 4',
      infoLoadDesc:
        '预计剩余轮数基于本机观测到的 5h 额度变化与本地 Token 消耗自动校准；底部折叠栏可展开核对具体轮次与间隔。',
      sessionsHeading: '近期会话（绿点 = 缓存有效）',
      modeEffective: '折算消耗 ⇄',
      modeRaw: '原始 Token ⇄',
      justNow: '刚刚',
      ago: (t) => `${t}前`,
      syncing: '同步中…',
      staleTag: '缓存',
      initQuota: '正在同步配额…',
      localOnly: '本地就绪',
      cliMissingTitle: '安装官方 agy CLI 后可同步顶部 5h / 7d 剩余比例',
      authNeededTitle: '请在终端运行一次 agy 完成登录',
      errorTitle: '暂未获取到云端配额',
      copy: '复制',
      copied: '已复制',
      copiedHandoff: '已复制交接摘要提示词，粘贴至当前会话即可生成',
      gemini5h: 'Gemini · 5h',
      gemini7d: 'Gemini · 7d',
      otherGroup: 'Claude / GPT',
      creditsShort: 'Credits',
      resetIn: (t) => `${t} 后重置`,
      resetSoon: '即将重置',
      safeReset: '充裕',
      estSpare: (p) => `预计余 ~${p}%`,
      exhaustIn: (t) => `预计 ~${t} 耗尽`,

      // Coach card
      thisChatKicker: '当前会话',
      latestChatKicker: '最近会话',
      freshChatName: '新会话',
      weightHeadline: (tok) => `当前上下文 ${tok}`,
      weightPillLight: '较轻',
      weightPillMed: (mult) => `新会话的 ${mult}×`,
      weightPillHeavy: (mult) => `偏重 · 新会话的 ${mult}×`,
      weightPillVeryHeavy: (mult) => `极重 · 新会话的 ${mult}×`,
      weightSub: (steps) =>
        `平均每轮触发 ~${steps} 步工具调用，每步均需携带完整上下文`,
      weightSubFresh: '当前上下文体积较小，单步开销很低',

      cacheWarmTitle: (rem) => `● 缓存有效 · 剩余 ${rem}`,
      cacheWarmSub: '60 分钟内同模型续聊按 ~0.1× 计费；中途切换模型会使缓存失效',
      cacheExpiringTitle: (rem) => `◐ 缓存将在 ${rem} 后到期`,
      cacheExpiringSub: '建议趁缓存有效完成收尾，或复制下方指令导出精简交接摘要后再开新会话',
      cacheExpiredTitle: (idle) => `○ 缓存已到期（已闲置 ${idle}）`,
      cacheExpiredSub: '在此继续发送将按 1.0× 重读整段历史；若是独立新任务建议直接新建会话',
      cacheLightTitle: '● 上下文较轻',
      cacheLightSub: '历史体积尚小，即使间隔较久重读开销也可忽略',

      turnsTitlePct: (pct) => `剩余 ${pct}%（5h）预计可支撑轮数`,
      turnsTitleOffline: '单位配额可支撑轮数对比（条越长代表越耐用）',
      calTagTrue: '本机实测校准',
      calTagEst: '基准估算',
      rowWarm: '趁缓存续聊 (<60m)',
      rowCold: '超时 / 切模型重读',
      rowFresh: '1.5k 摘要 → 新会话',
      turnsUnit: (n) => (n >= 300 ? `~${Math.round(n / 10) * 10}+ 轮` : `~${n} 轮`),
      multUnit: (m) => `${m}×`,

      handoffBtn: '复制精简交接摘要提示词（用于迁移至新会话）',
      handoffTip: '注：跨会话交接请直接粘贴摘要，避免让新会话读取旧会话原始记录（会触发 1.0× 全量读取并继承同等体积）',
      handoffPrompt:
        '请趁当前上下文仍在缓存有效期内，将本次会话压缩为 1500 字以内的结构化交接摘要：1. 已完成改动与涉及文件路径；2. 已验证的结论与约束条件；3. 下一步待办事项。请直接输出在单个代码块中，便于我粘贴到新会话继续（新会话无需读取本旧会话原始记录）。',

      // Expiring other chats
      expiringAlert: (title, wt) => `◐ 后台会话《${title}》(${wt}) 缓存即将到期`,
      expiringRight: (rem) => `剩 ${rem} ▸`,

      // Sessions & Leaks
      noSessions: '暂无会话记录',
      wtBadge: (wt) => `上下文 ${wt}`,
      inpShort: '新输入',
      cacheShort: '缓存',
      outShort: '输出',
      turnsShort: (n) => `${n}轮`,
      stepsShort: (n) => `${n}步`,
      subShort: (n) => `+${n}子代理`,
      spikeBadge: '未命中重读',
      sessionHoverTip: (s, cachePct, fmt) =>
        `${s.title}\n当前上下文 ${fmt(s.currentContextTokens || 0)} · ${s.turnCount} 轮 / ${s.plannerSteps} 步\n缓存命中 ${cachePct}% · 累计折算 ${fmt(s.effectiveTokens)}`,

      leaksSummaryWaste: (turns) => `历史缓存未命中：${turns} 轮触发全量重读（点击查看明细）`,
      leaksBadgeWaste: (pct) => `+${pct}% 消耗`,
      leaksSummaryClean: (hitPct) => `近期缓存命中率 ${hitPct}% · 无大额未命中重读`,
      leaksBadgeClean: '正常',
      leakCause_idle: (n) => `闲置超 60m 后继续回复（${n} 轮）`,
      leakCause_switch: (n) => `长会话中途切换模型（${n} 轮）`,
      leakCause_drop: (n, dom) => `60m 内缓存提前失效（${n} 轮${dom ? ` · ${dom}` : ''}）`,
      evTurnMeta: (turnIdx, gap) => `#${turnIdx}轮 · 间隔 ${gap}`,
      evSwitchMeta: (turnIdx, m1, m2) => `#${turnIdx}轮 · ${m1}→${m2}`,
    },

    en: {
      title: 'Quota Monitor',
      toggleLang: '中',
      infoAuditTitle: 'Context Weight & 60-Minute Cache Mechanics',
      infoAuditDesc:
        'Every prompt re-sends your full session history across each internal tool step. Same-model replies within 60m read cached prefix tokens at ~0.1×; pausing >60m, switching models mid-thread, or telling a new session to read an old transcript raw triggers a 1.0× uncached read.',
      infoLoadTitle: 'Weighted Load & Auto-Calibration',
      infoLoadExpr: 'Est. Load = Input × 1 + Cache × 0.1 + Output × 4',
      infoLoadDesc:
        'Remaining turns auto-calibrate against your observed 5h % drops and local token logs. Expand the bottom row anytime to inspect per-turn reload logs.',
      sessionsHeading: 'Recent Sessions (green = warm cache)',
      modeEffective: 'Est. Load ⇄',
      modeRaw: 'Raw Tokens ⇄',
      justNow: 'just now',
      ago: (t) => `${t} ago`,
      syncing: 'syncing…',
      staleTag: 'cached',
      initQuota: 'Syncing quota…',
      localOnly: 'local ready',
      cliMissingTitle: 'Install official agy CLI to sync top 5h / 7d % pools',
      authNeededTitle: 'Run `agy` once in terminal to sign in',
      errorTitle: 'Cloud quota unavailable',
      copy: 'Copy',
      copied: 'Copied',
      copiedHandoff: 'Handoff prompt copied — paste into this session before opening a new one',
      gemini5h: 'Gemini · 5h',
      gemini7d: 'Gemini · 7d',
      otherGroup: 'Claude / GPT',
      creditsShort: 'Credits',
      resetIn: (t) => `${t} left`,
      resetSoon: 'resetting',
      safeReset: 'on pace',
      estSpare: (p) => `~${p}% spare`,
      exhaustIn: (t) => `~${t} left`,

      // Coach card
      thisChatKicker: 'Current Session',
      latestChatKicker: 'Latest Session',
      freshChatName: 'New Session',
      weightHeadline: (tok) => `Context: ${tok} tokens`,
      weightPillLight: 'Light',
      weightPillMed: (mult) => `${mult}× fresh chat`,
      weightPillHeavy: (mult) => `Heavy · ${mult}× fresh chat`,
      weightPillVeryHeavy: (mult) => `Heavy · ${mult}× fresh chat`,
      weightSub: (steps) =>
        `Avg ~${steps} internal tool steps/turn — full context sent on each step`,
      weightSubFresh: 'Minimal context footprint — low per-step token cost',

      cacheWarmTitle: (rem) => `● Cache warm · ${rem} remaining`,
      cacheWarmSub: 'Same-model turns within 60m read cached prefix at ~0.1×; model switches clear cache',
      cacheExpiringTitle: (rem) => `◐ Cache expires in ${rem}`,
      cacheExpiringSub: 'Wrap up while warm (~0.1×), or export a compact handoff summary below before moving on',
      cacheExpiredTitle: (idle) => `○ Cache expired (${idle} idle)`,
      cacheExpiredSub: 'Replying here re-reads full history at 1.0×; start a new session if tackling a separate task',
      cacheLightTitle: '● Light context',
      cacheLightSub: 'Small history footprint — uncached reload cost is negligible',

      turnsTitlePct: (pct) => `Est. turns remaining on ${pct}% (5h) pool`,
      turnsTitleOffline: 'Relative turns per unit of quota (longer = more turns)',
      calTagTrue: 'Calibrated',
      calTagEst: 'Est.',
      rowWarm: 'Warm (<60m, same model)',
      rowCold: 'Cold (>60m / switch)',
      rowFresh: '1.5k summary → New chat',
      turnsUnit: (n) => (n >= 300 ? `~${Math.round(n / 10) * 10}+ turns` : `~${n} turns`),
      multUnit: (m) => `${m}×`,

      handoffBtn: 'Copy Compact Handoff Prompt (→ New Session)',
      handoffTip: 'Note: Paste a summary into the new session rather than asking it to read this transcript raw (avoids a 1.0× cold read + inherited weight).',
      handoffPrompt:
        'While our context is still warm in cache, summarize this session into a concise <1,500-word handoff brief: (1) completed changes & file paths, (2) verified findings & constraints, (3) exact next steps. Output inside a single code block so I can paste it into a new session without reading this old transcript raw.',

      // Expiring other chats
      expiringAlert: (title, wt) => `◐ "${title}" (${wt}) cache expiring`,
      expiringRight: (rem) => `${rem} left ▸`,

      // Sessions & Leaks
      noSessions: 'No sessions recorded yet',
      wtBadge: (wt) => `${wt} ctx`,
      inpShort: 'In',
      cacheShort: 'Cache',
      outShort: 'Out',
      turnsShort: (n) => `${n}t`,
      stepsShort: (n) => `${n}s`,
      subShort: (n) => `+${n} sub`,
      spikeBadge: 'Cold reload',
      sessionHoverTip: (s, cachePct, fmt) =>
        `${s.title}\nContext ${fmt(s.currentContextTokens || 0)} · ${s.turnCount} turns / ${s.plannerSteps} steps\nCache ${cachePct}% · Est. load ${fmt(s.effectiveTokens)}`,

      leaksSummaryWaste: (turns) => `Cold reloads: ${turns} turns missed cache (click to inspect)`,
      leaksBadgeWaste: (pct) => `+${pct}% load`,
      leaksSummaryClean: (hitPct) => `${hitPct}% cache hit across recent sessions · 0 cold reloads`,
      leaksBadgeClean: 'Clean',
      leakCause_idle: (n) => `Resumed after >60m idle (${n}×)`,
      leakCause_switch: (n) => `Mid-thread model switch (${n}×)`,
      leakCause_drop: (n, dom) => `Sub-60m cache eviction (${n}×${dom ? ` · ${dom}` : ''})`,
      evTurnMeta: (turnIdx, gap) => `#${turnIdx} · ${gap} gap`,
      evSwitchMeta: (turnIdx, m1, m2) => `#${turnIdx} · ${m1}→${m2}`,
    },
  };

  const detectLang = () => {
    const q = params.get('lang');
    if (q === 'en' || q === 'zh') return q;
    return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  };

  const state = {
    lang: detectLang(),
    metricMode: 'effective',
    infoOpen: false,
    secOpen: false,
    leaksOpen: false,
    expandedConvId: null,
    etag: '',
    snap: null,
  };

  const t = () => I18N[state.lang];

  // ---------- Host Theme Sync ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const scheme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== scheme) {
      document.documentElement.dataset.theme = scheme;
    }
  }
  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Formatting Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function fmtTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function fmtCompactDuration(sec, showSecondsUnder15m = false) {
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return `${s}s`;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const remS = s % 60;
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
    if (showSecondsUnder15m && m < 15) return `${m}m ${String(remS).padStart(2, '0')}s`;
    return `${m}m`;
  }

  function shortModelName(modelStr) {
    const m = String(modelStr || '').toLowerCase();
    if (!m) return '';
    if (m.includes('carbon')) return 'Carbon';
    if (m.includes('neon')) return 'Neon';
    if (m.includes('hydrogen')) return 'Hydrogen';
    if (m.includes('flash')) return 'Flash';
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('gpt')) return 'GPT';
    return modelStr;
  }

  function colorTierForBucket(b) {
    if (b.remainingFraction < 0.2 || b.pace?.status === 'exhausting') return 'danger';
    if (b.remainingFraction < 0.5 || b.pace?.willExhaustBeforeReset) return 'warn';
    return 'ok';
  }

  function shortPaceTag(b) {
    const dict = t();
    const p = b.pace;
    if (!p) return '';
    if (p.willExhaustBeforeReset && p.estimatedTimeLeftSec) {
      return dict.exhaustIn(fmtCompactDuration(p.estimatedTimeLeftSec));
    }
    if (p.windowKind === '7d' && p.projectedRemainingPercent !== null) {
      return dict.estSpare(p.projectedRemainingPercent);
    }
    return dict.safeReset;
  }

  function shortGaugeTitle(b) {
    const dict = t();
    if (b.isPrimaryGemini) {
      if (b.shortWindowLabel === '5h') return dict.gemini5h;
      if (b.shortWindowLabel === '7d') return dict.gemini7d;
    }
    return b.label;
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 1900);
  }

  function currentConversationId() {
    return window.sidecar?.conversationId || params.get('conversationId') || '';
  }

  async function fetchApi(path) {
    const fn = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fn(path, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function copyText(text, toastMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(toastMsg);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast(toastMsg); } catch {}
      ta.remove();
    }
  }

  // ---------- Renderers ----------
  function renderChrome() {
    const dict = t();
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    $('ui-title').textContent = dict.title;
    $('btn-lang').textContent = dict.toggleLang;
    $('ui-info-audit-title').textContent = dict.infoAuditTitle;
    $('ui-info-audit-desc').textContent = dict.infoAuditDesc;
    $('ui-info-load-title').textContent = dict.infoLoadTitle;
    $('ui-info-load-expr').textContent = dict.infoLoadExpr;
    $('ui-info-load-desc').textContent = dict.infoLoadDesc;
    $('ui-sessions-heading').textContent = dict.sessionsHeading;
    $('btn-metric-mode').textContent = state.metricMode === 'effective' ? dict.modeEffective : dict.modeRaw;

    $('info-drawer').classList.toggle('hidden', !state.infoOpen);
    $('btn-info').setAttribute('aria-expanded', String(state.infoOpen));
  }

  function renderHeaderStatus() {
    const snap = state.snap;
    const dict = t();
    if (!snap) return;

    const q = snap.quota || {};
    $('icon-refresh').classList.toggle('spinning', Boolean(q.refreshing));

    const activeBuckets = (q.buckets || []).filter((b) => !b.disabled);
    const hasDanger = activeBuckets.some((b) => colorTierForBucket(b) === 'danger');
    const hasWarn =
      activeBuckets.some((b) => colorTierForBucket(b) === 'warn') ||
      snap.currentSession?.live?.cacheState === 'expiring';
    $('live-dot').className = `live-dot ${hasDanger ? 'danger' : hasWarn || q.status !== 'ok' ? 'warn' : ''}`.trim();

    if (q.refreshing) {
      $('ui-subtitle').textContent = dict.syncing;
      return;
    }
    if (q.status === 'ok' && q.fetchedAtMs) {
      const sec = Math.max(0, Math.round((Date.now() - q.fetchedAtMs) / 1000));
      const base = sec < 10 ? dict.justNow : dict.ago(fmtCompactDuration(sec));
      $('ui-subtitle').textContent = q.stale ? `${base} (${dict.staleTag})` : base;
    } else {
      $('ui-subtitle').textContent = dict.localOnly;
    }
  }

  function renderQuotaStripZone() {
    const snap = state.snap;
    const dict = t();
    const stripEl = $('quota-strip-zone');
    if (!snap || !stripEl) return;

    const q = snap.quota || {};
    const buckets = Array.isArray(q.buckets) ? q.buckets : [];

    if (q.status === 'initializing' && buckets.length === 0) {
      stripEl.innerHTML = `<div class="notice-card">${esc(dict.initQuota)}</div>`;
      return;
    }

    if ((q.status === 'cli_missing' || q.status === 'auth_needed' || q.status === 'error') && buckets.length === 0) {
      const title =
        q.status === 'cli_missing'
          ? dict.cliMissingTitle
          : q.status === 'auth_needed'
          ? dict.authNeededTitle
          : dict.errorTitle;
      const cmd = q.status === 'cli_missing' ? q.cliHint : q.status === 'auth_needed' ? 'agy' : '';

      stripEl.innerHTML = `
        <div class="notice-card">
          <div class="notice-title">${esc(title)}</div>
          ${
            cmd
              ? `<div class="cmd-inline">
                   <code id="cli-cmd">${esc(cmd)}</code>
                   <button type="button" class="mini-pill-btn" id="btn-copy-cmd">${esc(dict.copy)}</button>
                 </div>`
              : `<div>${esc(q.errorMessage || '')}</div>`
          }
        </div>
      `;
      const copyBtn = $('btn-copy-cmd');
      if (copyBtn) {
        copyBtn.onclick = () => copyText(cmd, dict.copied);
      }
      return;
    }

    const nowMs = Date.now();
    const primaryBuckets = buckets.filter((b) => b.isPrimaryGemini && !b.disabled);
    const heroList = primaryBuckets.length > 0 ? primaryBuckets : buckets.slice(0, 2);
    const heroIds = new Set(heroList.map((b) => b.id));
    const secondaryBuckets = buckets.filter((b) => !heroIds.has(b.id));

    const colsHtml = heroList
      .map((b) => {
        const tier = colorTierForBucket(b);
        const pctRound = Math.round(b.remainingPercent);
        const remSec = b.resetAtMs ? Math.floor((b.resetAtMs - nowMs) / 1000) : 0;
        const resetTxt = b.resetAtMs ? (remSec > 0 ? dict.resetIn(fmtCompactDuration(remSec)) : dict.resetSoon) : '';
        const paceTag = shortPaceTag(b);
        const timeFrac = b.pace?.windowKind === '7d' ? b.pace?.timeRemainingFraction : null;
        const markerHtml =
          typeof timeFrac === 'number' && timeFrac > 0 && timeFrac < 1
            ? `<span class="pace-marker" style="left:${Math.round(timeFrac * 100)}%"></span>`
            : '';

        return `
          <div class="quota-pill-col" data-reset-ms="${b.resetAtMs || ''}">
            <div class="quota-pill-head">
              <span class="quota-pill-name">${esc(shortGaugeTitle(b))}</span>
              <span class="quota-pill-pct ${tier}">${pctRound}%</span>
            </div>
            <div class="mini-bar-track">
              <div class="mini-bar-fill ${tier}" style="width:${Math.max(2, Math.min(100, b.remainingPercent))}%"></div>
              ${markerHtml}
            </div>
            <div class="quota-pill-sub">
              <span class="quota-reset-label">${esc(resetTxt)}</span>
              <span>${esc(paceTag)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const nonZeroCredits = q.credits && typeof q.credits.balance === 'number' && q.credits.balance > 0 ? q.credits.balance : null;
    let secHtml = '';
    if (secondaryBuckets.length > 0 || nonZeroCredits !== null) {
      const summaryItems = secondaryBuckets
        .map((b) => `${b.shortWindowLabel} ${b.disabled ? '—' : `${Math.round(b.remainingPercent)}%`}`)
        .join(' · ');
      const creditsText = nonZeroCredits !== null ? ` · ${dict.creditsShort} ${nonZeroCredits}` : '';
      const detailsHtml = secondaryBuckets
        .map((b) => {
          const remSec = b.resetAtMs ? Math.floor((b.resetAtMs - nowMs) / 1000) : 0;
          const resetTxt = b.resetAtMs ? (remSec > 0 ? dict.resetIn(fmtCompactDuration(remSec)) : dict.resetSoon) : '';
          return `
            <div class="sec-detail-row" data-reset-ms="${b.resetAtMs || ''}">
              <span>${esc(b.label)}</span>
              <span style="font-family:var(--qm-mono)">${b.disabled ? '—' : `${b.remainingPercent.toFixed(1)}%`} <span class="quota-reset-label" style="color:var(--qm-muted)">(${esc(resetTxt)})</span></span>
            </div>
          `;
        })
        .join('');

      secHtml = `
        <button type="button" class="sec-toggle-bar" id="btn-toggle-sec" aria-expanded="${state.secOpen}">
          <span><span class="sec-chevron ${state.secOpen ? 'open' : ''}">▸</span> ${esc(dict.otherGroup)}</span>
          <span style="font-family:var(--qm-mono)">${esc(summaryItems + creditsText)}</span>
        </button>
        <div class="sec-drawer ${state.secOpen ? '' : 'hidden'}">${detailsHtml}</div>
      `;
    }

    stripEl.innerHTML = `<div class="quota-card"><div class="quota-top-row">${colsHtml}</div>${secHtml}</div>`;

    const secBtn = $('btn-toggle-sec');
    if (secBtn) {
      secBtn.onclick = () => {
        state.secOpen = !state.secOpen;
        renderQuotaStripZone();
      };
    }
  }

  function resolveSpotlightSession(snap) {
    if (snap.currentSession) {
      return { session: snap.currentSession, isCurrent: true };
    }
    if (!snap.activeConversationId && Array.isArray(snap.sessions) && snap.sessions.length > 0) {
      const byRecent = snap.sessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { session: byRecent[0], isCurrent: false };
    }
    return { session: null, isCurrent: true };
  }

  function computeLiveCacheView(live, nowMs) {
    const dict = t();
    if (!live || live.contextTokens < 25_000) {
      return {
        cls: 'light',
        title: dict.cacheLightTitle,
        sub: dict.cacheLightSub,
        expiresAtMs: null,
        lastStepAtMs: null,
      };
    }

    const expiresAtMs = live.cacheExpiresAtMs || null;
    const lastStepAtMs = live.lastStepAt || null;
    const remSec = expiresAtMs ? Math.floor((expiresAtMs - nowMs) / 1000) : 0;
    const idleSec = lastStepAtMs ? Math.max(0, Math.floor((nowMs - lastStepAtMs) / 1000)) : 3600;

    if (remSec <= 0) {
      return {
        cls: 'expired',
        title: dict.cacheExpiredTitle(fmtCompactDuration(idleSec)),
        sub: dict.cacheExpiredSub,
        expiresAtMs,
        lastStepAtMs,
      };
    }
    if (remSec <= 15 * 60) {
      return {
        cls: 'expiring',
        title: dict.cacheExpiringTitle(fmtCompactDuration(remSec, true)),
        sub: dict.cacheExpiringSub,
        expiresAtMs,
        lastStepAtMs,
      };
    }
    return {
      cls: 'warm',
      title: dict.cacheWarmTitle(fmtCompactDuration(remSec)),
      sub: dict.cacheWarmSub,
      expiresAtMs,
      lastStepAtMs,
    };
  }

  function renderCoachZone() {
    const snap = state.snap;
    const dict = t();
    const el = $('coach-zone');
    if (!snap || !el) return;

    const { session, isCurrent } = resolveSpotlightSession(snap);
    const nowMs = Date.now();

    if (!session) {
      el.innerHTML = `
        <div class="coach-card">
          <div class="coach-head">
            <div class="coach-head-left">
              <span class="coach-kicker">${esc(dict.thisChatKicker)}</span>
              <span class="coach-chat-title">${esc(dict.freshChatName)}</span>
            </div>
          </div>
          <div class="weight-box">
            <div class="weight-main-row">
              <span class="weight-headline">${esc(dict.weightHeadline('~20k'))}</span>
              <span class="weight-pill light">${esc(dict.weightPillLight)}</span>
            </div>
            <div class="weight-sub">${esc(dict.weightSubFresh)}</div>
          </div>
          <div class="cache-banner light">
            <div class="cache-banner-title">${esc(dict.cacheLightTitle)}</div>
            <div class="cache-banner-sub">${esc(dict.cacheLightSub)}</div>
          </div>
        </div>
      `;
      return;
    }

    const live = session.live || {};
    const ctxTok = live.contextTokens || 0;
    const mult = live.weightMultiple || 1;
    const tier = live.weightTier || 'light';
    const modelShort = shortModelName(live.lastModel || (session.models || [])[0] || '');

    const pillText =
      tier === 'very_heavy'
        ? dict.weightPillVeryHeavy(mult)
        : tier === 'heavy'
        ? dict.weightPillHeavy(mult)
        : tier === 'medium'
        ? dict.weightPillMed(mult)
        : dict.weightPillLight;

    const cacheView = computeLiveCacheView(live, nowMs);

    // Single-color proportional turn comparison
    let turnsHtml = '';
    const tl = live.turnsLeft;
    const ptl = live.perTurnLoad;
    if (tl && typeof live.remaining5hPercent === 'number') {
      const pctRound = Math.round(live.remaining5hPercent);
      const maxT = Math.max(1, tl.fresh, tl.warm, tl.cold);
      const wWarm = Math.max(4, Math.min(100, Math.round((tl.warm / maxT) * 100)));
      const wCold = Math.max(3, Math.min(100, Math.round((tl.cold / maxT) * 100)));
      const wFresh = Math.max(6, Math.min(100, Math.round((tl.fresh / maxT) * 100)));

      turnsHtml = `
        <div class="turns-box">
          <div class="turns-head">
            <span class="turns-title">${esc(dict.turnsTitlePct(pctRound))}</span>
            <span class="turns-cal-tag">${esc(live.calibrated ? dict.calTagTrue : dict.calTagEst)}</span>
          </div>
          <div class="turns-rows">
            <div class="turn-cmp-row">
              <span class="turn-cmp-label">${esc(dict.rowWarm)}</span>
              <div class="turn-cmp-track"><div class="turn-cmp-fill" style="width:${wWarm}%"></div></div>
              <span class="turn-cmp-val">${esc(dict.turnsUnit(tl.warm))}</span>
            </div>
            <div class="turn-cmp-row">
              <span class="turn-cmp-label">${esc(dict.rowCold)}</span>
              <div class="turn-cmp-track"><div class="turn-cmp-fill" style="width:${wCold}%"></div></div>
              <span class="turn-cmp-val">${esc(dict.turnsUnit(tl.cold))}</span>
            </div>
            <div class="turn-cmp-row">
              <span class="turn-cmp-label">${esc(dict.rowFresh)}</span>
              <div class="turn-cmp-track"><div class="turn-cmp-fill" style="width:${wFresh}%"></div></div>
              <span class="turn-cmp-val">${esc(dict.turnsUnit(tl.fresh))}</span>
            </div>
          </div>
        </div>
      `;
    } else if (ptl && ptl.cold > 0) {
      const warmMult = Math.max(1, Number((ptl.cold / Math.max(1, ptl.warm)).toFixed(1)));
      const freshMult = Math.max(1, Math.round(ptl.cold / Math.max(1, ptl.fresh)));
      const wWarm = Math.max(6, Math.min(100, Math.round((warmMult / freshMult) * 100)));
      const wCold = Math.max(4, Math.min(100, Math.round((1 / freshMult) * 100)));

      turnsHtml = `
        <div class="turns-box">
          <div class="turns-head">
            <span class="turns-title">${esc(dict.turnsTitleOffline)}</span>
          </div>
          <div class="turns-rows">
            <div class="turn-cmp-row">
              <span class="turn-cmp-label">${esc(dict.rowWarm)}</span>
              <div class="turn-cmp-track"><div class="turn-cmp-fill" style="width:${wWarm}%"></div></div>
              <span class="turn-cmp-val">${esc(dict.multUnit(warmMult))}</span>
            </div>
            <div class="turn-cmp-row">
              <span class="turn-cmp-label">${esc(dict.rowCold)}</span>
              <div class="turn-cmp-track"><div class="turn-cmp-fill" style="width:${wCold}%"></div></div>
              <span class="turn-cmp-val">1×</span>
            </div>
            <div class="turn-cmp-row">
              <span class="turn-cmp-label">${esc(dict.rowFresh)}</span>
              <div class="turn-cmp-track"><div class="turn-cmp-fill" style="width:100%"></div></div>
              <span class="turn-cmp-val">${esc(dict.multUnit(freshMult))}</span>
            </div>
          </div>
        </div>
      `;
    }

    const showHandoff = ctxTok >= 45_000;
    const handoffHtml = showHandoff
      ? `
        <div class="handoff-box">
          <button type="button" class="handoff-btn" id="btn-copy-handoff">${esc(dict.handoffBtn)}</button>
          <div class="handoff-tip">${esc(dict.handoffTip)}</div>
        </div>
      `
      : '';

    el.innerHTML = `
      <div class="coach-card">
        <div class="coach-head">
          <div class="coach-head-left">
            <span class="coach-kicker">${esc(isCurrent ? dict.thisChatKicker : dict.latestChatKicker)}</span>
            <span class="coach-chat-title" title="${esc(session.title)}">${esc(session.title)}</span>
          </div>
          ${modelShort ? `<span class="model-tag">${esc(modelShort)}</span>` : ''}
        </div>

        <div class="weight-box">
          <div class="weight-main-row">
            <span class="weight-headline"><span class="weight-num">${esc(dict.weightHeadline(fmtTokens(ctxTok)))}</span></span>
            <span class="weight-pill ${esc(tier)}">${esc(pillText)}</span>
          </div>
          <div class="weight-sub">${esc(ctxTok >= 25_000 ? dict.weightSub(live.avgStepsPerTurn || 3) : dict.weightSubFresh)}</div>
        </div>

        <div
          class="cache-banner ${esc(cacheView.cls)}"
          id="live-cache-banner"
          data-cache-expires-ms="${cacheView.expiresAtMs || ''}"
          data-last-step-ms="${cacheView.lastStepAtMs || ''}"
          data-ctx-tokens="${ctxTok}"
        >
          <div class="cache-banner-title" id="live-cache-title">${esc(cacheView.title)}</div>
          <div class="cache-banner-sub" id="live-cache-sub">${esc(cacheView.sub)}</div>
        </div>

        ${turnsHtml}
        ${handoffHtml}
      </div>
    `;

    const handoffBtn = $('btn-copy-handoff');
    if (handoffBtn) {
      handoffBtn.onclick = () => copyText(dict.handoffPrompt, dict.copiedHandoff);
    }
  }

  function renderExpiringZone() {
    const snap = state.snap;
    const dict = t();
    const el = $('expiring-zone');
    if (!snap || !el) return;

    const list = Array.isArray(snap.expiringOtherSessions) ? snap.expiringOtherSessions : [];
    const nowMs = Date.now();
    const activeItems = list.filter((item) => item.cacheExpiresAtMs && item.cacheExpiresAtMs > nowMs);

    if (activeItems.length === 0) {
      el.innerHTML = '';
      return;
    }

    el.innerHTML = `
      <div class="expiring-list">
        ${activeItems
          .map((item) => {
            const remSec = Math.max(0, Math.floor((item.cacheExpiresAtMs - nowMs) / 1000));
            return `
              <button
                type="button"
                class="expiring-alert"
                data-jump-conv="${esc(item.conversationId)}"
                data-exp-ms="${item.cacheExpiresAtMs}"
              >
                <span class="expiring-alert-txt">${esc(dict.expiringAlert(item.title, fmtTokens(item.contextTokens)))}</span>
                <span class="expiring-alert-time">${esc(dict.expiringRight(fmtCompactDuration(remSec, true)))}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `;

    for (const btn of el.querySelectorAll('[data-jump-conv]')) {
      const cid = btn.getAttribute('data-jump-conv');
      btn.onclick = () => {
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(cid);
        } else {
          state.expandedConvId = state.expandedConvId === cid ? null : cid;
          renderSessionsZone();
        }
      };
    }
  }

  function renderSessionsZone() {
    const snap = state.snap;
    const dict = t();
    const listEl = $('sessions-list');
    if (!snap || !listEl) return;

    const metricOf = (s) => (state.metricMode === 'effective' ? s.effectiveTokens : s.totalTokens);
    const all = Array.isArray(snap.sessions) ? snap.sessions.slice() : [];
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const activeId = snap.activeConversationId;
    let visible = all.slice(0, MAX_VISIBLE_SESSIONS);
    if (activeId && snap.currentSession && !visible.some((s) => s.conversationId === activeId)) {
      visible = [snap.currentSession, ...all.slice(0, MAX_VISIBLE_SESSIONS - 1)];
    }

    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty-hint">${esc(dict.noSessions)}</div>`;
      return;
    }

    const maxMetric = Math.max(1, ...visible.map(metricOf));
    const canJumpHost = Boolean(window.sidecar?.ui?.toggleConversation);

    listEl.innerHTML = visible
      .map((s) => {
        const isCurrent = Boolean(activeId && s.conversationId === activeId);
        const fullSession = isCurrent && snap.currentSession ? snap.currentSession : s;
        const val = metricOf(fullSession);
        const barPct = Math.max(5, Math.round((val / maxMetric) * 100));
        const cachePct = Math.round((fullSession.cacheHitRatio || 0) * 100);
        const isExpanded = state.expandedConvId === fullSession.conversationId;
        const cState = fullSession.live?.cacheState || 'expired';
        const ctxWt = fullSession.currentContextTokens || fullSession.live?.contextTokens || 0;
        const hoverTip = dict.sessionHoverTip(fullSession, cachePct, fmtTokens);

        let detailHtml = '';
        if (isExpanded) {
          const turns = Array.isArray(fullSession.turns) ? fullSession.turns : [];
          const turnsHtml = turns
            .slice()
            .reverse()
            .map((tr) => {
              const tv = state.metricMode === 'effective' ? tr.effectiveTokens : tr.totalTokens;
              return `
                <div class="turn-mini-row" title="${esc(tr.prompt)}">
                  <span class="turn-mini-text">#${tr.turnIndex} ${esc(tr.prompt)}</span>
                  ${tr.cacheExpiredSpike ? `<span class="spike-tag">${esc(dict.spikeBadge)}</span>` : ''}
                  <span class="turn-mini-val">${esc(fmtTokens(tv))}</span>
                </div>
              `;
            })
            .join('');

          detailHtml = `
            <div class="s-detail">
              <div class="s-chips">
                <span class="s-chip">${esc(dict.inpShort)} ${esc(fmtTokens(fullSession.inputTokens))}</span>
                <span class="s-chip">${esc(dict.cacheShort)} ${esc(fmtTokens(fullSession.cacheReadTokens))} (${cachePct}%)</span>
                <span class="s-chip">${esc(dict.outShort)} ${esc(fmtTokens(fullSession.outputTokens))}</span>
                <span class="s-chip">${esc(dict.turnsShort(fullSession.turnCount))} · ${esc(dict.stepsShort(fullSession.plannerSteps))}</span>
                ${fullSession.subagentCount > 0 ? `<span class="s-chip">${esc(dict.subShort(fullSession.subagentCount))}</span>` : ''}
              </div>
              ${turnsHtml ? `<div class="turn-mini-list">${turnsHtml}</div>` : ''}
            </div>
          `;
        }

        return `
          <div class="s-item ${isCurrent ? 'active' : ''}" role="listitem" data-conv-id="${esc(fullSession.conversationId)}">
            <div class="s-row" title="${esc(hoverTip)}">
              <span class="s-cache-dot ${esc(cState)}" aria-hidden="true"></span>
              <span class="s-title">${esc(fullSession.title)}</span>
              ${ctxWt > 0 ? `<span class="s-wt-tag">${esc(dict.wtBadge(fmtTokens(ctxWt)))}</span>` : ''}
              <div class="s-bar">
                <div class="s-bar-fill" style="width:${barPct}%"></div>
              </div>
              <span class="s-val">${esc(fmtTokens(val))}</span>
            </div>
            ${detailHtml}
          </div>
        `;
      })
      .join('');

    for (const itemEl of listEl.querySelectorAll('.s-item')) {
      const rowEl = itemEl.querySelector('.s-row');
      const convId = itemEl.getAttribute('data-conv-id');
      if (!rowEl || !convId) continue;

      rowEl.onclick = () => {
        const isCurrent = Boolean(snap.activeConversationId && convId === snap.activeConversationId);
        if (isCurrent || !canJumpHost) {
          state.expandedConvId = state.expandedConvId === convId ? null : convId;
          renderSessionsZone();
        } else if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(convId);
        }
      };
    }
  }

  function renderLeaksZone() {
    const snap = state.snap;
    const dict = t();
    const el = $('leaks-zone');
    if (!snap || !el) return;

    const audit = snap.quotaAudit;
    if (!audit || audit.sessionCount === 0) {
      el.innerHTML = '';
      return;
    }

    const findings = Array.isArray(audit.findings) ? audit.findings : [];
    const totalMissTurns = findings.reduce((acc, f) => acc + (f.count || 0), 0);
    const hasWaste = audit.totalWastedEffectiveTokens > 0 && findings.length > 0;
    const hitPct = Math.round((audit.overallCacheHitRatio || 0) * 100);

    if (!hasWaste) {
      el.innerHTML = `
        <div class="leaks-card">
          <div class="leaks-toggle" style="cursor:default">
            <span>✓ ${esc(dict.leaksSummaryClean(hitPct))}</span>
            <span class="leaks-badge clean">${esc(dict.leaksBadgeClean)}</span>
          </div>
        </div>
      `;
      return;
    }

    const groupsHtml = findings
      .map((f) => {
        const dom = shortModelName(f.dominantModel);
        const label =
          f.id === 'idle_ttl'
            ? dict.leakCause_idle(f.count)
            : f.id === 'model_switch'
            ? dict.leakCause_switch(f.count)
            : dict.leakCause_drop(f.count, dom);

        const evHtml = (f.evidence || [])
          .slice(0, 4)
          .map((ev) => {
            const gapTxt = ev.gapSec !== null && ev.gapSec !== undefined ? fmtCompactDuration(ev.gapSec) : '?';
            const meta =
              f.id === 'model_switch'
                ? dict.evSwitchMeta(ev.turnIndex, shortModelName(ev.prevModel) || '?', shortModelName(ev.model) || '?')
                : dict.evTurnMeta(ev.turnIndex, gapTxt);
            return `
              <div class="leak-ev-row" title="${esc(ev.prompt)}">
                <span class="leak-ev-sess">${esc(ev.sessionTitle)}</span>
                <span class="leak-ev-meta">${esc(meta)}</span>
                <span class="leak-ev-cost">+${esc(fmtTokens(ev.wastedEffectiveTokens))}</span>
              </div>
            `;
          })
          .join('');

        return `
          <div class="leak-group">
            <div class="leak-group-head">
              <span>${esc(label)}</span>
              <span class="leak-ev-cost">+${esc(fmtTokens(f.wastedEffectiveTokens))}</span>
            </div>
            ${evHtml}
          </div>
        `;
      })
      .join('');

    el.innerHTML = `
      <div class="leaks-card">
        <button type="button" class="leaks-toggle" id="btn-toggle-leaks" aria-expanded="${state.leaksOpen}">
          <span><span class="sec-chevron ${state.leaksOpen ? 'open' : ''}">▸</span> ${esc(dict.leaksSummaryWaste(totalMissTurns))}</span>
          <span class="leaks-badge">${esc(dict.leaksBadgeWaste(audit.wastedPercentOfTotal))}</span>
        </button>
        <div class="leaks-drawer ${state.leaksOpen ? '' : 'hidden'}">${groupsHtml}</div>
      </div>
    `;

    const toggleBtn = $('btn-toggle-leaks');
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        state.leaksOpen = !state.leaksOpen;
        renderLeaksZone();
      };
    }
  }

  function renderAll() {
    renderChrome();
    renderHeaderStatus();
    renderQuotaStripZone();
    renderCoachZone();
    renderExpiringZone();
    renderSessionsZone();
    renderLeaksZone();
  }

  // ---------- Live 1-Second Countdown Ticker ----------
  function tickCountdowns() {
    renderHeaderStatus();
    const dict = t();
    const now = Date.now();

    for (const el of document.querySelectorAll('[data-reset-ms]')) {
      const ms = Number(el.getAttribute('data-reset-ms'));
      const labelEl = el.querySelector('.quota-reset-label');
      if (!ms || !labelEl) continue;
      const remSec = Math.floor((ms - now) / 1000);
      labelEl.textContent = remSec > 0 ? dict.resetIn(fmtCompactDuration(remSec)) : dict.resetSoon;
    }

    const banner = $('live-cache-banner');
    if (banner) {
      const ctxTok = Number(banner.getAttribute('data-ctx-tokens')) || 0;
      const expMs = Number(banner.getAttribute('data-cache-expires-ms')) || 0;
      const lastMs = Number(banner.getAttribute('data-last-step-ms')) || 0;
      if (ctxTok >= 25_000 && expMs > 0) {
        const view = computeLiveCacheView(
          { contextTokens: ctxTok, cacheExpiresAtMs: expMs, lastStepAt: lastMs },
          now
        );
        banner.className = `cache-banner ${view.cls}`;
        const tEl = $('live-cache-title');
        const sEl = $('live-cache-sub');
        if (tEl) tEl.textContent = view.title;
        if (sEl) sEl.textContent = view.sub;
      }
    }

    for (const btn of document.querySelectorAll('[data-exp-ms]')) {
      const expMs = Number(btn.getAttribute('data-exp-ms')) || 0;
      const timeEl = btn.querySelector('.expiring-alert-time');
      if (!expMs || !timeEl) continue;
      const remSec = Math.max(0, Math.floor((expMs - now) / 1000));
      timeEl.textContent = dict.expiringRight(fmtCompactDuration(remSec, true));
    }
  }

  async function poll({ forceRefresh = false } = {}) {
    try {
      const conv = encodeURIComponent(currentConversationId());
      const etag = forceRefresh ? '' : encodeURIComponent(state.etag);
      const refreshParam = forceRefresh ? '&refresh=1' : '';
      const mockParam =
        params.get('mock') === '1'
          ? `&mock=1&mode=${encodeURIComponent(params.get('mode') || 'audit')}`
          : '';
      const data = await fetchApi(`/api/status?conversationId=${conv}&etag=${etag}${refreshParam}${mockParam}`);
      if (data.unchanged) {
        renderHeaderStatus();
        return;
      }
      state.etag = data.etag || '';
      state.snap = data;
      renderAll();
    } catch {
      // Keep last good state during transient restarts
    }
  }

  $('btn-lang').onclick = () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    renderAll();
  };

  $('btn-refresh').onclick = () => {
    poll({ forceRefresh: true });
  };

  $('btn-info').onclick = () => {
    state.infoOpen = !state.infoOpen;
    renderChrome();
  };

  $('btn-metric-mode').onclick = () => {
    state.metricMode = state.metricMode === 'effective' ? 'raw' : 'effective';
    renderAll();
  };

  renderChrome();
  poll();
  setInterval(() => poll(), POLL_INTERVAL_MS);
  setInterval(tickCountdowns, COUNTDOWN_TICK_MS);
})();
