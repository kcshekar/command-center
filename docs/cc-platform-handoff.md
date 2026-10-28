---
name: cc-platform-handoff
description: "Command Center (CC) — personal automation platform owned by korpolechandrashekar@gmail.com. Monorepo layout, service shape, core patterns, A1–A9 automation catalog with status, and the recipe for adding a new automation. Load this first when the user asks about CC architecture, mentions one of the Axx automations, or asks to add/modify an automation."
metadata:
  node_type: memory
  type: project
  originSessionId: d4606e29-c3ca-4d2f-a3fb-48b6abf6d49f
  modified: 2026-10-28T12:00:00.000Z
---

# Command Center (CC) — platform handoff

Personal automation platform for the user. Everything runs locally against Temporal + Postgres. Secondary email `shekar4u66@gmail.com` is the test identity.

## Repo shape
Monorepo at `/Users/chandrashekar/Documents/Workspace/personal/memoryAllocator`.
- `apps/api/` — Bun + Bun.SQL, port **3001**. REST surface. Multi-tenant via RLS using `withTenantTx` setting `app.current_org_id` and `app.current_user_id`.
- `apps/web/` — Next.js, port **3000**. Hits `/api/*` through a Next rewrite so the session cookie flows. **Not standard Next** — `apps/web/AGENTS.md` says to consult `node_modules/next/dist/docs/` first (the file is a stub pre-prompt-injection warning; leave it).
- `services/automations-worker/` — Node 22+ (prod on 24 LTS) + Temporal + pnpm 9.12. Hosts workflow + activity code. Also runs a callback-server on port **3005** (OAuth popups; `/callback/*` + `/admin/*` are localhost-only for CC). Prod runs the build (`pnpm start`); dev uses `pnpm worker` (tsx watch).
- Postgres with pgvector 0.8.2 (HNSW cosine, 1536-dim). pgcrypto for `pgp_sym_encrypt` secret storage.
- Temporal is remote (address + namespace in **both** `.env` files — CC creates per-user schedules when an automation is turned on). Org-wide system schedules come from `services/automations-worker/src/scripts/init-schedules.ts` (always created paused).

## Secrets model
- Root `.env` holds shared config (TEMPORAL_*, DB url, DEKs).
- `services/automations-worker/.env` holds worker-local OAuth config (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI, GITHUB_CLIENT_ID/SECRET/REDIRECT_URI, WORKER_CALLBACK_PORT/TOKEN).
- Per-user secrets live in two places:
  - `user_credentials` — pgcrypto-encrypted with DEK `USER_CREDENTIALS_DEK`. BYOK API keys (OpenAI, Adzuna app_key, SerpAPI, RapidAPI JSearch). Non-secret identifiers (Adzuna app_id) go in plaintext metadata.
  - `external_credentials` — worker-side AES encryption for OAuth refresh/access tokens (Google per-email, GitHub per-login). Metadata holds `ccUserId` to map back to the CC uuid.
- See [[user-tech-flow]] for the rule the user asserts here.

## Core patterns to reuse (do not reinvent)
1. **Tenant transactions** — any API route reading per-user data wraps the query in `withTenantTx(userId, orgId, async (sql) => …)` which `SET LOCAL`s the two GUCs so RLS policies work.
2. **SECURITY DEFINER functions** for cross-tenant worker reads (price-watch, ttd, interview-rounds due, unembedded-knowledge, learning sources). Pattern: migration adds a function that takes `org_id` + optional limit, the worker calls it via a service-token-authed endpoint, no RLS juggle.
3. **Service tokens with scopes** — the worker mints short-lived tokens via its worker client and requests its whole `ALL_SCOPES` list (24 scopes) every time; one scope missing from the client's `allowed_scopes` = 403 on **every** call. New scope ⇒ add it to `ALL_SCOPES` (worker `cc-client.ts`), `ALLOWED_SCOPES` (`apps/api/modules/worker-clients/routes.ts`) and grant it to existing clients in a migration (see 0066); wire `requireScope` in the route.
4. **SSE channel** at `/api/events` — per-user pub/sub bus. Activities fire `cc.emitEvent({userId, type, payload})` to drive live UI refresh (toasts, list reloads). Web consumes with `useLiveEvents(["event:type"], handler)` from `apps/web/lib/live-events.ts`.
5. **Temporal workflow + activity split** — activity does the IO (fetch, parse, write), workflow is thin, orchestrates with `startToClose` + 1–2 retries. Schedules created in `init-schedules.ts` with IST timezone via `scheduleTimezone`.
6. **BYOK with fallback** — activity checks the user's `user_credentials` for the API key; absent → log `[axx.foo] no_key, skipping`, don't crash the schedule tick. Multiple providers (jobs: Adzuna + SerpAPI + JSearch; learning: GitHub + Dev.to + RSS) fan out across whichever keys exist.
7. **Idempotent ingest** — row keyed by `(source, source_id)` dedup. Interview rounds idempotent by `metadata.calendarEventId`. Expenses by `(source='gmail', external_id=messageId)`.
8. **Fire-and-forget `cc.emitEvent`** for UI toasts after a successful activity; `.catch(() => {})` because it's best-effort.
9. **Prompt-driven classification** uses `ollamaJson` with a structured JSON schema; prompts stored centrally and fetched by the worker via `prompts:read`.

## Automation catalog (A1 → A9)
| Code | Name | Trigger | Status |
| --- | --- | --- | --- |
| A1 | Morning brief | daily 07:00 IST | shipped |
| A2 | Jobs ingest (Adzuna + SerpAPI + JSearch fan-out) | daily | shipped |
| A3 | News ingest + brief (HN top stories, classified, posted) | daily | shipped |
| A4 | Calendar interview sync (next 30d, company substring match, kind-infer) | hourly | shipped |
| A5 | Mail-triage → interview scheduling (Ollama JSON extract, upsert session + round via `/from-calendar`) | per inbox-triage tick | shipped |
| A6 | Learning ingest (GitHub releases + Dev.to tags + RSS; digest post) | daily | shipped |
| A7 | Profile refresh (LinkedIn + README + Resume drafts, monthly) + **GitHub PR writer** (user-triggered, this session) | monthly 1st 10:00 IST + user-triggered | shipped — PR writer not smoke-tested, needs GITHUB_CLIENT_ID/SECRET in worker `.env` |
| A8 | Mail-reply drafter with Slack approval loop | per inbox-triage tick | shipped |
| A9 | TTD prep + price watcher | daily | shipped |
| Embedder | pgvector sweep of unembedded knowledge_items (OpenAI text-embedding-3-small, 1536-dim) | hourly | shipped — verified `{embedded:20, failed:0}` after OpenAI key added |
| Platform-upgrade scanner | repo dep scan | weekly | shipped |

## Recipe: adding a new automation (A10 …)
1. **Decide the trigger.** Scheduled (Temporal cron) vs. user-triggered (POST → `temporalClient.start`) vs. event-driven (inbox-triage dispatcher branch).
2. **Add any DB tables/columns** via a new migration in `apps/api/migrations/00NN_*.sql`. For cross-tenant worker reads, write a `SECURITY DEFINER` function alongside. Money tables (`accounts`, `expenses`, `recurring_bills`) carry `owner_user_id` + `zone` (`personal` private to the owner, `professional` shared with the org; migration 0046) — every finance query an automation makes must name the zone.
3. **API side** — add module under `apps/api/modules/<thing>/`. For routes the worker calls, use the `tenantRoute` + scope middleware already in use; mint the scope string.
4. **Integration endpoint for worker** — add handler under `apps/api/modules/integrations/routes.ts` with service-token-auth; re-enter `withTenantTx(userId, orgId)` using the explicit userId.
5. **Worker side** — add activity in `services/automations-worker/src/activities/<name>.ts`, export from `activities/index.ts`. Add workflow in `workflows/<name>.ts`, export from `workflows/index.ts`.
6. **cc-client helper** if the worker needs a new CC endpoint — add typed function in `services/automations-worker/src/cc-client.ts`.
7. **Schedule** — per-user automations: add a catalog row with `schedule_template` (`workflowType`, `cron`, `perAccount`, `args` with `$userId`/`$email`/`$zone`/`$digest`/`$approval`; `$zone` is the pinned Gmail account's Finance zone) in a migration; enabling the grant in CC creates `<automationId>:<userId>[:<email>]` schedules (`apps/api/core/automation-schedules.ts`, migration 0045). Org-wide sweeps only: register in `services/automations-worker/src/scripts/init-schedules.ts` (system schedules, no `:` in the id) and run `pnpm schedules:init`.
8. **UI** — new page under `apps/web/app/(app)/<slug>/`, nav entry in `apps/web/lib/nav-items.ts`, API client in `apps/web/lib/<slug>-api.ts`, live refresh via `useLiveEvents`.
9. **Emit an SSE event** at the end of the happy-path activity so the UI reacts.
10. **Verify at the phase boundary** (user rule from [[user-tech-flow]]) — don't ask for verify steps before each change.

## Dev commands (local)
- API: `cd apps/api && bun --hot --env-file=../../.env index.ts` (writes to `/tmp/cc-api-logs/api.log` if you redirect).
- Web: `cd apps/web && pnpm dev`.
- Worker: `cd services/automations-worker && pnpm worker` (tsx watch; auto-reloads on file edits).
- Schedules init (system schedules only): `cd services/automations-worker && pnpm schedules:init`.
- Typecheck: `bun x tsc --noEmit -p apps/api` / `-p apps/web`, `npx tsc --noEmit` in the worker (all clean as of 2026-10-28).
- Tests: `bun test apps/api`; worker `npx tsx --test $(find src -name '*.test.ts')`.
- Migrations (not run on boot): `bun run migrate` (CC), `cd services/automations-worker && pnpm migrate` (worker). Next free CC number: **0067**.
- Prod update: `./scripts/deploy.sh` on the VM (user runs it); `pnpm inventory` for a read-only snapshot. Setup/runbook: `docs/setup.md`.

## Current state
What's done, what's live in prod, and what's pending: **`docs/CLAUDE_HANDOFF.md` → "Current state — verified 2026-10-28"**. The Tier 1/2 automations (n5, r13, n9, r10, r12, r2, n8, r3, r1, r11, r7, r9, n13, r14, n12, n14) are listed there with their Ollama dependence.

## Related
- Working-style rules the user holds you to: [[user-tech-flow]]
