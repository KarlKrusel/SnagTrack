#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

CHROME_PATHS=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  "${HOME}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
)

has_system_chromium=0
for candidate in "${CHROME_PATHS[@]}"; do
  if [ -x "${candidate}" ]; then
    has_system_chromium=1
    break
  fi
done

cd "${REPO_ROOT}"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "SnagTrack needs Node.js on macOS."
  echo "Install Node.js first, then run ./macos/run-dev.sh again."
  echo
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo
  echo "Installing npm dependencies..."
  echo
  npm install
fi

if [ "${has_system_chromium}" -eq 0 ]; then
  echo
  echo "No system Chrome or Edge found. Installing Playwright Chromium..."
  echo
  npx playwright install chromium
fi

echo
echo "Starting SnagTrack on http://127.0.0.1:7766"
echo

exec node app.js
