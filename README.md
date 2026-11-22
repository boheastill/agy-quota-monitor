# agy-quota-monitor

**[简体中文文档](./README.zh-CN.md)** | **English**

A zero-dependency, read-only **Sidecar UI Plugin** for **Google Antigravity 2.0** that sits natively in the conversation auxiliary pane (`+` menu → **Quota**), giving you instant visibility into:

1. **Global Quota Pools (`5h` & `7d Weekly` + `AI Credits`)** — Live progress bars, status badges, and ticking reset countdowns via the official `agy` CLI (`--output-format json`, **0 LLM tokens consumed**).
2. **Current Session Workload** — Real-time token breakdown (`Uncached Input`, `Cache Read`, `Thinking + Output`), prompt cache hit rate, subagent roll-ups (`invoke_subagent`), per-turn breakdown, and automatic **Cache-Expiry Spike** warnings.
3. **Recent Sessions Comparison** — Ranks your recent conversations by a **100% deterministic workload yardstick** so you always know which session is eating your quota, with one-click session switching.

---

## Why This Design? (Zero Maintenance, Zero Drift)

- **100% Public & Sanctioned Interfaces**: Uses `agy -p "/usage" --output-format json` + read-only local `transcript.jsonl` files. No fragile reverse-engineered internal RPCs that break across Antigravity updates, and no `hooks.json` intercepting your chat loop.
- **Zero `npm` Dependencies**: Runs directly on Antigravity's bundled Node.js runtime and `sidecar_sdk` (no `node_modules` to install or audit).
- **Deterministic Workload Yardstick**:
  Instead of scraping volatile model price sheets (which fail offline or break when new internal model IDs appear), session bars use a transparent, fixed equivalent:
  ```text
  Effective Tokens = Uncached Input × 1.0 + Cache Read × 0.1 + Thinking & Output × 4.0
  ```
  *(1 unit = 1 standard uncached input token. You can also toggle to **Raw Total Tokens** or open the built-in `ⓘ` formula card anytime.)*
- **Auto Light/Dark Theme & Bilingual UI**: Syncs seamlessly with Antigravity's host theme tokens and auto-detects English / Simplified Chinese (with a `中文 / EN` header switch).

---

## Quick Start

### 1. Prerequisite (for Global Cloud `%` Bars)

Local session workload tracking works **immediately out-of-the-box** with zero setup.
To also display cloud `5h` / `7d` quota percentages at the top of the panel, install the official Antigravity CLI once and sign in:

```powershell
# Windows (WinGet)
winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements
agy
```

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | sh
agy
```

### 2. Install the Plugin

#### Option A: Via Antigravity CLI (direct from GitHub or local clone)
```bash
agy plugin install https://github.com/boheastill/agy-quota-monitor
```

#### Option B: One-Click Local Script (Antigravity 2.0 Desktop)
```powershell
# Windows PowerShell
.\scripts\install.ps1
```
```bash
# macOS / Linux
chmod +x scripts/install.sh && ./scripts/install.sh
```
*(Copies the plugin bundle into `~/.gemini/config/plugins/agy-quota-monitor/`.)*

### 3. Open the Panel

1. Ensure **Quota Monitor** is enabled under **Skills & Customizations → Plugins**.
2. In any conversation, click **`+`** in the top-right auxiliary pane bar and select **Quota**.

---

## Smart Refresh Strategy

- **Local Session Transcripts**: Checked via lightweight `statSync` (`mtime` + byte size) every 2.5s while the panel is open (`<1 ms` when idle).
- **Cloud Quota (`agy` CLI)**:
  - Queried once when the panel opens;
  - **Event-driven**: Automatically refreshes ~3.5s after a new model step finishes in your conversation;
  - **Idle fallback**: Every 5 minutes while open (0 background calls when the panel is closed), plus a manual **Refresh (`↻`)** button.

---

## Standalone Preview & Custom ACP Web UI Integration

Building your own Web UI over `agy acp`? You can run the standalone HTTP server directly with Node.js (v20+):

```bash
node scripts/dev-server.mjs --port 4790
```

- Web Dashboard: `http://127.0.0.1:4790`
- JSON Telemetry Endpoint: `GET http://127.0.0.1:4790/api/status?conversationId=<uuid>`

---

## Running Tests

Uses Node's built-in test runner (`node:test`) with zero external dependencies:

```bash
node --test test/collector.test.mjs
```

---

## Repository Layout

```text
agy-quota-monitor/
├── plugin.json                     # Official Antigravity plugin manifest
├── assets/
│   └── logo.svg                    # Dual-theme vector gauge icon
├── sidecars/
│   └── quota_board/
│       ├── sidecar.json            # Auxiliary pane UI sidecar declaration
│       ├── package.json            # ESM module marker
│       ├── main.mjs                # sidecar_sdk HTTP & page router
│       ├── collector.mjs           # CLI quota reader + mtime-cached transcript analyzer
│       ├── index.html              # Sidecar UI markup
│       ├── styles.css              # Host-token-adaptive styling
│       └── app.js                  # Live countdowns, i18n, & leaderboard UI
├── scripts/
│   ├── install.ps1                 # Windows installer
│   ├── install.sh                  # macOS / Linux installer
│   └── dev-server.mjs              # Standalone preview & JSON API server
└── test/
    └── collector.test.mjs          # Unit tests
```

## License

[MIT](./LICENSE)
