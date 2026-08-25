#!/bin/bash
# Build script for dsh-oh-my-agent.
#
# The deployment ships no source checkout (no $DSH_CHECKOUT/packages), so
# this adapts the scaffold's script to link type dependencies straight from
# the DEPLOYMENT's dependency tree (either the profile node_modules at
# /home/ubuntu/.dsh/profiles/node_modules, which holds the whole DSH
# package graph, or the global install at /usr/lib/node_modules) and uses
# the global tsc.
#
# This script compiles the HOST half only (src -> lib). The client half is
# compiled by `scripts/build-client.sh` (npm run build:client).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE_NM="${HOME}/.dsh/profiles/node_modules"
GLOBAL_NM="/usr/lib/node_modules/@deepseek-ai/dsh/node_modules"
DEP=""
for cand in "$PROFILE_NM" "$GLOBAL_NM"; do
  if [ -d "$cand/@deepseek-ai/dsh-tools" ] && [ -d "$cand/@deepseek-ai/schemastery" ] && [ -d "$cand/@deepseek-ai/cordis" ]; then
    DEP="$cand"
    break
  fi
done
if [ -z "$DEP" ]; then
  echo "build: cannot locate the DSH dependency tree (tried $PROFILE_NM, $GLOBAL_NM)" >&2
  exit 1
fi

TSC="/usr/bin/tsc"
if [ ! -x "$TSC" ]; then
  TSC="$(command -v tsc || true)"
fi
if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "build: tsc not found" >&2
  exit 1
fi

link_pkg() {
  local link="$1" target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const path = require("path");
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  ' "node_modules/$link" "$target"
}

echo "=== Linking build type dependencies (deps root: $DEP) ==="
mkdir -p node_modules/@deepseek-ai node_modules/@types
link_pkg @deepseek-ai/cordis "$DEP/@deepseek-ai/cordis"
link_pkg @deepseek-ai/schemastery "$DEP/@deepseek-ai/schemastery"
link_pkg @types/node "$DEP/@types/node"
link_pkg @deepseek-ai/cosmokit "$DEP/@deepseek-ai/cosmokit"
link_pkg @deepseek-ai/dsh-tools "$DEP/@deepseek-ai/dsh-tools"
link_pkg @deepseek-ai/dsh-llm "$DEP/@deepseek-ai/dsh-llm"
link_pkg @deepseek-ai/dsh-scope "$DEP/@deepseek-ai/dsh-scope"
link_pkg @deepseek-ai/dsh-session "$DEP/@deepseek-ai/dsh-session"
link_pkg @deepseek-ai/dsh-agent "$DEP/@deepseek-ai/dsh-agent"
link_pkg @deepseek-ai/dsh-skill "$DEP/@deepseek-ai/dsh-skill"
link_pkg @deepseek-ai/dsh-host-webserver "$DEP/@deepseek-ai/dsh-host-webserver"
link_pkg @deepseek-ai/dsh-client-ui-slots "$DEP/@deepseek-ai/dsh-client-ui-slots"
WEB_NM="${HOME}/.dsh/profiles/web/node_modules"
if [ -e "$WEB_NM/schemastery/package.json" ]; then
  link_pkg schemastery "$WEB_NM/schemastery"
else
  link_pkg schemastery "$DEP/@deepseek-ai/schemastery"
fi

echo "=== Compiling host (src -> lib) ==="
"$TSC" -p tsconfig.json
echo "=== host compiled ==="
