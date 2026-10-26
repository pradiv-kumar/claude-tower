#!/bin/bash
# Builds Claude Tower.app (universal: Apple Silicon + Intel) into ~/Applications
# and (re)starts it.
#   ./build.sh           build, install, launch
#   ./build.sh --login   also start it at login (a LaunchAgent)
#   ./build.sh --unlogin remove the LaunchAgent
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
name="Claude Tower"
exe="ClaudeTower"
label="dev.claudetower.menubar"
min_macos="14.4"
app="$HOME/Applications/$name.app"
agent="$HOME/Library/LaunchAgents/$label.plist"

if [[ "${1:-}" == "--unlogin" ]]; then
  launchctl bootout "gui/$(id -u)" "$agent" 2>/dev/null || true
  rm -f "$agent"
  echo "Removed login item."
  exit 0
fi

command -v xcrun >/dev/null || { echo "Needs the Xcode command line tools: xcode-select --install" >&2; exit 1; }

build="$here/.build"
rm -rf "$build" && mkdir -p "$build/$name.app/Contents/MacOS"
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos$min_macos" \
    -o "$build/$exe-$arch" "$here/Sources/main.swift"
done
lipo -create -output "$build/$name.app/Contents/MacOS/$exe" "$build/$exe-arm64" "$build/$exe-x86_64"
cp "$here/Info.plist" "$build/$name.app/Contents/Info.plist"
# Ad-hoc signed: notifications need a stable bundle identity, not a notarized one.
codesign --force --sign - "$build/$name.app"

pkill -x "$exe" 2>/dev/null || true
mkdir -p "$HOME/Applications"
rm -rf "$app"
mv "$build/$name.app" "$app"
rm -rf "$build"

if [[ "${1:-}" == "--login" ]]; then
  mkdir -p "$(dirname "$agent")"
  cat >"$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-a</string><string>$app</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$agent" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$agent"
  echo "Installed login item."
else
  open "$app"
fi
echo "Installed: $app"
