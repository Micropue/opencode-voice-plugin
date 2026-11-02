#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."

APP="bin/OpenCodeVoice.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 native/voice.swift -o "$APP/Contents/MacOS/opencode-voice"
cp native/Info.plist "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

echo "built $APP"
"$APP/Contents/MacOS/opencode-voice" --selftest
