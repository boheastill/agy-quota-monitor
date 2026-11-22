#!/usr/bin/env bash
# Installs or updates `agy-quota-monitor` into ~/.gemini/config/plugins/agy-quota-monitor
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/agy-quota-monitor"

echo "[agy-quota-monitor] Installing plugin to ${TARGET_DIR} ..."
rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}/assets" "${TARGET_DIR}/sidecars/quota_board"

cp "${REPO_ROOT}/plugin.json" "${TARGET_DIR}/"
cp "${REPO_ROOT}/README.md" "${TARGET_DIR}/"
cp -R "${REPO_ROOT}/assets/." "${TARGET_DIR}/assets/"
cp -R "${REPO_ROOT}/sidecars/quota_board/." "${TARGET_DIR}/sidecars/quota_board/"

echo "[agy-quota-monitor] Installed successfully!"
echo "  -> Open any conversation in Antigravity 2.0 and click '+' (top-right) -> 'Quota'."
