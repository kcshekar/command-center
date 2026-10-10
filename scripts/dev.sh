#!/usr/bin/env bash
# Starts the API, web, and automations worker dev servers together.
# Ctrl+C stops all three.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

trap 'kill 0' EXIT

bun --hot apps/api/index.ts &
bun run --cwd apps/web dev &

# Worker needs Node 22 + pnpm. Skip gracefully if either is missing so devs
# who only touch api/web aren't blocked.
if command -v pnpm >/dev/null 2>&1 && [ -d services/automations-worker/node_modules ]; then
  (cd services/automations-worker && pnpm worker) &
else
  echo "[dev.sh] skipping automations-worker (install pnpm + run 'pnpm install' in services/automations-worker to enable)"
fi

wait
