/**
 * Antigravity Quota Monitor v3.0 — Low-Cognitive-Load Quota Audit UI.
 *
 * Designed to answer in plain language:
 *   "Where could prompt cache have saved 90% of my quota, why did it miss,
 *    how much extra % did I pay, which sessions caused it, and what change fixes it?"
 * With verifiable per-turn Evidence folded right underneath each finding.
 */
(() => {
  const POLL_INTERVAL_MS = 2500;
  const COUNTDOWN_TICK_MS = 1000;
  const MAX_VISIBLE_SESSIONS = 5;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const I18N = {
    zh: {
      title: 'Quota Audit',
      toggleLang: 'EN',
      infoAuditTitle: '什么是「本来能用缓存却没用到」？',
      infoAuditDesc:
        '续聊同一条长对话时，旧历史如果命中缓存只需要 0.1 倍额度；一旦缓存失效，整段历史会被按 1 倍全价重算——这一进一出你多付了 9 倍差价。面板自动扫描本地历史，把多花掉的额度按真实原因算清。',
      infoLoadTitle: '折算消耗口径',
      infoLoadExpr: '折算消耗 = 新输入 × 1 + 缓存读取 × 0.1 + 思考输出 × 4',
      infoLoadDesc:
        '本插件不替代底部模型下拉框的剩余余额，只专注审计哪些习惯或模型路由白花了额度。点开任意一条「证据」，都能核对到具体哪条会话、哪一轮、间隔几分钟。',
      sessionsHeading: '主要会话消耗',
      modeEffective: '折算消耗 ⇄',
      modeRaw: '原始总计 ⇄',
      justNow: '刚刚',
      ago: (t) => `${t}前`,
      syncing: '同步中…',
      staleTag: '缓存',
      initQuota: '正在同步额度…',
      localOnly: '本地审计就绪',
      cliMissingTitle: '装一次官方 agy CLI 即可同步顶部 5h / 周额度',
      authNeededTitle: '请在终端运行一次 agy 完成登录',
      errorTitle: '暂未读到云端额度',
      copy: '复制',
      copied: '已复制命令',
      gemini5h: 'Gemini · 5h',
      gemini7d: 'Gemini · 7d',
      otherGroup: 'Claude / GPT',
      creditsShort: 'Credits',
      resetIn: (t) => `${t} 后重置`,
      resetSoon: '即将重置',
      safeReset: '宽裕',
      estSpare: (p) => `余 ~${p}%`,
      exhaustIn: (t) => `⚡ 约 ${t} 耗尽`,
      // Audit hero
      auditKicker: '额度浪费审计',
      auditScope: (n, t) => `${n} 条会话 · ${t} 轮`,
      auditHeroWaste: (pct) => `约 ${pct}% 的额度多花在「没用到缓存」上`,
      auditHeroWasteSub: (turns, extra, saved) =>
        `有 ${turns} 轮本可以按 1 折读旧历史，实际按全价重算，多付了 ~${extra} 折算消耗（另已省下 ${saved}）。`,
      auditHeroClean: (hitPct) => `✓ 缓存利用率很好（${hitPct}% 命中，0 次大额失效）`,
      auditHeroCleanSub: (saved) => `靠缓存命中已为你省下约 ${saved} 折算消耗，暂无需要改的习惯。`,
      // Finding cards
      extraBadge: (pct) => `多付 +${pct}%`,
      whereLabel: '主要发生在：',
      moreCount: (n) => ` 等 ${n} 条会话`,
      evToggle: (n, extra) => `证据：查看 ${n} 轮具体记录（多花 +${extra}）`,
      evTurnMeta: (turnIdx, gap) => `#${turnIdx}轮 · 隔${gap}`,
      evSwitchMeta: (turnIdx, m1, m2) => `#${turnIdx}轮 · ${m1}→${m2}`,
      // 3 concrete causes
      causeTitle_capacity_drop: (dom) =>
        dom ? `60 分钟内继续聊却缓存归零（集中在使用 ${dom} 时）` : '60 分钟内继续聊却缓存意外归零',
      causeWhy_capacity_drop: (n, dom) =>
        `同一模型隔不到 1 小时就发生 ${n} 次整段缓存丢失${dom ? `（${dom} 最明显）` : ''}，大长对话每次重算都很肉疼。`,
      causeFix_capacity_drop: () =>
        '→ 怎么省：大上下文改代码优先留在 Neon；如果当前模型已经掉过一次缓存，直接开新对话带摘要过去。',

      causeTitle_idle_60m: () => '停顿超过 60 分钟，回来直接接着长对话继续发',
      causeWhy_idle_60m: (n) =>
        `缓存会在停顿满 60 分钟后过期清零；你超过 1 小时才回来接着旧对话发的 ${n} 轮里，旧历史全部按全价重算。`,
      causeFix_idle_60m: () =>
        '→ 怎么省：离开超 1 小时要做新任务时，点 `+ 新建对话`（或跑一次 /compact）再继续，通常直接省掉 90% 的重算。',

      causeTitle_model_switch: () => '在一条已经很长的对话里中途切换了模型',
      causeWhy_model_switch: (n) =>
        `中途切换模型（例如 Neon 与 Carbon 互切）会让旧缓存直接作废，共有 ${n} 轮当场触发全量重算。`,
      causeFix_model_switch: () =>
        '→ 怎么省：同个大对话尽量从头到尾用一个模型；确实要换强模型攻坚，另起一个新对话把需求贴过去。',

      noSessions: '暂无会话记录',
      inpShort: '新输入',
      cacheShort: '缓存',
      outShort: '输出',
      turnsShort: (n) => `${n}轮`,
      stepsShort: (n) => `${n}步`,
      subShort: (n) => `+${n}子代理`,
      spikeBadge: '⚠缓存重算',
      sessWasteTag: (extra) => `废-${extra}`,
      sessionHoverTip: (s, cachePct, fmt) =>
        `${s.title}\n${s.turnCount} 轮 · ${s.plannerSteps} 步${s.subagentCount ? ` · 含 ${s.subagentCount} 个子代理` : ''}\n缓存命中 ${cachePct}%${s.wastedEffectiveTokens ? ` · 可省浪费 ${fmt(s.wastedEffectiveTokens)}` : ''} · 原始总计 ${fmt(s.totalTokens)}`,
      clickExpandTip: '（点击展开每轮明细）',
      clickJumpTip: '（点击切换到该会话）',
    },
    en: {
      title: 'Quota Audit',
      toggleLang: '中',
      infoAuditTitle: 'What "missed cache you could have used" means',
      infoAuditDesc:
        'In an ongoing chat, reusing old context via warm prompt cache costs 0.1×. When cache misses, that same history is re-processed at 1.0× full price — a 10× jump on that turn. This panel audits local logs to show why it happened and how much extra you paid.',
      infoLoadTitle: 'Weighted Load Formula',
      infoLoadExpr: 'Est. Load = Input × 1 + Cache × 0.1 + Output × 4',
      infoLoadDesc:
        'Basic remaining % is already in Antigravity’s model picker; this tool audits avoidable waste. Open "Evidence" under any finding to verify the exact session, turn, and minute gap.',
      sessionsHeading: 'Top Sessions',
      modeEffective: 'Est. Load ⇄',
      modeRaw: 'Raw Tokens ⇄',
      justNow: 'just now',
      ago: (t) => `${t} ago`,
      syncing: 'syncing…',
      staleTag: 'cached',
      initQuota: 'Syncing quota…',
      localOnly: 'local audit ready',
      cliMissingTitle: 'Install official agy CLI to sync top 5h / 7d pools',
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
      safeReset: 'safe',
      estSpare: (p) => `~${p}% spare`,
      exhaustIn: (t) => `⚡ ~${t} left`,
      // Audit hero
      auditKicker: 'Quota Waste Audit',
      auditScope: (n, t) => `${n} sessions · ${t} turns`,
      auditHeroWaste: (pct) => `~${pct}% of your spend paid for missed cache`,
      auditHeroWasteSub: (turns, extra, saved) =>
        `${turns} turns re-loaded old history at full price instead of 0.1× warm cache — ${extra} extra load paid (${saved} saved elsewhere).`,
      auditHeroClean: (hitPct) => `✓ Clean cache usage (${hitPct}% hit · 0 major reloads)`,
      auditHeroCleanSub: (saved) => `Warm cache saved ~${saved} est. load so far. Nothing obvious leaking.`,
      // Finding cards
      extraBadge: (pct) => `+${pct}% spend`,
      whereLabel: 'Mostly in: ',
      moreCount: (n) => ` +${n} more`,
      evToggle: (n, extra) => `Evidence (${n} turns · +${extra} extra load)`,
      evTurnMeta: (turnIdx, gap) => `#${turnIdx} · ${gap} gap`,
      evSwitchMeta: (turnIdx, m1, m2) => `#${turnIdx} · ${m1}→${m2}`,
      // 3 concrete causes
      causeTitle_capacity_drop: (dom) =>
        dom ? `Cache dropped within 60m (mostly on ${dom})` : 'Cache dropped within 60m on the same model',
      causeWhy_capacity_drop: (n, dom) =>
        `Same-model turns lost their warm cache ${n} time${n === 1 ? '' : 's'} before the 1h expiry${dom ? ` — concentrated when running ${dom}` : ''}.`,
      causeFix_capacity_drop: () =>
        '→ How to save: keep heavy long-context coding on Neon; if a thread drops cache once, start fresh with a brief summary.',

      causeTitle_idle_60m: () => 'Resuming big threads after >60m idle',
      causeWhy_idle_60m: (n) =>
        `Antigravity drops warm cache after 60m idle. ${n === 1 ? 'This turn' : `All ${n} turns`} sent after a >1h break re-paid full price for the entire history.`,
      causeFix_idle_60m: () =>
        '→ How to save: when returning >1h later for a new subtask, open a fresh chat (or run /compact) instead of piling onto an old one.',

      causeTitle_model_switch: () => 'Switching models mid-thread on large contexts',
      causeWhy_model_switch: (n) =>
        `Switching models inside the same conversation (e.g. Neon ↔ Carbon) wipes the existing KV cache, triggering ${n} full cold reload${n === 1 ? '' : 's'}.`,
      causeFix_model_switch: () =>
        '→ How to save: stick to one model per long thread; if you need another model, start a clean thread with just the relevant context.',

      noSessions: 'No sessions yet',
      inpShort: 'In',
      cacheShort: 'Cache',
      outShort: 'Out',
      turnsShort: (n) => `${n}t`,
      stepsShort: (n) => `${n}s`,
      subShort: (n) => `+${n} sub`,
      spikeBadge: '⚠Cache reload',
      sessWasteTag: (extra) => `-${extra}`,
      sessionHoverTip: (s, cachePct, fmt) =>
        `${s.title}\n${s.turnCount} turns · ${s.plannerSteps} steps${s.subagentCount ? ` · +${s.subagentCount} subagents` : ''}\nCache ${cachePct}%${s.wastedEffectiveTokens ? ` · Avoidable waste ${fmt(s.wastedEffectiveTokens)}` : ''} · Raw ${fmt(s.totalTokens)}`,
      clickExpandTip: ' (Click for turn breakdown)',
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
    openEvidenceIds: new Set(),
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
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
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

  function normalizeAuditReasonKey(rawId) {
    if (rawId === 'early_drop' || rawId === 'capacity_drop') return 'capacity_drop';
    if (rawId === 'idle_ttl' || rawId === 'idle_60m') return 'idle_60m';
    return 'model_switch';
  }

  function renderAuditZone() {
    const snap = state.snap;
    const dict = t();
    const auditEl = $('audit-zone');
    if (!snap || !auditEl) return;

    const audit = snap.quotaAudit;
    if (!audit || audit.sessionCount === 0) {
      auditEl.innerHTML = '';
      return;
    }

    const findings = Array.isArray(audit.findings) ? audit.findings : [];
    const totalMissTurns = findings.reduce((acc, f) => acc + (f.count || 0), 0);
    const hasWaste = audit.totalWastedEffectiveTokens > 0 && findings.length > 0;
    const hitPct = Math.round((audit.overallCacheHitRatio || 0) * 100);

    const heroHtml = hasWaste
      ? `
        <div class="audit-hero has-waste">
          <div class="audit-hero-top">
            <span class="audit-hero-kicker">${esc(dict.auditKicker)}</span>
            <span class="audit-hero-scope">${esc(dict.auditScope(audit.sessionCount, audit.turnCount))}</span>
          </div>
          <div class="audit-hero-headline"><span class="hl-warn">${esc(dict.auditHeroWaste(audit.wastedPercentOfTotal))}</span></div>
          <div class="audit-hero-sub">${esc(dict.auditHeroWasteSub(totalMissTurns, fmtTokens(audit.totalWastedEffectiveTokens), fmtTokens(audit.totalSavedEffectiveTokens)))}</div>
        </div>
      `
      : `
        <div class="audit-hero clean">
          <div class="audit-hero-top">
            <span class="audit-hero-kicker">${esc(dict.auditKicker)}</span>
            <span class="audit-hero-scope">${esc(dict.auditScope(audit.sessionCount, audit.turnCount))}</span>
          </div>
          <div class="audit-hero-headline"><span class="hl-ok">${esc(dict.auditHeroClean(hitPct))}</span></div>
          <div class="audit-hero-sub">${esc(dict.auditHeroCleanSub(fmtTokens(audit.totalSavedEffectiveTokens)))}</div>
        </div>
      `;

    const cardsHtml = findings
      .map((f) => {
        const key = normalizeAuditReasonKey(f.id);
        const domModel = shortModelName(f.dominantModel);
        const title = dict[`causeTitle_${key}`](domModel);
        const why = dict[`causeWhy_${key}`](f.count, domModel);
        const fix = dict[`causeFix_${key}`](domModel);
        const isHigh = f.percentOfTotalSpend >= 8;

        const topSessNames = (f.topSessions || [])
          .slice(0, 2)
          .map((s) => `${s.title} (+${fmtTokens(s.wastedEffectiveTokens)})`)
          .join(', ');
        const extraSessCount = Math.max(0, (f.topSessions || []).length - 2);
        const whereText = topSessNames
          ? `${dict.whereLabel}${topSessNames}${extraSessCount > 0 ? dict.moreCount(extraSessCount) : ''}`
          : '';

        const evOpen = state.openEvidenceIds.has(f.id);
        const evRowsHtml = (f.evidence || [])
          .slice(0, 6)
          .map((ev) => {
            const gapTxt = ev.gapSec !== null && ev.gapSec !== undefined ? fmtCompactDuration(ev.gapSec) : '?';
            const meta =
              key === 'model_switch'
                ? dict.evSwitchMeta(ev.turnIndex, shortModelName(ev.prevModel) || '?', shortModelName(ev.model) || '?')
                : dict.evTurnMeta(ev.turnIndex, gapTxt);
            return `
              <div class="ev-row" title="${esc(ev.prompt)}">
                <span class="ev-sess">${esc(ev.sessionTitle)}</span>
                <span class="ev-meta">${esc(meta)}</span>
                <span class="ev-cost">+${esc(fmtTokens(ev.wastedEffectiveTokens))}</span>
              </div>
            `;
          })
          .join('');

        return `
          <article class="finding-card" data-finding-id="${esc(f.id)}">
            <div class="finding-body">
              <div class="finding-head">
                <span class="finding-title">${esc(title)}</span>
                <span class="finding-badge ${isHigh ? 'high' : ''}">${esc(dict.extraBadge(f.percentOfTotalSpend))}</span>
              </div>
              <div class="finding-why">${esc(why)}</div>
              ${whereText ? `<div class="finding-where" title="${esc(whereText)}">${esc(whereText)}</div>` : ''}
              <div class="finding-fix">${esc(fix)}</div>
            </div>
            <button type="button" class="ev-toggle-btn" data-toggle-ev="${esc(f.id)}" aria-expanded="${evOpen}">
              <span><span class="sec-chevron ${evOpen ? 'open' : ''}">▸</span> ${esc(dict.evToggle(f.count, fmtTokens(f.wastedEffectiveTokens)))}</span>
            </button>
            <div class="ev-drawer ${evOpen ? '' : 'hidden'}">${evRowsHtml}</div>
          </article>
        `;
      })
      .join('');

    auditEl.innerHTML = `<div class="audit-wrap">${heroHtml}${cardsHtml}</div>`;

    for (const btn of auditEl.querySelectorAll('[data-toggle-ev]')) {
      const fid = btn.getAttribute('data-toggle-ev');
      btn.onclick = () => {
        if (state.openEvidenceIds.has(fid)) {
          state.openEvidenceIds.delete(fid);
        } else {
          state.openEvidenceIds.add(fid);
        }
        renderAuditZone();
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
        const wasteTagHtml =
          fullSession.wastedEffectiveTokens > 0
            ? `<span class="s-waste-tag">${esc(dict.sessWasteTag(fmtTokens(fullSession.wastedEffectiveTokens)))}</span>`
            : '';

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
              ${wasteTagHtml}
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
    renderQuotaStripZone();
    renderAuditZone();
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
      const mockParam = params.get('mock') === '1' ? `&mock=1&mode=${encodeURIComponent(params.get('mode') || 'healthy')}` : '';
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
