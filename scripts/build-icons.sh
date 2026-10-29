#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Regenerating icons requires macOS and Xcode Command Line Tools. Web icons are checked in.' >&2
  exit 1
fi
mkdir -p .build/icons/module-cache
xcrun swift -module-cache-path .build/icons/module-cache scripts/generate-icons.swift
iconutil --convert icns --output .build/icons/Meterboard.icns .build/icons/Meterboard.iconset
