# Command Center — Architecture

High-level map of how CC, the Automations Worker, Slack, Google, and Temporal fit together, and why each piece is where it is.

## Processes

| Process | Where | Owns |
|---|---|---|
| **CC api** (Bun) | GCP VM, port 3011 | Postgres (`commandcenter` DB), Slack bot tokens, service tokens, session auth |
| **CC web** (Next.js standalone) | Same VM, port 3010 (nginx fronts) | UI, calls CC api via `/api/*` |
| **Automations Worker** (Node 22 + Temporal) | Same VM | Google OAuth tokens (`automations` DB), workflow activities, Slack Socket Mode callback server (port 3005) |
| **Temporal** | Shared GKE cluster (cuva dev), namespace `commandcenter` | Workflow orchestration, schedules, retries |
| **Postgres** | GCP VM | Two DBs: `commandcenter` and `automations` |
| **Ollama** | chandu-h110 (home server, Tailscale-only) | Local LLM for email classification + extraction |
| **nginx** | VM | Terminates HTTPS at commandcenter.pametnitech.com; routes `/` → :3010, `/automations/*` → :3005 |

## The five building blocks

### 1. Bot Connections (`slack_connections`)
A Slack **app** installed in a workspace. Stores encrypted `xoxb-...` (bot token) and optional `xapp-...` (app-level token for Socket Mode). Why DB and not .env: supports multiple bots across workspaces, operator can add one through `/notifications` without a deploy.

### 2. Route Mappings (`notification_routes`)
Stable name → destination. Code calls `postNotification("automations.digest", ...)`. The row says WHICH channel type + WHICH destination.

A single `route_key` can have **multiple rows, one per `channel_type`** (fan-out). `UNIQUE(org_id, route_key, channel_type)` prevents duplicates within a channel but allows the same route to post to Slack AND the in-app bell at the same time. The dispatcher loops over all enabled rows for a route and posts to each.

The `channel_type` column picks the adapter at dispatch time:
- `slack` — requires `connection_id` (points at `slack_connections`) + `channel_id`. Delivers via Slack Web API.
- `in_app` — no connection needed. Delivers by inserting into the `notifications` table; the CC UI's notification bell polls that queue.

Also carries `allow_buttons` and (for slack) `allowed_approver_slack_ids` so approvals have an explicit opt-in. In-app approvals authorize by session user instead of a per-route list.

**Approval fan-out:** when an approval route exists on both channels, both postings go out together. The first click (Slack button OR in-app button) wins — the workflow records the decision, settles the other channel's posting via `updateNotification(refs[])`, and continues.

### 3. Service Tokens (`service_tokens`)
Bearer credential (`cc_st_<64 hex>`) for machine-to-machine auth: the worker uses one to call CC. Only the SHA-256 hash is stored; raw token shown once. Scoped to one org, carries explicit **scopes**.

### 4. Scopes
Strings on a service token like `slack:send`, `expenses:write`, `reminders:read`. Enforced per endpoint via `requireScope(ctx, "...")`. Smaller blast radius on leak.

### 5. Google OAuth (worker-owned)
Encrypted refresh + access tokens live in the worker's `google_oauth_tokens`. CC mirrors just metadata (`google_oauth_accounts` — email, scopes, last_refreshed) for UI. Worker is the only process that sees the raw tokens, because it's the only one that calls Google APIs.

## Request flows

### Morning brief (automated)

```
Temporal schedule "morning-brief-daily" (07:30)
  → morningBriefWorkflow (worker)
      → fetchCCDueReminders activity
            → GET https://commandcenter.pametnitech.com/api/integrations/reminders/due
              Header: Authorization: Bearer cc_st_...
            → CC: resolve_service_token → requireScope("reminders:read") → tenant tx → SELECT
            → returns reminders
      → postNotification activity
            → POST .../api/integrations/notify { routeKey, text }
            → CC: notification_routes[routeKey] → slack_connections[conn_id] → decryptSlackToken → Slack API chat.postMessage
```

### Inbox triage with approval (Phase 4)

```
Temporal schedule (every 15m) → inboxTriageWorkflow
  → fetchGmailHistory (Google API, using worker's stored tokens)
  → classifyEmailOllama (local LLM) per message
  → If trash candidates:
      → postApprovalNotification activity → Slack blocks with Approve/Reject buttons
      → wf.condition(() => state !== "pending", "24 hours")
          ← user clicks Approve in Slack
          ← Slack sends block_actions event via Socket Mode WebSocket
          ← CC's slack-socket handler (apps/api/core/slack-socket.ts):
              - verifies user is in route's approver list
              - POSTs to worker's /callback/approval (bearer-authed)
              - updates Slack message in place with "✅ Approved by @you"
          ← worker's callback-server receives decision
              - executeUpdate("submitApproval", ...) → unblocks the condition
  → trashGmailMessages (Google API)
```

## Why this many layers

A naive design would hardcode channel ID + bot token in worker `.env`. That gives you one bot, one channel, no per-notification approver list, and token rotation requires a deploy. The current structure buys:

- **Operator controls without deploys** — add a bot, add a route, rotate a token, change approvers, all in `/notifications` and `/tokens`
- **Blast-radius control** — each token has one job and specific scopes; a leak compromises only what that token could do
- **Separation of credentials** — Slack tokens in CC; Google tokens in worker; neither sees the other's secrets
- **Multi-destination from day 1** — second workspace or second worker is a row insert, not a deploy

The trade-off is more concepts to learn up front. For a single-org, single-bot setup it IS more than you strictly need; the design pays off as soon as you add the second workspace, the second worker, or a second user.

## Why Temporal (not cron)

Workflows need:
- Durability through restarts (approval card may wait 24h for a click)
- Retries with backoff on activity failure
- Scheduled runs (cron-like but with catchup window + overlap policy)
- Server-side state machine (the "waiting for approval" condition)

Temporal gives all of these. Alternative: cron + a scratch DB table + hand-rolled retry logic. We'd rebuild Temporal poorly.

Workflow Updates (used for the approval callback) are opt-in via dynamic config on the Temporal server — see `infra/temporal/dynamicconfig/docker.yaml`.

## Extending the platform

The current design is email-centric at the EDGE (UI assumes "automation = Google OAuth sign-in"), not at the CORE. The core (Temporal workflow + service token + CC integrations endpoints + Slack dispatcher) is service-agnostic.

To add a new automation (examples: Slack chat summary, Amazon price watcher, GitHub PR raiser):

1. Add a new workflow file in `services/automations-worker/src/workflows/`
2. Add activities for the new API (e.g. `fetchSlackHistory`, `queryAmazonProduct`, `createGithubPR`)
3. Register the workflow in `src/worker.ts`
4. Register a Temporal schedule (or trigger externally)
5. If credentials are needed, store them in worker (same pattern as Google tokens)

No architectural change required for the first few. Three generalizations are worth making when you add the fourth service:

### A. Generalize credential storage
Rename `google_oauth_tokens` → `external_credentials` with a `service` column (`google|github|slack_user|...`). Mirror metadata to CC as `external_accounts` using the pattern established for Google.

### B. Generalize notification routes
Rename `notification_routes` → `notification_routes`, add `channel_type` enum (`slack|whatsapp|discord|in_app`), per-type connection table. Dispatcher picks the adapter at call site. Buttons remain Slack + in-app only.

### C. Automations dashboard
One CC page listing active schedules (read from Temporal), their config, and credentials they rely on. Toggle on/off here instead of in Temporal UI.

These are evolutionary, not rewrites. The three "generic" tables (notifications, credentials, dashboard) replace their Slack/Google-specific predecessors; existing workflows keep working after a column rename + an adapter indirection.

## What NOT to add

- **A plugin system** — workflows ARE the plugin system; a `.ts` file plus a schedule is the extension point
- **A workflow engine beyond Temporal** — it already handles cron, retries, long-running state, catchup windows
- **An auth gateway in front of CC** — session + service tokens cover browser and machine auth; adding a third layer is noise

## Key constraints

- Postgres roles: migrations run as `cc_admin`; app queries use `command_center_app` (RLS-scoped). `postgres` superuser bypasses all RLS; use for one-off admin only.
- `app.current_org_id` must be set on every tx that touches org-scoped tables — handled by `withTenantTx` for the normal routes, and by explicit `set_config` in cross-org admin loops (reminder sweep, socket startup).
- SECURITY DEFINER functions that run pre-tenant (like `resolve_service_token`) must either run as a superuser OR their target tables must NOT have FORCE RLS. Migration 0018 enforces the second option for `service_tokens`.
