---
name: install-agy-quota-monitor
description: Automatically install, configure, and verify the agy-quota-monitor right-side Quota Saver panel for Google Antigravity 2.0 on Windows, macOS, or Linux.
---

# AI Autonomous Installer — `agy-quota-monitor`

When a user gives you this `SKILL.md` (or its GitHub URL) and asks you to install the **Antigravity Quota Saver (`agy-quota-monitor`)** plugin, execute the steps below end-to-end on their machine so they don't have to run commands manually.

## What You Are Installing

`agy-quota-monitor` (`https://github.com/boheastill/agy-quota-monitor`) is a zero-dependency, read-only Sidecar UI plugin for **Google Antigravity 2.0**. It adds a **Quota** panel to the right-hand auxiliary pane (`+` menu) showing:
1. **Live Context Weight & 60-Minute Prompt-Cache Timer** — makes invisible conversation weight (`300k+` tokens × internal tool steps) and cache expiry visible before you trigger a 10× cold reload.
2. **Auto-Calibrated Remaining Turns** — compares how many turns your remaining 5h quota gives you if you reply warm (`<60m`), cold (`>60m` / model switch), or summarize into a fresh chat, with a 1-click **Warm Handoff Prompt** button.
3. **Global 5h & 7d Quota Bars** (via official `agy -p "/usage" --output-format json`, 0 LLM tokens used).

---

## Step 1: Ensure Official `agy` CLI Is Installed (for Cloud `%` Bars)

Check if `agy` is already installed on the user's machine:

- **Windows (PowerShell)**:
  Check `Get-Command agy -ErrorAction SilentlyContinue` or `$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Google.AntigravityCLI*\agy.exe`.
  If missing, install via WinGet:
  ```powershell
  winget install --id Google.AntigravityCLI --accept-source-agreements --accept-package-agreements
  ```
- **macOS / Linux (Bash)**:
  Check `command -v agy` or `~/.antigravity/bin/agy` or `/usr/local/bin/agy`.
  If missing, install via the official script:
  ```bash
  curl -fsSL https://antigravity.google/cli/install.sh | sh
  ```

*(Note: If the user is already signed in to Antigravity 2.0 Desktop on the same machine, `agy` automatically reuses their Google credentials. If `agy -p "/usage" --output-format json` reports an authentication error, ask the user to run `agy` once in a terminal to complete browser sign-in.)*

---

## Step 2: Clone & Deploy Plugin to Global Antigravity Config

Clone the repository to a temporary directory and run the platform installer so the plugin is placed at `~/.gemini/config/plugins/agy-quota-monitor`:

### On Windows (PowerShell)
```powershell
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "agy-quota-monitor-install"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
git clone --depth 1 https://github.com/boheastill/agy-quota-monitor.git $tmp
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp "scripts\install.ps1")
Remove-Item -Recurse -Force $tmp
```

### On macOS / Linux (Bash)
```bash
TMP_DIR="$(mktemp -d)/agy-quota-monitor"
git clone --depth 1 https://github.com/boheastill/agy-quota-monitor.git "$TMP_DIR"
bash "$TMP_DIR/scripts/install.sh"
rm -rf "$TMP_DIR"
```

---

## Step 3: Verify & Give the User a One-Click Open Pill

1. Verify that `~/.gemini/config/plugins/agy-quota-monitor/plugin.json` and `~/.gemini/config/plugins/agy-quota-monitor/sidecars/quota_board/sidecar.json` exist.
2. If you are running inside **Google Antigravity**, include both of these links in your final reply so the user can open or manage the panel with one click:
   - Open panel directly in the right-hand side pane: `[Quota](sidecar://agy-quota-monitor/quota_board/)`
   - Plugin settings page: `[Quota Saver](customization://agy-quota-monitor)`
3. Tell the user they can also open it anytime from the **`+`** button at the top-right of any conversation → **Quota**.
