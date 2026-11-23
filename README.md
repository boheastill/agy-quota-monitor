# agy-quota-monitor

**[简体中文文档](./README.zh-CN.md)** | **English**

Stop clicking into **Settings → Models** just to check how much quota you have left.
`agy-quota-monitor` adds a clean, live **Quota** side panel right next to your chat in **Google Antigravity 2.0** (`+` menu → **Quota**) so you can see at a glance:

1. **Dual Radial Gauges (`Gemini · 5h` & `7d`)** — Instant visual readout with a **Time-Pace Dot** on the 7d ring (arc ahead of dot = ahead of linear pace) and **EWMA half-life burn-rate forecasts** (`Safe to reset`, `Est. ~49% spare`, or `⚡ ~1.2h to zero`).
2. **Zero-Scroll Minimalist Layout** — Secondary pools (`Claude / GPT`) collapse into a sleek 1-line summary bar; zero-balance `AI Credits` auto-hide so everything fits on one screen.
3. **Which conversation is actually eating your quota** — Single-line session micro-bars with sidebar short titles, hover breakdown tooltips, and click-to-expand per-turn history.

---

## One-Prompt Install (Let Your AI Set Everything Up)

Just copy and paste this prompt into **Antigravity** (or any local coding agent) — it will automatically check your OS, install the official `agy` CLI if needed, and set up the plugin for you:

```text
Read https://raw.githubusercontent.com/boheastill/agy-quota-monitor/main/setup/SKILL.md and automatically install and configure the agy-quota-monitor plugin on my machine.
```

Once installed, click **`+` → Quota** at the top-right of any conversation.

---

## Why Use This?

1. **100% Official Channels — Built Not to Break**
   - Reads global quota percentages via the official `agy -p "/usage" --output-format json` command (**0 LLM tokens used**).
   - Reads session usage from local `transcript.jsonl` logs in read-only mode.
   - **Zero `npm` dependencies**, no reverse-engineered private RPCs, and no chat-loop hooks — even if you're offline or Antigravity updates, your chat is never blocked.
2. **Plain, Honest Session Cost Comparison**
   - Local logs record raw token counts, but not all tokens hit your quota equally:
     - **Cached context reads (`Cache`)** are heavily discounted (~90% off, **`× 0.1`**);
     - **New uncached input (`Input`)** is baseline cost (**`× 1`**);
     - **Model thinking + replies (`Output`)** cost roughly **4x** as much (**`× 4`**).
   - Adding raw tokens `1:1:1` makes cache-heavy sessions look huge when they actually barely touched your quota.
   - Instead, we estimate **`Estimated Load = Input × 1 + Cache × 0.1 + Output × 4`** — think of this number as **roughly how much real quota/money each session actually ate** relative to other sessions.
   - Raw total tokens and cache hit rate are still shown right beside it (with a 1-click toggle), and turns where a long pause caused your prompt cache to expire are automatically flagged with **`⚠ Cache expired reload`**.

---

## Manual Installation

### 1. Install Official `agy` CLI (for top cloud `%` bars)

> Session comparison below works even without the CLI; installing `agy` enables the top 5h / weekly percentage bars.

```powershell
# Windows (PowerShell)
winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements
```
```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | sh
```
*(If you're already signed into Antigravity 2.0 Desktop, `agy` reuses your login automatically; otherwise run `agy` once in a terminal to sign in.)*

### 2. Install the Plugin

```powershell
# Windows PowerShell
git clone https://github.com/boheastill/agy-quota-monitor.git
cd agy-quota-monitor
.\scripts\install.ps1
```

```bash
# macOS / Linux
git clone https://github.com/boheastill/agy-quota-monitor.git
cd agy-quota-monitor
chmod +x scripts/install.sh && ./scripts/install.sh
```
*(Or via the official CLI on a local clone: `agy plugin install ./agy-quota-monitor`.)*

---

## Smart Refresh (Lightweight by Design)

- **Local Session Logs**: Checks file modification timestamps every 2.5s while open (`<1 ms` when idle).
- **Cloud Quota (`agy` CLI)**: Fetches once when opened, automatically refreshes ~3.5s after a new reply finishes, and falls back to every 5 minutes when idle (0 background calls when the panel is closed, plus a manual `↻` button).

---

## Standalone Preview & Custom ACP Web UI API

Building your own Web UI on top of `agy acp`? Run the standalone HTTP server directly with Node.js (v20+):

```bash
node scripts/dev-server.mjs --port 4790
```
- Dashboard: `http://127.0.0.1:4790`
- JSON API: `GET http://127.0.0.1:4790/api/status?conversationId=<uuid>`

## License

[MIT](./LICENSE)
