#!/bin/bash
# SnagTrack build — produces build/SnagTrack/ : obfuscated + Node bundled, ready for the installer.
# Made by Karl Krusel (@karlkrusel)
set -e
SRC="/c/Users/Karl/Downloads/Claude/SnagTrack"
OUT="$SRC/build/SnagTrack"
NODE_EXE="/c/Program Files/nodejs/node.exe"

echo "── Clean staging ──"
rm -rf "$SRC/build"
mkdir -p "$OUT"

echo "── Copy runtime files ──"
cp "$SRC/app.js" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/LICENSE.txt" "$SRC/favicon.ico" "$OUT/"
cp -r "$SRC/src" "$OUT/src"
cp -r "$SRC/public" "$OUT/public"
cp -r "$SRC/node_modules" "$OUT/node_modules"
mkdir -p "$OUT/runtime"
cp "$NODE_EXE" "$OUT/runtime/node.exe"

echo "── Generate launcher (bundled-node aware) ──"
cat > "$OUT/SnagTrack.bat" <<'BAT'
@echo off
title SnagTrack
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
echo.
echo   Starting SnagTrack...  ( http://127.0.0.1:7766 )
echo   Close the browser tab to quit, or just close this window.
echo.
"%NODE%" app.js
echo.
echo   SnagTrack has stopped.
pause
BAT

# ── Obfuscation ───────────────────────────────────────────────────────────────
# FULL = string-array on (max scramble). SAFE = string-array off (keeps page.evaluate
# / addInitScript browser callbacks intact — they'd break if their strings were
# moved into a Node-side string-array decoder).
FULL="--compact true --simplify true --identifier-names-generator hexadecimal --string-array true --string-array-encoding base64 --string-array-threshold 0.8 --rename-globals false --self-defending false --control-flow-flattening false --dead-code-injection false"
SAFE="--compact true --simplify true --identifier-names-generator hexadecimal --string-array false --rename-globals false --self-defending false --control-flow-flattening false --dead-code-injection false"

obf () { # $1 = relative file, $2 = opts
  local tmp="/tmp/__snag_obf.js"
  javascript-obfuscator "$OUT/$1" --output "$tmp" $2
  cp "$tmp" "$OUT/$1"
  rm -f "$tmp"
  echo "   obf($([ "$2" = "$FULL" ] && echo full || echo safe)): $1"
}

echo "── Obfuscate (full) ──"
for f in app.js src/sc-resolver.js src/coverart.js src/config.js src/logger.js src/direct-client.js public/app.js; do
  obf "$f" "$FULL"
done
echo "── Obfuscate (evaluate-safe) ──"
for f in src/downloader.js src/browser-manager.js; do
  obf "$f" "$SAFE"
done

echo "── Done ──"
du -sh "$OUT" | awk '{print "   staging size: " $1}'
echo "   output: $OUT"
