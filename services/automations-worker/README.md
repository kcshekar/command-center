# Automations Worker

Node.js 22 Temporal worker for personal automations (Gmail triage, morning brief).
Runs alongside Command Center on the home server; talks to CC via a Service Token
and never handles Slack tokens itself (D5).

## First-time setup

```bash
cd services/automations-worker
cp .env.example .env    # fill in secrets

# Create the DB + a restricted role on your Postgres VM:
#   CREATE DATABASE automations;
#   CREATE ROLE automations_app LOGIN PASSWORD '...';
#   GRANT ALL ON DATABASE automations TO automations_app;

pnpm install
pnpm migrate
pnpm google:auth -- you@gmail.com    # opens browser, one-time consent
```

## Run locally

```bash
# Terminal 1 — Temporal (existing home-server compose already has this)
docker compose up temporal

# Terminal 2 — the worker
pnpm worker

# Terminal 3 — one-shot, register the daily schedule
pnpm schedules:init -- you@gmail.com
```

## Fire an ad-hoc morning brief (for testing)

```bash
pnpm exec tsx -e "
import { Client, Connection } from '@temporalio/client';
const c = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
await new Client({ connection: c, namespace: 'personal' }).workflow.start('morningBriefWorkflow', {
  taskQueue: 'personal-automations',
  workflowId: 'morning-brief-manual-' + Date.now(),
  args: [{ userEmail: 'you@gmail.com', slackRouteKey: 'automations.digest' }],
});
"
```

## Phase 5 additions

- Bank alert parser framework (`src/parsers/`) with a fixture-tested HDFC
  credit-card parser. Add more banks by creating a file and pushing into the
  registry in `src/parsers/index.ts`.
- LLM fallbacks: `extractExpense` and `extractBill` in `src/ollama.ts`, only
  invoked when no deterministic parser matches.
- Triage workflow now also ingests during classification:
  - `transactional_bank` → `POST /api/integrations/expenses` (needs
    `expenses:write` scope on your service token)
  - `actionable_bill` → `POST /api/integrations/reminders` (needs
    `reminders:write`)
- Evening wrap-up workflow (`src/workflows/evening-wrap.ts`): completed
  Google Tasks summary + rollover of overdue tasks to tomorrow. Runs daily at
  20:00 via `init-schedules.ts`.

Bank parser tests:
```bash
node --test src/parsers/*.test.ts    # or: pnpm exec tsx --test src/parsers/*.test.ts
```

## Phase 4 additions

- Real trash-with-approval in the triage workflow. Classifies → posts a
  Block Kit card via CC's `slack-approval` endpoint → waits (max 24h) for a
  Temporal Update → trashes or skips.
- Callback server (`src/callback-server.ts`) on port `WORKER_CALLBACK_PORT`.
  CC's Socket Mode handler POSTs `/callback/approval` with a shared bearer
  token; the server dispatches `submitApproval` to the waiting workflow.
- New activities: `postApprovalCard`, `updateApprovalMessage`, `trashGmailMessages`.
- Approver-ID gating happens in CC (via `slack_routes.allowed_approver_slack_ids`)
  before the callback ever reaches the worker.

## What is still not done (intentional deferrals)

- **Gmail Pub/Sub push** — polling via `history.list` on each triage run. Push
  needs a public Pub/Sub subscription; skip until latency actually matters.
- **60s debounce** — natural batching per poll interval covers this until push
  arrives.
- **Web-based Google OAuth flow** — CLI-only. Fine for single owner.
- **Redis pub/sub hot-reload of Slack sockets in CC** — restart pm2 on token
  change. Add when token edits happen frequently enough to matter.
- **Multi-user re-auth Slack ping on `invalid_grant`** — worker throws today;
  wrap in an alert route once you use it enough to feel the pain.

## Env vars

See `.env.example`. `CC_SERVICE_TOKEN` needs scopes `slack:send` + `reminders:read`
(issue in the Command Center UI under Service Tokens). Add `expenses:write` +
`reminders:write` when Phase 5 wires the bank-alert parsers.
