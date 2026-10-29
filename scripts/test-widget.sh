#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build/widget/module-cache
xcrun swiftc -swift-version 5 -parse-as-library \
  -module-cache-path .build/widget/module-cache \
  macos/MeterModels.swift macos/MeterModelsTests.swift \
  -o .build/widget/model-tests
.build/widget/model-tests
node scripts/widget-theme.js
xcrun swiftc -swift-version 5 -parse-as-library \
  -module-cache-path .build/widget/module-cache \
  -framework AppKit -framework SwiftUI \
  .build/widget/MeterPalette.swift macos/MeterModels.swift macos/MeterStore.swift macos/MeterRefreshTests.swift \
  -o .build/widget/refresh-tests
.build/widget/refresh-tests
