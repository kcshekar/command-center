#!/usr/bin/env bash
# One-command prod update on the VM:  ./scripts/deploy.sh   (or: bun run deploy)
#
# Order matters: build everything first while the old code keeps serving,
# then back up → migrate → restart back to back, so old code never runs
# against new schema for long (that window once crashed cc_api).
# Stops at the first failure; nothing after a failed step runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER="$ROOT/services/automations-worker"
cd "$ROOT"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# A dirty tree means prod has edits git doesn't know about — deploy only
# what's committed. (Once corepack silently pinned pnpm into package.json.)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree has local changes — commit, or discard with 'git checkout -- <file>', then re-run:" >&2
  git status --short >&2
  exit 1
fi

step "Pull"
PREV="$(git rev-parse HEAD)"
git pull --ff-only
if [[ "$PREV" == "$(git rev-parse HEAD)" ]]; then echo "Already at $(git rev-parse --short HEAD) — rebuilding anyway."; fi
ENV_DIFF="$(git diff "$PREV" HEAD -- .env.example services/automations-worker/.env.example)"
if [[ -n "$ENV_DIFF" ]]; then
  echo "⚠ .env.example changed — add any new variables to .env before continuing:"
  echo "$ENV_DIFF"
  read -r -p "Continue? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1
fi

step "Install (locked versions only)"
bun install --frozen-lockfile
(cd "$WORKER" && pnpm install --frozen-lockfile)

step "Build web + worker (old code still serving)"
rm -rf apps/web/.next
bun run build:web
(cd "$WORKER" && pnpm build)

step "Back up both databases"
bun run db:backup
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
AUTOMATIONS_URL="$(DB_URL="$DB_URL" bun -e 'const u = new URL(process.env.DB_URL); u.pathname = "/automations"; console.log(u.href)')"
mkdir -p backups
pg_dump --format=custom --no-owner --no-privileges \
  --file="backups/automations_$(date -u +%Y%m%d_%H%M%S).dump" "$AUTOMATIONS_URL"

step "Migrate"
bun run migrate
(cd "$WORKER" && pnpm migrate)

step "Restart"
pm2 restart cc_api cc_web automations-worker

step "Inventory"
sleep 5
(cd "$WORKER" && pnpm inventory)

echo
echo "Deployed $(git rev-parse --short HEAD). Check: pm2 logs cc_api --lines 20 --nostream"
