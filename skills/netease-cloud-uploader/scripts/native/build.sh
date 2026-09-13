#!/usr/bin/env bash
# Build the macOS WKWebView login helper for the current architecture.
# Output: native/macos-arm64/NeteaseWebViewLogin  (or native/macos-x64/...)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/macos/LoginWindow.swift"

ARCH="$(uname -m)"
OUT_DIR="$SCRIPT_DIR/macos-${ARCH}"
OUT="$OUT_DIR/NeteaseWebViewLogin"

mkdir -p "$OUT_DIR"

echo "Building NeteaseWebViewLogin for macOS $ARCH..."

swiftc \
  -target "${ARCH}-apple-macos12" \
  -framework Cocoa \
  -framework WebKit \
  -O \
  -o "$OUT" \
  "$SRC"

chmod +x "$OUT"

echo "Built: $OUT"
file "$OUT"
