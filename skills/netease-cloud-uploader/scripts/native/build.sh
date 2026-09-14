#!/usr/bin/env bash
# Build the macOS WKWebView login helper for the current architecture.
# Output: native/macos-arm64/NeteaseWebViewLogin  (or native/macos-x64/...)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/macos/LoginWindow.swift"

SYSTEM_ARCH="$(uname -m)"
case "$SYSTEM_ARCH" in
  arm64)
    SWIFT_ARCH="arm64"
    NODE_ARCH="arm64"
    ;;
  x86_64)
    SWIFT_ARCH="x86_64"
    NODE_ARCH="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: $SYSTEM_ARCH" >&2
    exit 2
    ;;
esac

OUT_DIR="$SCRIPT_DIR/macos-${NODE_ARCH}"
OUT="$OUT_DIR/NeteaseWebViewLogin"

mkdir -p "$OUT_DIR"

echo "Building NeteaseWebViewLogin for macOS $SYSTEM_ARCH..."

swiftc \
  -target "${SWIFT_ARCH}-apple-macosx12.0" \
  -framework Cocoa \
  -framework WebKit \
  -O \
  -o "$OUT" \
  "$SRC"

chmod +x "$OUT"

echo "Built: $OUT"
file "$OUT"
