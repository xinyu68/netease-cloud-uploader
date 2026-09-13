#!/usr/bin/env bash
# Cross-platform bootstrap for macOS / Linux (the Windows path is bootstrap.ps1).
# Installs runtime dependencies and runs the syntax checks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
npm install
npm run check

printf '{"ok":true,"data":{"projectRoot":"%s","installed":true,"platform":"%s"}}\n' "$PROJECT_ROOT" "$(node -p 'process.platform')"
