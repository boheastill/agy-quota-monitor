/**
 * Antigravity Quota Monitor v2.0 — Minimalist Single-Screen Instrument Cluster.
 *
 * Features:
 * - Dual SVG radial gauges for Gemini 5h & 7d pools (with 7d Time-Pace marker dot)
 * - EWMA half-life burn-rate & runout forecast
 * - Collapsible 1-line strip for secondary pools (Claude/GPT) & non-zero AI Credits
 * - Unified single-screen session micro-bars with hover tooltips & click-to-expand turn drawer
 */
(() => {
  const POLL_INTERVAL_MS = 2500;
  const COUNTDOWN_TICK_MS = 1000;
  const MAX_VISIBLE_SESSIONS = 6;
  const RING_RADIUS = 26;
  const RING_CIRC = 2 * Math.PI * RING_RADIUS; // 163.3628

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const I18N = {
    zh: {
      title: 'Quota',
      toggleLang: 'EN',
      infoPaceTitle: '圆环刻度点与续航预测（EWMA 半衰期算法）',
      infoPaceDesc:
        '• 7d 圆环上的小圆点代表「本周剩余时间比例」：色环包住圆点说明额度比时间充裕，退到圆点后说明超速。\n• 续航预测采用指数衰减加权（5h 半衰期 30 分钟，7d 半衰期 12 小时融合周期基线）：越近的操作权重越高，兼顾灵敏度与稳定性。',
      infoLoadTitle: '会话折算消耗口径',
      infoLoadExpr: '折算消耗 = 新输入 × 1 + 缓存读取 × 0.1 + 思考输出 × 4',
      infoLoadDesc:
        '命中缓存的旧上下文约打 1 折，思考与输出约为新输入的 4 倍。折算值反映哪个对话真正在花你的额度（悬停任意会话可看原始三项明细）。',
      sessionsHeading: '会话消耗',
      modeEffective: '折算消耗 ⇄',
      modeRaw: '原始总计 ⇄',
      justNow: '刚刚',
      ago: (t) => `${t}前`,
      syncing: '同步中…',
      staleTag: '缓存',
      initQuota: '正在首次读取云端额度（约 10–15 秒）…',
      localOnly: '本地已就绪',
      cliMissingTitle: '未装 agy CLI（装后即可显示顶部圆环）',
      authNeededTitle: '请在终端运行一次 agy 完成登录',
      errorTitle: '暂未读到云端额度',
      copy: '复制',
      copied: '已复制命令',
      gemini5h: 'Gemini · 5h',
      gemini7d: 'Gemini · 本周',
      otherGroup: 'Claude / GPT',
      creditsShort: 'Credits',
      resetIn: (t) => `${t} 重置`,
      resetSoon: '即将重置',
      safeReset: '✓ 撑到重置宽裕',
      steadyPace: '✓ 节奏稳健',
      estSpare: (p) => `预计余 ~${p}%`,
      exhaustIn: (t) => `⚡ 约 ${t} 耗尽`,
      exhaust7dIn: (t) => `⚠ 约 ${t} 见底`,
      disabled: '不可用',
      tickTip: (timePct, quotaPct) =>
        `本周剩余时间 ${timePct}% · 剩余额度 ${quotaPct}%（圆点为时间刻度线）`,
      rateTip: (rate) => (rate > 0 ? `近期加权消耗速率 ~${rate}%/h` : '近期几乎无消耗'),
      noSessions: '暂无会话记录',
      inpShort: '新输入',
      cacheShort: '缓存',
      outShort: '输出',
      rawShort: '原始',
      turnsShort: (n) => `${n}轮`,
      stepsShort: (n) => `${n}步`,
      subShort: (n) => `+${n}子代理`,
      spikeBadge: '⚠缓存重算',
      sessionHoverTip: (s, cachePct, fmt) =>
        `${s.title}\n${s.turnCount} 轮 · ${s.plannerSteps} 步${s.subagentCount ? ` · 含 ${s.subagentCount} 个子代理` : ''}\n缓存命中 ${cachePct}% · 原始总计 ${fmt(s.totalTokens)}\n新输入 ${fmt(s.inputTokens)} / 缓存 ${fmt(s.cacheReadTokens)} / 输出 ${fmt(s.outputTokens)}`,
      clickExpandTip: '（点击展开每轮明细）',
      clickJumpTip: '（点击切换到该会话）',
    },
    en: {
      title: 'Quota',
      toggleLang: '中',
      infoPaceTitle: 'Time-Pace Dot & EWMA Burn Forecast',
      infoPaceDesc:
        '• The dot on the 7d ring marks remaining week time: arc ahead of dot = ahead of pace; behind dot = burning fast.\n• Burn-rate uses exponentially weighted decay (30m half-life for 5h, 12h half-life + cycle baseline for 7d) for responsive, non-jumpy estimates.',
      infoLoadTitle: 'Estimated Session Load',
      infoLoadExpr: 'Est. Load = Input × 1 + Cache × 0.1 + Output × 4',
      infoLoadDesc:
        'Cached context reads cost ~10% of new input, while thinking + replies cost ~4x. Hover any session row for full raw breakdown.',
      sessionsHeading: 'Sessions',
      modeEffective: 'Est. Load ⇄',
      modeRaw: 'Raw Tokens ⇄',
      justNow: 'just now',
      ago: (t) => `${t} ago`,
      syncing: 'syncing…',
      staleTag: 'cached',
      initQuota: 'Fetching initial cloud quota (~10–15s)…',
      localOnly: 'local ready',
      cliMissingTitle: 'Install agy CLI to enable top quota rings',
      authNeededTitle: 'Run `agy` once in terminal to sign in',
      errorTitle: 'Cloud quota unavailable',
      copy: 'Copy',
      copied: 'Copied',
      gemini5h: 'Gemini · 5h',
      gemini7d: 'Gemini · 7d',
      otherGroup: 'Claude / GPT',
      creditsShort: 'Credits',
      resetIn: (t) => `${t} left`,
      resetSoon: 'resetting',
      safeReset: '✓ Safe to reset',
      steadyPace: '✓ On pace',
      estSpare: (p) => `Est. ~${p}% spare`,
      exhaustIn: (t) => `⚡ ~${t} to zero`,
      exhaust7dIn: (t) => `⚠ ~${t} to zero`,
      disabled: 'Disabled',
      tickTip: (timePct, quotaPct) =>
        `Week time left ${timePct}% · Quota left ${quotaPct}% (dot marks linear time pace)`,
      rateTip: (rate) => (rate > 0 ? `Weighted burn ~${rate}%/h` : 'Minimal recent burn'),
      noSessions: 'No sessions yet',
      inpShort: 'In',
      cacheShort: 'Cache',
      outShort: 'Out',
      rawShort: 'Raw',
      turnsShort: (n) => `${n}t`,
      stepsShort: (n) => `${n}s`,
      subShort: (n) => `+${n} sub`,
      spikeBadge: '⚠Cache reload',
      sessionHoverTip: (s, cachePct, fmt) =>
        `${s.title}\n${s.turnCount} turns · ${s.plannerSteps} steps${s.subagentCount ? ` · +${s.subagentCount} subagents` : ''}\nCache ${cachePct}% · Raw total ${fmt(s.totalTokens)}\nInput ${fmt(s.inputTokens)} / Cache ${fmt(s.cacheReadTokens)} / Output ${fmt(s.outputTokens)}`,
      clickExpandTip: ' (Click for per-turn breakdown)',
      clickJumpTip: ' (Click to switch session)',
    },
  };

  const detectLang = () => {
    const q = params.get('lang');
    if (q === 'en' || q === 'zh') return q;
    return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  };

  const state = {
    lang: detectLang(),
    metricMode: 'effective', // 'effective' | 'raw'
    infoOpen: false,
    secOpen: false,
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

  function fmtCompactDuration(sec) {
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return `${s}s`;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m`;
  }

  function colorTierForBucket(b) {
    if (b.remainingFraction < 0.2 || b.pace?.status === 'exhausting') return 'danger';
    if (b.remainingFraction < 0.5 || b.pace?.willExhaustBeforeReset) return 'warn';
    return 'ok';
  }

  function formatPaceLine(b) {
    const dict = t();
    const p = b.pace;
    if (!p) return { text: dict.steadyPace, cls: 'steady' };

    if (p.willExhaustBeforeReset && p.estimatedTimeLeftSec) {
      const dur = fmtCompactDuration(p.estimatedTimeLeftSec);
      const is7d = p.windowKind === '7d';
      const cls = p.status === 'exhausting' || b.remainingFraction < 0.2 ? 'danger' : 'warn';
      return { text: is7d ? dict.exhaust7dIn(dur) : dict.exhaustIn(dur), cls };
    }

    if (p.windowKind === '7d' && p.projectedRemainingPercent !== null) {
      const cls = p.projectedRemainingPercent >= 25 ? 'ok' : p.projectedRemainingPercent >= 10 ? 'steady' : 'warn';
      return { text: dict.estSpare(p.projectedRemainingPercent), cls };
    }

    return { text: dict.safeReset, cls: 'ok' };
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
    showToast._t = setTimeout(() => el.classList.add('hidden'), 1600);
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

  // ---------- Renderers ----------
  function renderChrome() {
    const dict = t();
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    $('ui-title').textContent = dict.title;
    $('btn-lang').textContent = dict.toggleLang;
    $('ui-info-pace-title').textContent = dict.infoPaceTitle;
    $('ui-info-pace-desc').innerHTML = esc(dict.infoPaceDesc).replace(/\n/g, '<br>');
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
    const hasWarn = activeBuckets.some((b) => colorTierForBucket(b) === 'warn');
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

  function buildRadialGaugeHtml(b, nowMs) {
    const dict = t();
    const tier = colorTierForBucket(b);
    const pctRound = Math.round(b.remainingPercent);
    const dashOffset = (RING_CIRC * (1 - Math.max(0, Math.min(1, b.remainingFraction)))).toFixed(2);
    const paceInfo = formatPaceLine(b);

    let resetText = '';
    if (b.resetAtMs) {
      const remSec = Math.floor((b.resetAtMs - nowMs) / 1000);
      resetText = remSec > 0 ? dict.resetIn(fmtCompactDuration(remSec)) : dict.resetSoon;
    }

    // Time-Pace Marker Dot on 7d ring
    let tickSvg = '';
    const timeFrac = b.pace?.timeRemainingFraction;
    if (b.pace?.windowKind === '7d' && typeof timeFrac === 'number' && timeFrac > 0 && timeFrac < 1) {
      const angle = timeFrac * 2 * Math.PI;
      const cx = (32 + RING_RADIUS * Math.cos(angle)).toFixed(2);
      const cy = (32 + RING_RADIUS * Math.sin(angle)).toFixed(2);
      tickSvg = `<circle class="ring-tick" cx="${cx}" cy="${cy}" r="3.1" />`;
    }

    const tooltipLines = [
      `${b.label}: ${b.remainingPercent.toFixed(2)}%`,
      b.pace?.windowKind === '7d' && typeof timeFrac === 'number'
        ? dict.tickTip(Math.round(timeFrac * 100), pctRound)
        : '',
      b.pace ? dict.rateTip(b.pace.burnRatePctPerHour) : '',
      b.description || '',
    ].filter(Boolean);

    return `
      <div class="gauge-card" data-reset-ms="${b.resetAtMs || ''}" title="${esc(tooltipLines.join('\n'))}">
        <div class="ring-wrap">
          <svg class="ring-svg" viewBox="0 0 64 64" aria-hidden="true">
            <circle class="ring-track" cx="32" cy="32" r="${RING_RADIUS}" />
            <circle class="ring-arc ${tier}" cx="32" cy="32" r="${RING_RADIUS}"
                    stroke-dasharray="${RING_CIRC.toFixed(2)}"
                    stroke-dashoffset="${dashOffset}" />
            ${tickSvg}
          </svg>
          <div class="ring-center">${pctRound}%</div>
        </div>
        <div class="gauge-meta">
          <div class="gauge-title">${esc(shortGaugeTitle(b))}</div>
          <div class="gauge-reset quota-reset-label">${esc(resetText)}</div>
          <div class="gauge-pace ${paceInfo.cls}">${esc(paceInfo.text)}</div>
        </div>
      </div>
    `;
  }

  function renderQuotaZones() {
    const snap = state.snap;
    const dict = t();
    const primaryEl = $('primary-quota-zone');
    const secondaryEl = $('secondary-quota-zone');
    if (!snap) return;

    const q = snap.quota || {};
    const buckets = Array.isArray(q.buckets) ? q.buckets : [];

    if (q.status === 'initializing' && buckets.length === 0) {
      primaryEl.innerHTML = `<div class="notice-card">${esc(dict.initQuota)}</div>`;
      secondaryEl.classList.add('hidden');
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

      primaryEl.innerHTML = `
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
      secondaryEl.classList.add('hidden');
      const copyBtn = $('btn-copy-cmd');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            showToast(dict.copied);
          } catch {
            // Ignore clipboard errors
          }
        };
      }
      return;
    }

    const nowMs = Date.now();
    const primaryBuckets = buckets.filter((b) => b.isPrimaryGemini && !b.disabled);
    const heroList = primaryBuckets.length > 0 ? primaryBuckets : buckets.slice(0, 2);
    const heroIds = new Set(heroList.map((b) => b.id));
    const secondaryBuckets = buckets.filter((b) => !heroIds.has(b.id));

    primaryEl.innerHTML = `
      <div class="gauge-grid ${heroList.length === 1 ? 'single' : ''}">
        ${heroList.map((b) => buildRadialGaugeHtml(b, nowMs)).join('')}
      </div>
    `;

    const nonZeroCredits = q.credits && typeof q.credits.balance === 'number' && q.credits.balance > 0 ? q.credits.balance : null;

    if (secondaryBuckets.length === 0 && nonZeroCredits === null) {
      secondaryEl.classList.add('hidden');
      return;
    }

    secondaryEl.classList.remove('hidden');
    const summaryPillsHtml = secondaryBuckets
      .map((b) => {
        const tier = colorTierForBucket(b);
        const colorStyle =
          tier === 'danger' ? 'color:var(--qm-danger)' : tier === 'warn' ? 'color:var(--qm-warn)' : '';
        return `
          <span class="sec-pill-item">
            <span class="sec-pill-win">${esc(b.shortWindowLabel)}</span>
            <span style="${colorStyle}">${b.disabled ? '—' : `${Math.round(b.remainingPercent)}%`}</span>
          </span>
        `;
      })
      .join('');

    const creditsPillHtml =
      nonZeroCredits !== null
        ? `<span class="sec-pill-item"><span class="sec-pill-win">${esc(dict.creditsShort)}</span><span>${esc(nonZeroCredits)}</span></span>`
        : '';

    const detailRowsHtml = secondaryBuckets
      .map((b) => {
        if (b.disabled) {
          return `
            <div class="sec-detail-row">
              <div class="sec-detail-top"><span>${esc(b.label)}</span><span>${esc(dict.disabled)}</span></div>
            </div>
          `;
        }
        const tier = colorTierForBucket(b);
        const pace = formatPaceLine(b);
        const remSec = b.resetAtMs ? Math.floor((b.resetAtMs - nowMs) / 1000) : 0;
        const resetTxt = b.resetAtMs ? (remSec > 0 ? dict.resetIn(fmtCompactDuration(remSec)) : dict.resetSoon) : '';
        return `
          <div class="sec-detail-row" data-reset-ms="${b.resetAtMs || ''}">
            <div class="sec-detail-top">
              <span>${esc(b.label)}</span>
              <span style="font-family:var(--qm-mono);font-weight:600">${esc(b.remainingPercent.toFixed(1))}%</span>
            </div>
            <div class="mini-bar-track">
              <div class="mini-bar-fill ${tier}" style="width:${Math.max(2, Math.min(100, b.remainingPercent))}%"></div>
            </div>
            <div class="sec-detail-sub">
              <span class="quota-reset-label">${esc(resetTxt)}</span>
              <span class="gauge-pace ${pace.cls}">${esc(pace.text)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    secondaryEl.innerHTML = `
      <div class="sec-strip">
        <button type="button" class="sec-summary-btn" id="btn-toggle-sec" aria-expanded="${state.secOpen}">
          <span class="sec-left">
            <span class="sec-chevron ${state.secOpen ? 'open' : ''}">▸</span>
            <span>${esc(dict.otherGroup)}</span>
          </span>
          <span class="sec-pills">${summaryPillsHtml}${creditsPillHtml}</span>
        </button>
        <div class="sec-drawer ${state.secOpen ? '' : 'hidden'}">${detailRowsHtml}</div>
      </div>
    `;

    const secBtn = $('btn-toggle-sec');
    if (secBtn) {
      secBtn.onclick = () => {
        state.secOpen = !state.secOpen;
        renderQuotaZones();
      };
    }
  }

  function renderSessionsZone() {
    const snap = state.snap;
    const dict = t();
    const listEl = $('sessions-list');
    if (!snap) return;

    const metricOf = (s) => (state.metricMode === 'effective' ? s.effectiveTokens : s.totalTokens);
    const all = Array.isArray(snap.sessions) ? snap.sessions.slice() : [];
    all.sort((a, b) => metricOf(b) - metricOf(a));

    // Ensure active conversation is always visible in the compact top-6 single-screen list
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
        const barPct = Math.max(4, Math.round((val / maxMetric) * 100));
        const cachePct = Math.round((fullSession.cacheHitRatio || 0) * 100);
        const isExpanded = state.expandedConvId === fullSession.conversationId;

        const actionHint = isCurrent ? dict.clickExpandTip : canJumpHost ? dict.clickJumpTip : '';
        const hoverTip = dict.sessionHoverTip(fullSession, cachePct, fmtTokens) + actionHint;

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
              <span class="s-marker" aria-hidden="true"></span>
              <span class="s-title">${esc(fullSession.title)}</span>
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

  function renderAll() {
    renderChrome();
    renderHeaderStatus();
    renderQuotaZones();
    renderSessionsZone();
  }

  // ---------- Live Countdown Ticker ----------
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
  }

  async function poll({ forceRefresh = false } = {}) {
    try {
      const conv = encodeURIComponent(currentConversationId());
      const etag = forceRefresh ? '' : encodeURIComponent(state.etag);
      const refreshParam = forceRefresh ? '&refresh=1' : '';
      const data = await fetchApi(`/api/status?conversationId=${conv}&etag=${etag}${refreshParam}`);
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
