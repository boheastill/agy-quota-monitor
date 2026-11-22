/**
 * Antigravity Quota Monitor — Sidecar Frontend.
 *
 * Polls `/api/status` with ETag deduplication, ticks reset countdowns locally every second,
 * syncs dark/light theme tokens from `/preload.js`, and supports instant ZH/EN switching.
 */
(() => {
  const POLL_INTERVAL_MS = 2500;
  const COUNTDOWN_TICK_MS = 1000;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const I18N = {
    zh: {
      title: '额度与负载',
      toggleLang: 'EN',
      secQuota: '全局剩余额度',
      secCurrent: '当前会话工作量',
      secRank: '最近会话消耗对比',
      formulaBtn: '这个数值怎么算的？',
      formulaTitle: '折算消耗说明（一眼对比哪个对话真正在花额度）',
      formulaExpr: '折算消耗 = 新输入 × 1 + 缓存读取 × 0.1 + 思考输出 × 4',
      formulaDesc:
        '命中缓存的历史上下文其实很便宜（按 1 折算），真正吃额度的是没命中缓存的新输入（1 倍）和模型的思考与回复（按 4 倍算）。按这个比例折算出来的数字，大概就代表每个对话真实花掉的额度/钱，方便直接横向对比谁吃得最多。',
      modeEffective: '折算消耗',
      modeRaw: '原始总 Token',
      staleBadge: '离线缓存',
      healthy: '充足',
      moderate: '适中',
      low: '即将耗尽',
      disabled: '不可用',
      resetsIn: (t) => `${t} 后重置`,
      resetSoon: '即将重置',
      noResetInfo: '周期滚动额度',
      creditsLabel: 'AI Credits 备用余额',
      overageOn: '超额自动抵扣已开',
      overageOff: '超额抵扣关闭',
      syncedJustNow: '刚刚更新',
      syncedAgo: (s) => `${s} 前同步`,
      refreshing: '正在向 agy CLI 同步云端额度…',
      initializingQuota: '正在首次读取云端额度（约 10–15 秒），本地会话统计已就绪…',
      localOnlySub: '本地会话监控已就绪 · 云端百分比待连接',
      cliMissingTitle: '未检测到 agy CLI（仅影响云端百分比条）',
      cliMissingDesc: '下方本地会话工作量已实时生效。若需展示顶部 5h/周剩余百分比，请安装官方 CLI 并执行一次 agy 登录：',
      authNeededTitle: '需要登录一次 agy CLI',
      authNeededDesc: '请在终端运行一次 `agy` 完成账号授权，随后点击右上角刷新即可读取云端额度。',
      errorTitle: '暂未读到云端额度',
      copyCmd: '复制命令',
      copied: '已复制到剪贴板',
      noBuckets: 'CLI 已返回数据，但当前账号暂无可展示的额度池。',
      noCurrentSession: '当前未绑定活动会话（发送一条消息后即会自动追踪）。',
      effUnit: '有效 Token',
      rawTotalPrefix: '原始总计',
      cacheHitPrefix: '缓存命中',
      inpLabel: '新输入 Input',
      cacheLabel: '缓存读取 Cache',
      outLabel: '思考输出 Output',
      turnsCount: (n) => `${n} 轮问答`,
      stepsCount: (n) => `${n} 步推理`,
      subagentsCount: (n) => `含 ${n} 个子智能体`,
      turnsBreakdown: (n) => `查看各轮对话消耗明细 (${n})`,
      cacheExpiredBadge: '⚠ 缓存过期重算',
      currentBadge: '当前会话',
      noSessions: '暂无本地会话记录',
      openConvTip: '点击跳转到该会话',
    },
    en: {
      title: 'Quota & Workload',
      toggleLang: '中文',
      secQuota: 'Global Quota Pools',
      secCurrent: 'Current Session Workload',
      secRank: 'Recent Sessions Comparison',
      formulaBtn: 'How is this calculated?',
      formulaTitle: 'Estimated Load (Compare real quota burn across chats)',
      formulaExpr: 'Estimated Load = Input × 1 + Cache Read × 0.1 + Output × 4',
      formulaDesc:
        'Cached context reads are ~90% cheaper (0.1x), while uncached new input (1x) and model thinking + replies (4x) are what actually eat your quota. This weighted number reflects roughly how much real quota/cost each session consumed.',
      modeEffective: 'Est. Load',
      modeRaw: 'Raw Tokens',
      staleBadge: 'Cached',
      healthy: 'Healthy',
      moderate: 'Moderate',
      low: 'Low',
      disabled: 'Disabled',
      resetsIn: (t) => `Resets in ${t}`,
      resetSoon: 'Resetting soon',
      noResetInfo: 'Rolling window',
      creditsLabel: 'AI Credits Balance',
      overageOn: 'Overage fallback ON',
      overageOff: 'Overage fallback OFF',
      syncedJustNow: 'Synced just now',
      syncedAgo: (s) => `Synced ${s} ago`,
      refreshing: 'Syncing cloud quota via agy CLI…',
      initializingQuota: 'Fetching initial cloud quota (~10–15s); local session stats ready…',
      localOnlySub: 'Local session tracking active · Cloud % pending CLI',
      cliMissingTitle: 'agy CLI not detected (cloud % bar only)',
      cliMissingDesc: 'Local session workload tracking below works out-of-the-box. To enable 5h/weekly cloud % bars, install the official CLI and sign in once:',
      authNeededTitle: 'One-time agy CLI sign-in needed',
      authNeededDesc: 'Run `agy` once in your terminal to sign in, then click Refresh above.',
      errorTitle: 'Cloud quota temporarily unavailable',
      copyCmd: 'Copy',
      copied: 'Copied to clipboard',
      noBuckets: 'CLI connected, but no quota buckets were returned for this account.',
      noCurrentSession: 'No active session bound yet (send a message to begin tracking).',
      effUnit: 'eff tokens',
      rawTotalPrefix: 'Total',
      cacheHitPrefix: 'Cache',
      inpLabel: 'Uncached Input',
      cacheLabel: 'Cache Read',
      outLabel: 'Thinking + Output',
      turnsCount: (n) => `${n} ${n === 1 ? 'turn' : 'turns'}`,
      stepsCount: (n) => `${n} ${n === 1 ? 'step' : 'steps'}`,
      subagentsCount: (n) => `+${n} ${n === 1 ? 'subagent' : 'subagents'}`,
      turnsBreakdown: (n) => `Per-turn breakdown (${n})`,
      cacheExpiredBadge: '⚠ Cache expired reload',
      currentBadge: 'Current',
      noSessions: 'No local session transcripts found yet.',
      openConvTip: 'Click to open conversation',
    },
  };

  const detectDefaultLang = () => {
    const q = params.get('lang');
    if (q === 'en' || q === 'zh') return q;
    return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  };

  const state = {
    lang: detectDefaultLang(),
    metricMode: 'effective', // 'effective' | 'raw'
    formulaOpen: false,
    turnsOpen: false,
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
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const scheme = luminance < 0.5 ? 'dark' : 'light';
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
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(2)}k`;
    return String(Math.round(v));
  }

  function fmtDurationSec(sec) {
    const s = Math.max(0, Math.floor(sec));
    if (s < 60) return `${s}s`;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m`;
  }

  function tierOfFraction(frac) {
    if (frac < 0.2) return 'danger';
    if (frac < 0.5) return 'warn';
    return 'ok';
  }

  function tierLabel(tier) {
    const dict = t();
    if (tier === 'danger') return dict.low;
    if (tier === 'warn') return dict.moderate;
    return dict.healthy;
  }

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add('hidden'), 1800);
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

  // ---------- Rendering ----------
  function renderStaticChrome() {
    const dict = t();
    document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
    $('ui-title').textContent = dict.title;
    $('btn-lang').textContent = dict.toggleLang;
    $('sec-quota-title').textContent = dict.secQuota;
    $('sec-current-title').textContent = dict.secCurrent;
    $('sec-rank-title').textContent = dict.secRank;
    $('ui-formula-btn-label').textContent = dict.formulaBtn;
    $('ui-formula-title').textContent = dict.formulaTitle;
    $('ui-formula-expr').textContent = dict.formulaExpr;
    $('ui-formula-desc').textContent = dict.formulaDesc;
    $('mode-effective').textContent = dict.modeEffective;
    $('mode-raw').textContent = dict.modeRaw;
    $('quota-stale-badge').textContent = dict.staleBadge;

    $('mode-effective').classList.toggle('active', state.metricMode === 'effective');
    $('mode-effective').setAttribute('aria-pressed', String(state.metricMode === 'effective'));
    $('mode-raw').classList.toggle('active', state.metricMode === 'raw');
    $('mode-raw').setAttribute('aria-pressed', String(state.metricMode === 'raw'));

    $('formula-popover').classList.toggle('hidden', !state.formulaOpen);
    $('btn-formula-info').setAttribute('aria-expanded', String(state.formulaOpen));
  }

  function renderHeaderStatus() {
    const snap = state.snap;
    const dict = t();
    if (!snap) return;

    const q = snap.quota || {};
    $('icon-refresh').classList.toggle('spinning', Boolean(q.refreshing));
    $('quota-stale-badge').classList.toggle('hidden', !q.stale);
    $('quota-stale-badge').className = q.stale ? 'badge warn' : 'badge hidden';

    const worstBucket = (q.buckets || [])
      .filter((b) => !b.disabled)
      .reduce((min, b) => (b.remainingFraction < min ? b.remainingFraction : min), 1);
    $('live-dot').classList.toggle('warn', q.status !== 'ok' || worstBucket < 0.2);

    if (q.refreshing) {
      $('ui-subtitle').textContent = dict.refreshing;
      return;
    }
    if (q.status === 'ok' && q.fetchedAtMs) {
      const elapsedSec = Math.max(0, Math.round((Date.now() - q.fetchedAtMs) / 1000));
      $('ui-subtitle').textContent =
        elapsedSec < 8 ? dict.syncedJustNow : dict.syncedAgo(fmtDurationSec(elapsedSec));
    } else {
      $('ui-subtitle').textContent = dict.localOnlySub;
    }
  }

  function renderQuotaSection() {
    const snap = state.snap;
    const dict = t();
    const container = $('quota-body');
    if (!snap) return;
    const q = snap.quota || {};

    if (q.status === 'initializing' && (!q.buckets || !q.buckets.length)) {
      container.innerHTML = `<div class="card empty-state">${esc(dict.initializingQuota)}</div>`;
      return;
    }

    if (q.status === 'cli_missing' || q.status === 'auth_needed' || (q.status === 'error' && (!q.buckets || !q.buckets.length))) {
      const title =
        q.status === 'cli_missing'
          ? dict.cliMissingTitle
          : q.status === 'auth_needed'
          ? dict.authNeededTitle
          : dict.errorTitle;
      const desc =
        q.status === 'cli_missing'
          ? dict.cliMissingDesc
          : q.status === 'auth_needed'
          ? dict.authNeededDesc
          : esc(q.errorMessage || '');
      const cmd = q.status === 'cli_missing' ? q.cliHint : 'agy';

      container.innerHTML = `
        <div class="card setup-card">
          <div class="setup-title">${esc(title)}</div>
          <p class="setup-desc">${esc(desc)}</p>
          ${
            q.status === 'cli_missing' || q.status === 'auth_needed'
              ? `<div class="cmd-box">
                   <code class="cmd-text" id="cli-cmd-text">${esc(cmd)}</code>
                   <button type="button" class="ghost-btn" id="btn-copy-cmd">${esc(dict.copyCmd)}</button>
                 </div>`
              : ''
          }
        </div>
      `;
      const copyBtn = $('btn-copy-cmd');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            showToast(dict.copied);
          } catch {
            // Fallback selection when clipboard API is restricted
            const range = document.createRange();
            range.selectNodeContents($('cli-cmd-text'));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        };
      }
      return;
    }

    const buckets = q.buckets || [];
    if (!buckets.length) {
      container.innerHTML = `<div class="card empty-state">${esc(dict.noBuckets)}</div>`;
      return;
    }

    const now = Date.now();
    const rowsHtml = buckets
      .map((b) => {
        if (b.disabled) {
          return `
            <div class="quota-row">
              <div class="quota-top">
                <span class="quota-label">${esc(b.label)}</span>
                <span class="badge neutral">${esc(dict.disabled)}</span>
              </div>
            </div>
          `;
        }
        const tier = tierOfFraction(b.remainingFraction);
        const pctText = `${b.remainingPercent.toFixed(b.remainingPercent % 1 === 0 ? 0 : 1)}%`;
        const widthPct = Math.max(2, Math.min(100, b.remainingPercent));
        let resetText = dict.noResetInfo;
        if (b.resetAtMs) {
          const remSec = Math.floor((b.resetAtMs - now) / 1000);
          resetText = remSec > 0 ? dict.resetsIn(fmtDurationSec(remSec)) : dict.resetSoon;
        }
        return `
          <div class="quota-row" data-reset-ms="${b.resetAtMs || ''}" title="${esc(b.description || b.label)}">
            <div class="quota-top">
              <span class="quota-label">${esc(b.label)}</span>
              <div class="quota-right">
                <span class="badge ${tier}">${esc(tierLabel(tier))}</span>
                <span class="quota-pct">${esc(pctText)}</span>
              </div>
            </div>
            <div class="bar-track" role="progressbar" aria-valuenow="${Math.round(b.remainingPercent)}" aria-valuemin="0" aria-valuemax="100">
              <div class="bar-fill ${tier}" style="width:${widthPct}%"></div>
            </div>
            <div class="quota-meta">
              <span class="quota-reset-label">${esc(resetText)}</span>
              <span>${esc((b.remainingFraction * 100).toFixed(2))}%</span>
            </div>
          </div>
        `;
      })
      .join('');

    let creditsHtml = '';
    if (q.credits && (q.credits.balance !== null || q.credits.overageEnabled !== null)) {
      const bal = q.credits.balance !== null ? String(q.credits.balance) : '—';
      const overageNote =
        q.credits.overageEnabled === true
          ? dict.overageOn
          : q.credits.overageEnabled === false
          ? dict.overageOff
          : '';
      creditsHtml = `
        <div class="credits-strip">
          <span>${esc(dict.creditsLabel)}${overageNote ? ` · <small style="color:var(--qm-muted)">${esc(overageNote)}</small>` : ''}</span>
          <span class="credits-val">${esc(bal)}</span>
        </div>
      `;
    }

    container.innerHTML = `<div class="card">${rowsHtml}${creditsHtml}</div>`;
  }

  function renderCurrentSession() {
    const snap = state.snap;
    const dict = t();
    const container = $('current-session-body');
    if (!snap) return;

    const cur = snap.currentSession;
    if (!cur) {
      container.innerHTML = `<div class="card empty-state">${esc(dict.noCurrentSession)}</div>`;
      return;
    }

    const cachePct = Math.round((cur.cacheHitRatio || 0) * 100);
    const cacheBadgeClass = cachePct >= 50 ? 'ok' : cachePct > 0 ? 'neutral' : 'warn';

    const turns = Array.isArray(cur.turns) ? cur.turns : [];
    const maxTurnVal = Math.max(
      1,
      ...turns.map((tr) => (state.metricMode === 'effective' ? tr.effectiveTokens : tr.totalTokens))
    );

    const turnsListHtml = turns
      .slice()
      .reverse()
      .map((tr) => {
        const val = state.metricMode === 'effective' ? tr.effectiveTokens : tr.totalTokens;
        const pct = Math.max(3, Math.round((val / maxTurnVal) * 100));
        return `
          <div class="turn-item">
            <div class="turn-head">
              <span class="turn-prompt" title="${esc(tr.prompt)}">#${tr.turnIndex} ${esc(tr.prompt)}</span>
              <span class="turn-num">
                ${tr.cacheExpiredSpike ? `<span class="badge warn" style="margin-right:4px">${esc(dict.cacheExpiredBadge)}</span>` : ''}
                ${esc(fmtTokens(val))}
              </span>
            </div>
            <div class="turn-bar-track">
              <div class="bar-fill primary" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');

    const modelPills = (cur.models || [])
      .map((m) => `<span class="meta-pill">${esc(m)}</span>`)
      .join('');

    container.innerHTML = `
      <div class="card session-hero">
        <div class="session-hero-title">${esc(cur.title)}</div>
        <div class="hero-metrics">
          <div>
            <span class="hero-primary-num">${esc(fmtTokens(cur.effectiveTokens))}</span>
            <span class="hero-primary-unit">${esc(dict.effUnit)}</span>
          </div>
          <div class="hero-secondary">
            ${esc(dict.rawTotalPrefix)} ${esc(fmtTokens(cur.totalTokens))} ·
            <span class="badge ${cacheBadgeClass}">${esc(dict.cacheHitPrefix)} ${cachePct}%</span>
          </div>
        </div>

        <div class="token-grid">
          <div class="token-cell">
            <span class="token-cell-label">${esc(dict.inpLabel)}</span>
            <span class="token-cell-val">${esc(fmtTokens(cur.inputTokens))}</span>
          </div>
          <div class="token-cell">
            <span class="token-cell-label">${esc(dict.cacheLabel)}</span>
            <span class="token-cell-val">${esc(fmtTokens(cur.cacheReadTokens))}</span>
          </div>
          <div class="token-cell">
            <span class="token-cell-label">${esc(dict.outLabel)}</span>
            <span class="token-cell-val">${esc(fmtTokens(cur.outputTokens))}</span>
          </div>
        </div>

        <div class="meta-pills">
          <span class="meta-pill">${esc(dict.turnsCount(cur.turnCount))}</span>
          <span class="meta-pill">${esc(dict.stepsCount(cur.plannerSteps))}</span>
          ${cur.subagentCount > 0 ? `<span class="meta-pill">${esc(dict.subagentsCount(cur.subagentCount))}</span>` : ''}
          ${modelPills}
        </div>

        ${
          turns.length > 0
            ? `<details class="turns-details" id="turns-details" ${state.turnsOpen ? 'open' : ''}>
                 <summary class="turns-summary">${esc(dict.turnsBreakdown(turns.length))}</summary>
                 <div class="turns-list">${turnsListHtml}</div>
               </details>`
            : ''
        }
      </div>
    `;

    const detailsEl = $('turns-details');
    if (detailsEl) {
      detailsEl.addEventListener('toggle', () => {
        state.turnsOpen = detailsEl.open;
      });
    }
  }

  function renderSessionsLeaderboard() {
    const snap = state.snap;
    const dict = t();
    const container = $('sessions-body');
    if (!snap) return;

    const list = Array.isArray(snap.sessions) ? snap.sessions.slice() : [];
    if (!list.length) {
      container.innerHTML = `<div class="card empty-state">${esc(dict.noSessions)}</div>`;
      return;
    }

    const metricOf = (s) => (state.metricMode === 'effective' ? s.effectiveTokens : s.totalTokens);
    list.sort((a, b) => metricOf(b) - metricOf(a));

    const maxMetric = Math.max(1, ...list.map(metricOf));
    const canJump = Boolean(window.sidecar?.ui?.toggleConversation);

    container.innerHTML = list
      .map((s, idx) => {
        const val = metricOf(s);
        const pct = Math.max(3, Math.round((val / maxMetric) * 100));
        const isCurrent = snap.activeConversationId && s.conversationId === snap.activeConversationId;
        const cachePct = Math.round((s.cacheHitRatio || 0) * 100);
        return `
          <div class="session-row ${isCurrent ? 'is-active' : ''} ${canJump && !isCurrent ? 'clickable' : ''}"
               role="listitem"
               data-conv-id="${esc(s.conversationId)}"
               title="${canJump && !isCurrent ? esc(dict.openConvTip) : esc(s.title)}">
            <div class="session-row-top">
              <div class="session-row-title-wrap">
                <span class="session-rank">#${idx + 1}</span>
                <span class="session-title">${esc(s.title)}</span>
                ${isCurrent ? `<span class="badge ok">${esc(dict.currentBadge)}</span>` : ''}
              </div>
              <span class="session-metric">${esc(fmtTokens(val))}</span>
            </div>
            <div class="bar-track" style="height:5px">
              <div class="bar-fill ${isCurrent ? 'primary' : 'ok'}" style="width:${pct}%"></div>
            </div>
            <div class="session-row-sub">
              <span>${esc(dict.turnsCount(s.turnCount))} · ${esc(dict.stepsCount(s.plannerSteps))}${s.subagentCount ? ` · ${esc(dict.subagentsCount(s.subagentCount))}` : ''}</span>
              <span>${esc(dict.cacheHitPrefix)} ${cachePct}% · ${esc(dict.rawTotalPrefix)} ${esc(fmtTokens(s.totalTokens))}</span>
            </div>
          </div>
        `;
      })
      .join('');

    if (canJump) {
      for (const row of container.querySelectorAll('.session-row.clickable')) {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-conv-id');
          if (id && window.sidecar?.ui?.toggleConversation) {
            window.sidecar.ui.toggleConversation(id);
          }
        });
      }
    }
  }

  function renderAll() {
    renderStaticChrome();
    renderHeaderStatus();
    renderQuotaSection();
    renderCurrentSession();
    renderSessionsLeaderboard();
  }

  // ---------- Live Countdown Ticker (no server round-trip needed) ----------
  function tickCountdowns() {
    renderHeaderStatus();
    const dict = t();
    const now = Date.now();
    for (const row of document.querySelectorAll('.quota-row[data-reset-ms]')) {
      const ms = Number(row.getAttribute('data-reset-ms'));
      const labelEl = row.querySelector('.quota-reset-label');
      if (!ms || !labelEl) continue;
      const remSec = Math.floor((ms - now) / 1000);
      labelEl.textContent = remSec > 0 ? dict.resetsIn(fmtDurationSec(remSec)) : dict.resetSoon;
    }
  }

  // ---------- Polling & Event Listeners ----------
  async function poll({ forceRefresh = false } = {}) {
    try {
      const conv = encodeURIComponent(currentConversationId());
      const etag = forceRefresh ? '' : encodeURIComponent(state.etag);
      const refreshFlag = forceRefresh ? '&refresh=1' : '';
      const data = await fetchApi(`/api/status?conversationId=${conv}&etag=${etag}${refreshFlag}`);
      if (data.unchanged) {
        renderHeaderStatus();
        return;
      }
      state.etag = data.etag || '';
      state.snap = data;
      renderAll();
    } catch {
      // Keep last good render if sidecar is briefly restarting
    }
  }

  $('btn-lang').addEventListener('click', () => {
    state.lang = state.lang === 'zh' ? 'en' : 'zh';
    renderAll();
  });

  $('btn-refresh').addEventListener('click', () => {
    poll({ forceRefresh: true });
  });

  $('btn-formula-info').addEventListener('click', () => {
    state.formulaOpen = !state.formulaOpen;
    renderStaticChrome();
  });

  $('mode-effective').addEventListener('click', () => {
    if (state.metricMode !== 'effective') {
      state.metricMode = 'effective';
      renderAll();
    }
  });

  $('mode-raw').addEventListener('click', () => {
    if (state.metricMode !== 'raw') {
      state.metricMode = 'raw';
      renderAll();
    }
  });

  renderStaticChrome();
  poll();
  setInterval(() => poll(), POLL_INTERVAL_MS);
  setInterval(tickCountdowns, COUNTDOWN_TICK_MS);
})();
