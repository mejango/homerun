#!/bin/sh
# Runs forge with absolute remapping targets (see scripts/forge-remappings.mjs).
set -eu
cd "$(dirname "$0")/.."
FOUNDRY_REMAPPINGS="$(node -e "import('./scripts/forge-remappings.mjs').then(m => m.absoluteRemappings()).then(r => process.stdout.write(r))")"
export FOUNDRY_REMAPPINGS
exec forge "$@"
