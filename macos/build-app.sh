#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
APP_ROOT="${REPO_ROOT}/build-macos/SnagTrack.app"
CONTENTS_DIR="${APP_ROOT}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
APP_SRC_DIR="${RESOURCES_DIR}/app"
RUNTIME_DIR="${RESOURCES_DIR}/runtime"

cd "${REPO_ROOT}"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is required to build the macOS app bundle."
  echo
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo
  echo "rsync is required to build the macOS app bundle."
  echo
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo
  echo "Installing npm dependencies..."
  echo
  npm install
fi

echo "Creating build-macos/SnagTrack.app"
rm -rf "${APP_ROOT}"
mkdir -p "${MACOS_DIR}" "${APP_SRC_DIR}" "${RUNTIME_DIR}"

rsync -a \
  --exclude '.git' \
  --exclude 'build' \
  --exclude 'build-macos' \
  --exclude 'dist' \
  --exclude 'logs' \
  --exclude 'browser-profile' \
  --exclude 'config.json' \
  --exclude 'session.json' \
  --exclude 'cookies.json' \
  --exclude '.DS_Store' \
  "${REPO_ROOT}/" "${APP_SRC_DIR}/"

cp "$(command -v node)" "${RUNTIME_DIR}/node"
chmod +x "${RUNTIME_DIR}/node"

cat > "${MACOS_DIR}/SnagTrack" <<'SH'
#!/bin/bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname "$0")/.." && pwd)"
RESOURCES_DIR="${APP_DIR}/Resources"
APP_SRC_DIR="${RESOURCES_DIR}/app"
NODE_BIN="${RESOURCES_DIR}/runtime/node"

cd "${APP_SRC_DIR}"
exec "${NODE_BIN}" app.js
SH
chmod +x "${MACOS_DIR}/SnagTrack"

cat > "${CONTENTS_DIR}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>SnagTrack</string>
  <key>CFBundleExecutable</key>
  <string>SnagTrack</string>
  <key>CFBundleIdentifier</key>
  <string>com.karlkrusel.snagtrack</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>SnagTrack</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.0.0</string>
  <key>CFBundleVersion</key>
  <string>2.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

echo
echo "Mac app bundle created:"
echo "  ${APP_ROOT}"
echo
echo "Run it with:"
echo "  open \"${APP_ROOT}\""
