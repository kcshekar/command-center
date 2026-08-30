#!/usr/bin/env bash
# Starts the API and web dev servers together. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

trap 'kill 0' EXIT

bun --hot apps/api/index.ts &
bun run --cwd apps/web dev &

wait
