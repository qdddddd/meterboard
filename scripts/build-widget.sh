#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The native widget requires macOS and Xcode Command Line Tools.' >&2
  exit 1
fi
app='dist/Meterboard Widget.app'
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/fonts" .build/widget/module-cache
bash scripts/build-icons.sh
node scripts/widget-theme.js
xcrun swiftc -swift-version 5 -O -parse-as-library \
  -target "$(uname -m)-apple-macosx13.0" \
  -module-cache-path .build/widget/module-cache \
  -framework AppKit -framework SwiftUI \
  .build/widget/MeterPalette.swift macos/MeterModels.swift macos/MeterStore.swift macos/MeterAppearance.swift macos/MeterboardWidget.swift \
  -o "$app/Contents/MacOS/MeterboardWidget"
cp macos/Info.plist "$app/Contents/Info.plist"
cp .build/icons/Meterboard.icns "$app/Contents/Resources/Meterboard.icns"
cp macos/fonts/*.ttf "$app/Contents/Resources/fonts/"
cp public/fonts/OFL.txt "$app/Contents/Resources/fonts/OFL.txt"
codesign --force --sign - "$app"
printf 'Built %s/%s\n' "$PWD" "$app"
