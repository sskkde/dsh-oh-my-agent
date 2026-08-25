#!/bin/bash
# Compile the CLIENT half only (src/client → lib/client.js ModuleLoader bundle).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TSC="/usr/bin/tsc"
if [ ! -x "$TSC" ]; then
  TSC="$(command -v tsc || true)"
fi
if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "build:client: tsc not found" >&2
  exit 1
fi

echo "=== Compiling client (src/client → .build-client, CJS) ==="
rm -rf .build-client
"$TSC" -p tsconfig.client.json
echo "=== client compiled ==="

echo "=== Wrapping client into lib/client.js (ModuleLoader bundle) ==="
node scripts/wrap-client.mjs

rm -rf .build-client
echo "=== client build complete ==="
