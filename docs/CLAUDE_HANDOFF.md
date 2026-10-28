# Claude Code — Command Center Handoff
> **Created:** 2026-10-28  
> **Purpose:** Read this FIRST. It is the single source of truth for what to implement and in what order.  
> **Repo:** `/Users/chandrashekar/Documents/Workspace/personal/memoryAllocator` (monorepo)  
> **Owner:** korpolechandrashekar@gmail.com  

---

## Current state — verified 2026-10-28 (read this before §1)

The phased plan below (§2–§5, Phase 0 → 3) is the **next feature work** and has **not started**.
Everything in this section is already built, tested and **live in prod** (prod sync finished 2026-10-28).

### Done (2026-10-26 → 2026-10-28)
**Platform**
- Inbox triage: trash approval runs as an abandoned child workflow; Gmail cursor committed after ingest.
- Signed OAuth `state` (CC-issued, HMAC over `WORKER_CALLBACK_TOKEN`) binds Google/GitHub consent to the CC user.
- Approvals settle across Slack + in-app (`settle_in_app_approval`, migration 0044).
- **Per-user schedules from the catalog** (0045): turning an automation on in `/automations` creates
  `<automationId>:<userId>[:<email>]` schedules from `automation_catalog.schedule_template`. The per-automation
  on/off toggle (roadmap "M7"/P3.0b) **already exists** this way. Only org-wide sweeps live in `init-schedules.ts`,
  and they are always created **paused** (turn on from the dashboard).
- Finance zones (0046): `owner_user_id` + `zone` (`personal` = owner only, `professional` = org) on accounts/expenses/recurring_bills.
- **Reminders are per-user** (0065): RLS `created_by = current user`; the hourly sweep visits each member.
- **Worker client scopes** (0066): the worker requests its whole `ALL_SCOPES` list on every mint, and one missing scope
  = 403 on every call. Adding a scope means updating **three** places: `ALL_SCOPES` (worker `cc-client.ts`),
  `ALLOWED_SCOPES` (`apps/api/modules/worker-clients/routes.ts`), and a migration granting it to existing worker clients.
- UI redesign: catalog-driven nav, `/today`, `/inbox`, `/automations` (+ `/automations/[id]`), Finance Personal/Business,
  `DESIGN.md` at the repo root.

**Automations added (catalog ids; all no-AI unless noted)**
| Id | What | Ollama |
|---|---|---|
| n5.spend | Daily spend report (21:00) | no |
| r13.subs / n9.bills / r10.budget / r12.networth | Subscriptions, bill forecast, budgets, net worth | no |
| r2.docs | Document expiry (reminders category `document`) | no |
| n8.learncheck | Learning check | no |
| r3.occasions | Birthdays & anniversaries | gift ideas/drafts (dropped if Ollama fails) |
| n15 / r15 | Weather + one-line note inside the morning brief | R15 line only (dropped on failure) |
| r1.sms | Bank SMS logger (`POST /api/integrations/sms`) | fallback only (deterministic parser first) |
| r11.habits / r7.groceries / r9.vehicle | Habits, groceries, vehicles | no |
| n13.meetings | Meeting prep (local Postgres full-text search) | no |
| r14.travel | Trip pack (deterministic detector before triage classify) | yes |
| n12.ca | Monthly CA invoices → Slack approval → email | cover email draft (API side) |
| n14.security | Weekly OSV scan, dependency inventory (worker migration 0005) | no |

**Dependencies, tooling and ops**
- All security fixes applied; majors done (next 16.4.1, nodemailer 10, zod 4, googleapis 186, @google-cloud/storage 8.4).
- `bunfig.toml` `minimumReleaseAge` = 7 days (supply-chain guard). The worker's pnpm 9.12 has no such guard, so check new packages' publish dates by hand.
- `pnpm inventory` (worker): read-only prod snapshot (versions, missing env **names**, pending migrations, schedules, Ollama/Chrome).
- `./scripts/deploy.sh` (or `bun run deploy`): one-command prod update (build → backup both DBs → migrate → `pm2 restart` → inventory).
- Worker runs built in prod (`pnpm start` = `node dist/worker.js`), not `tsx watch`. Prod VM is on Node 24 LTS; pm2 is a global npm package per nvm version (`nvm reinstall-packages <old>` + `pm2 update` when switching Node).
- Worker `pnpm migrate` uses `ADMIN_DATABASE_URL`, else the main `.env` `DATABASE_URL`.
- nginx proxies only `/automations/auth/` to the worker (`/automations` is a CC page).

**Prod (GCP VM, pm2: cc_api :3011, cc_web :3010, automations-worker; Temporal on GKE)**
- CC migrations through 0066 and worker migrations through 0005 applied. Morning brief verified end-to-end (UI → Temporal → worker → Slack).
- The user enables automations one at a time in prod. Deploys and VM commands are run **by the user**; never SSH.

### Pending / open
- **Ollama in prod:** it runs as a pod in another GKE cluster, and the user will set `OLLAMA_HOST` in **both** `.env` files.
  Until then keep triage (a5.mail, which fails hard without the model), news, jobs, learning, profile, interview prep and r14.travel **off**.
- **Knowledge embedder is PAUSED** (D4). Re-enable only with local embeddings (P2.0 below); D5 is open.
  Remind the user at the end of each work summary until it's re-enabled.
- Not yet exercised in prod: evening wrap, the reminders → Slack sweep, and a Slack approval round-trip (safe test: CA batch → **Hold**).
- N14 step 2 (auto PRs for minor fixes) needs a GitHub OAuth app (`GITHUB_CLIENT_ID/SECRET`). The A7 PR writer has the same dependency.
- On hold by the user: Tier 3 automations (N1, N2, N3, N6, N7, N10, N11, R4, R5, R8), N4 (Slack user token), R6 (flights).
- Known limits: the reminder alert route `reminders.due` is org-wide, so in a multi-user org members see each other's titles.
  A reminder on a shared business bill is visible only to its creator.

### Corrections to the rest of this doc
- **Migrations are not run on API startup.** Run `bun run migrate` (CC) and `pnpm migrate` (worker). Numbers 0051–0068 are **taken**
  (0067 = P0.3 cron stagger, 0068 = P1.0 `failed_items`, 0069 = P2.0 768-dim embeddings); the next free number is **0070**.
- The `google-auth-library` type error in §8 is **fixed** (the worker typecheck is clean).
- Web dev: `cd apps/web && API_ORIGIN=http://localhost:3001 bun run dev` (bun, not pnpm). API: `API_PORT=3001 bun --env-file=.env apps/api/index.ts` from the repo root.
- Working rules: `docs/user-tech-flow.md` (no hallucination, confirm risky actions, zero-SSH, BYOK).

---

## 0. Before Anything Else — Read These Docs

Load these docs in order before writing a single line of code:

1. **`docs/cc-platform-handoff.md`** — monorepo layout, core patterns (RLS, service tokens, SSE, BYOK, idempotency), automation catalog A0–A9, dev commands.
2. **`docs/automations-research/IMPLEMENTATION_ROADMAP.md`** — full phased implementation plan with step-by-step specs for every item.
3. **`docs/automations-research/DECISIONS_AND_ARCHITECTURE.md`** — locked architecture decisions (Finance zones, notification channels, LLM privacy policy).

---

## 1. Current Verified State of Files You Will Touch

These were read directly on 2026-10-28. Use these as your ground truth:

### `services/automations-worker/src/ollama.ts` (160 lines)
- **State:** 4 exported functions: `classifyEmail`, `extractExpense`, `extractBill`, `ollamaText`, `ollamaJson`
- **Missing:** No `Mutex`, no `num_predict`, no `num_ctx` options, no XML delimiters around user content
- **Action needed (P0.2 + P0.4):** Add mutex wrapping all fetch calls, add `num_predict`/`num_ctx` per call type, add XML delimiters in all 3 extraction functions

### `services/automations-worker/src/worker.ts` (32 lines)
- **State:** Minimal — `Worker.create({ connection, namespace, taskQueue, workflowsPath, activities })`
- **Missing:** No `dataConverter`, no `maxTaskQueueActivitiesPerSecond`, no `maxConcurrentActivityTaskExecutions`
- **Action needed (P0.1 + P0.3):** Add `dataConverter` for AES-GCM encryption, add throttle options

### `services/automations-worker/src/activities/embedder.ts` (103 lines)
- **State:** Sends knowledge_items to `api.openai.com/v1/embeddings` (text-embedding-3-small, 1536-dim)
- **Action needed (P2.0):** Replace with local `ollama pull nomic-embed-text` (768-dim). Requires DB migration to change vector column dimension.

### `services/automations-worker/src/activities/jobs.ts` (340 lines)
- **State:** `ingestAdzunaJobs` — catches errors with `console.warn` + silent `failed++` counter. No DLQ.
- **Action needed (P1.0):** Route 429/503 HTTP errors to `cc.recordFailedItem()` DLQ call.

### `services/automations-worker/src/activities/index.ts` (318 lines)
- **State:** Barrel export of all activities. All new activities MUST be added here.
- **Action needed:** Add new exports as new activities are created (knowledge-rag, react-agent)

### `apps/web/app/(app)/knowledge/page.tsx`
- **State:** Serves `kb_commands` (snippet clipboard — not knowledge_items)
- **Action needed (P1.1):** Rename entire directory to `/vault`, update nav-items.ts

---

## 2. Phase 0 — DO THIS FIRST (all 4 items, ~1 week)

**RULE: Phase 1 must NOT start until Phase 0 DoD checklist is fully checked off.**

### P0.1 — Temporal AES-GCM Payload Encryption
**Files to create/modify:**
- CREATE: `services/automations-worker/src/encryption-codec.ts`
  - Implements `PayloadCodec` interface from `@temporalio/common`
  - Uses `crypto.subtle` (Node.js WebCrypto) for AES-GCM encrypt/decrypt
  - Key sourced from `process.env.TEMPORAL_PAYLOAD_DEK` (32-byte hex)
- CREATE: `services/automations-worker/src/temporal-data-converter.ts`
  - Returns `DefaultDataConverter` with `payloadCodecs: [new EncryptionCodec()]`
- MODIFY: `services/automations-worker/src/worker.ts`
  - Add `dataConverter: await getTemporalDataConverter()` to `Worker.create()`
- ADD to `services/automations-worker/.env`:
  ```
  TEMPORAL_PAYLOAD_DEK=<run: openssl rand -hex 32>
  ```

**IMPORTANT:** Both the Temporal Worker AND any Temporal Client that starts workflows must use the same DataConverter.

### P0.2 — Ollama Mutex + num_ctx + num_predict + OLLAMA_KEEP_ALIVE
**File to modify:** `services/automations-worker/src/ollama.ts`

Add at top of file (after imports):
```typescript
import { Mutex } from 'async-mutex';
const _mutex = new Mutex();
```

Wrap all `fetch()` calls in `_mutex.runExclusive(async () => { ... })`.

Update `ollamaJson()` signature to:
```typescript
export async function ollamaJson(
  prompt: string, 
  schema?: unknown, 
  opts?: { ctx?: number; num_predict?: number }
): Promise<any>
```

Pass to Ollama options:
- `num_ctx`: 512 for classification calls, 2048 for generation
- `num_predict`: 150 for classification, 500 for drafts, 100 for structured extraction

Update callers:
- `classifyEmail`, `extractExpense`, `extractBill` → `opts: { ctx: 512, num_predict: 150 }`
- `ollamaText` → `opts: { ctx: 2048, num_predict: 500 }`

Add to `services/automations-worker/.env` (Ollama daemon vars, not worker vars):
```
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=2   # 2 since P2.0: chat model + nomic-embed-text
OLLAMA_KEEP_ALIVE=30m
OLLAMA_NUM_THREADS=<physical core count>
```

Check for `async-mutex`: `ls services/automations-worker/node_modules/async-mutex 2>/dev/null || pnpm add async-mutex` (run from `services/automations-worker/`)

### P0.3 — Cron Staggering + Worker Throttle
**File to modify:** `services/automations-worker/src/worker.ts`

Add to `Worker.create()`:
```typescript
maxTaskQueueActivitiesPerSecond: 2,
maxConcurrentActivityTaskExecutions: 4,
```

**Stagger schedules** in `services/automations-worker/src/scripts/init-schedules.ts` or the automation schedule DB rows. Ensure daily automations are 5min apart, not all at 07:00 IST.

### P0.4 — Prompt Injection Guard in Email Extraction
**File to modify:** `services/automations-worker/src/ollama.ts`

Update all 3 extraction functions to wrap user-controlled content in XML tags:

```typescript
// In classifyEmail():
const prompt = `Classify the email between <email> tags. Output ONLY valid JSON.

...instructions...

<email>
From: ${from.slice(0, 100)}
Subject: ${subject.slice(0, 200)}
Snippet: ${snippet.slice(0, 1000)}
</email>

JSON:`;

// Same pattern for extractExpense() and extractBill()
```

**Phase 0 Definition of Done** (done in dev 2026-10-28; prod pending the deploy steps below):
- [x] `Temporal Web UI` shows `binary/encrypted` (not plain text) for workflow history payloads (verified by the user)
- [x] `TEMPORAL_PAYLOAD_DEK` env var set in worker `.env` (64 hex chars, `openssl rand -hex 32`; codec rejects anything else)
- [x] `classifyEmail` / `extractExpense` / `extractBill` all use `_mutex.runExclusive()`
- [x] All Ollama calls have `num_predict` cap (150 classify/extract, 500 text, 1536 other JSON). One fixed `num_ctx` = 4096: changing it per call forces an Ollama model reload.
- [x] `OLLAMA_KEEP_ALIVE=30m` in env (daemon var: must also be set on the Ollama pod)
- [x] `worker.ts` has `maxTaskQueueActivitiesPerSecond: 2`
- [x] Cron schedules are staggered (CC migration 0067 + system crons in `init-schedules.ts`)
- [x] XML delimiters in all 3 email extraction prompts (planted `<email>` tags are stripped)

Self-check: `cd services/automations-worker && pnpm exec tsx src/scripts/check-phase0.ts`.

**Fixed alongside P0.3:** every schedule was firing in **UTC**. The code passed `timezoneName` (the proto name), which
the TS SDK silently ignores; the SDK field is `spec.timezone`. Fixed in `automation-schedules.ts` and `init-schedules.ts`.

**Phase 0 prod rollout (user runs on the VM):**
1. Add `TEMPORAL_PAYLOAD_DEK=<openssl rand -hex 32>` to the prod worker `.env` **before** deploying. The worker refuses
   to start without it. Keep it forever: losing it makes encrypted history unreadable.
2. `./scripts/deploy.sh` (applies CC migration 0067).
3. `bun --env-file=.env apps/api/scripts/resync-schedule-crons.ts` (add `--dry-run` first): pushes catalog crons +
   IST timezone onto existing per-user schedules. Pause state is untouched.
4. `cd services/automations-worker && pnpm schedules:init`: same for the system schedules.
5. On the Ollama pod: `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=2` (2 since P2.0), `OLLAMA_KEEP_ALIVE=30m`.

---

## 3. Phase 1 — Knowledge Base + DLQ (~3 weeks, after Phase 0)

**Status (2026-10-28): built and tested in dev; not yet in prod.** What actually shipped (the specs below are the original plan):
- **P1.0 DLQ:** migration 0068 (`failed_items`, owner RLS, one open row per owner/automation/item_type/source_id; repeats bump
  `attempts`), `POST /api/integrations/failed-items` (scope `failures:write`, granted to all worker clients in 0068),
  worker `src/dlq.ts`. Only transient external failures are recorded (408/429/5xx, network); a 401/404 stays a log line.
  Wired into A2 (Adzuna/SerpAPI/JSearch per-source catches) and A8 (learning fetchers now throw on 429/5xx).
  N14's OSV calls already fail the run loudly, so they're not dead-lettered. No UI yet (Phase 3 /health).
- **P1.0b codec server:** `pnpm codec-server` (node:http, no Express), binds 127.0.0.1:8081, CORS from `CODEC_CORS_ORIGINS`.
  Run it on your own machine with the DEK of the env you're inspecting; dev UI is `http://chandu-h110:8080`.
- **P1.0c task queues:** `src/workflows/task-queues.ts` routes activities by name (`routedActivities()` replaces
  `proxyActivities` in every workflow). `worker.ts` runs activity-only workers for `google-api` (1/s), `external-jobs-api`
  (2/s) and `ollama-local` (concurrency 1) in the same process, so the Ollama mutex still covers all queues.
- **P1.1:** `/vault` is the **Password Vault**; `/knowledge` was already labelled "Command Vault", so no rename.
  New `/brain` page (search, type filter, add, edit, delete) on the existing `/api/knowledge-items` routes; `resume` added to KNOWN_TYPES.
- **P1.2 (decision 2026-10-28):** full-text only. The existing integration search gained a comma-separated `type` filter,
  `source` and capped `body`; vector arm + RRF move to P2.0 with local embeddings. SQL runs in ~0.3 ms on dev.
- **P1.3:** `activities/knowledge-rag.ts` (`retrieveKnowledgeContext`, terms OR-ed; `knowledgeBlock` fences items as data).
- **P1.4:** A2 retrieves profile/resume/note items once per run and injects them into the job scorer prompt. A11 (the
  "Automater" in the roadmap is the deterministic upgrade scan) quotes the user's own lesson/note that names a package
  next to that upgrade. It reads the lessons of the worker's acting user (the token's user), so no extra config.

**Phase 1 prod rollout (user runs on the VM):**
1. `./scripts/deploy.sh` (CC migration 0068 runs before the worker restarts, so the new scope exists when the worker mints).
2. Add 5–10 items on `/brain`: profile, tech stack, resume summary, 2–3 lessons (e.g. upgrades that bit you).

**Phase 1 DoD:**
- [x] /brain page exists and shows knowledge_items with search
- [x] Command Vault (kb_commands) stays at /knowledge; /vault is the Password Vault (rename dropped)
- [x] Search query <200ms (0.3 ms SQL on dev). Note: every dev CC API call takes ~1–4 s end to end regardless of endpoint; not search-specific.
- [x] A2 job scoring Ollama prompt includes user profile context
- [x] Upgrade scan reads the user's lesson items before posting

### P1.0 — Dead Letter Queue for External API Failures
**New migration:** `apps/api/migrations/0068_failed_items.sql` (0067 is taken by the P0.3 cron stagger)
```sql
CREATE TABLE failed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  source_id TEXT,
  payload JSONB NOT NULL,
  error_message TEXT,
  error_code TEXT,
  attempts INT DEFAULT 1,
  failed_at TIMESTAMPTZ DEFAULT NOW(),
  retry_after TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  user_id UUID NOT NULL
);
CREATE INDEX idx_fi_user_unresolved ON failed_items (user_id, failed_at DESC) WHERE resolved_at IS NULL;
```

**New CC API route:** `POST /api/integrations/failed-items` with service token auth (`failures:write` scope — mint new scope).

**New cc-client method:** `cc.recordFailedItem(input: { automationId, itemType, sourceId?, payload, errorCode?, errorMessage?, userId })`.

**Update `jobs.ts`:** In `ingestAdzunaJobs`, replace bare `console.warn` + `failed++` for HTTP 429/503 errors with `await cc.recordFailedItem(...)`. Keep `console.warn` for internal errors (missing profile, bad JSON).

### P1.0b — Codec Server for Temporal UI (M9)
**New file:** `services/automations-worker/src/codec-server.ts`  
Mini Express app on port 8081. POST `/decode` → decrypt using `EncryptionCodec` → return JSON. CORS restricted to `http://localhost:8233`. Configure Temporal Web UI to point at `http://localhost:8081`.

### P1.0c — Per-API Task Queues (M11)
Separate worker instances (or multi-queue config) for:
- `google-api` queue: `maxTaskQueueActivitiesPerSecond: 1`
- `external-jobs-api` queue: `maxTaskQueueActivitiesPerSecond: 2`
Route Gmail/Calendar activities → `google-api`, Adzuna/SerpAPI → `external-jobs-api`.

### P1.1 — /brain UI Page + /vault Rename
Rename `apps/web/app/(app)/knowledge/` → `apps/web/app/(app)/vault/`.  
Update `apps/web/lib/nav-items.ts`: "Knowledge" → "Command Vault".  
Create `apps/web/app/(app)/brain/page.tsx` — search + type filter + card grid for `knowledge_items`.

### P1.2 — Hybrid Search Endpoint
New endpoint: `GET /api/integrations/knowledge/search?q=&type=&limit=10`  
Query: pgvector cosine + Postgres FTS merged via RRF (see IMPLEMENTATION_ROADMAP.md P1.2 for full SQL).

### P1.3 — RAG Retrieval Activity
New file: `services/automations-worker/src/activities/knowledge-rag.ts`  
Export `retrieveKnowledgeContext()`. Add `cc.searchKnowledge()` to cc-client. Export from index.ts.

### P1.4 — Wire RAG into A2 + Automater
See IMPLEMENTATION_ROADMAP.md P1.4 for exact injection points.

---

## 4. Phase 2 — ReAct + Tool Calling (~4 weeks, after Phase 1)

**Status (2026-10-29): P2.0, P2.1, P2.2 and the Interview Prep half of P2.4 built and tested in dev. A2 (P2.3 fan-out B
+ ReAct scoring) is ON HOLD pending the user's Ollama capacity decision.** What shipped:
- **P2.0:** migration 0069 (`embedding` → `vector(768)`, old vectors dropped, HNSW rebuilt). Embedder uses local
  `nomic-embed-text` via `ollamaEmbed()` (batched, `search_document:` prefix); no OpenAI key needed. Hybrid search
  (`searchKnowledge` in knowledge-items routes): full-text + pgvector cosine, RRF k=60, vector arm cut at distance 0.45;
  query embedded in the API (`embedQuery`, 5 s timeout, falls back to full-text). Both search endpoints use it.
- **P2.2:** `ollamaWithTools()` (/api/chat, same mutex).
- **P2.1:** `activities/react-agent.ts`, 5 tools. userId is bound by the activity, write_knowledge is opt-in,
  web_search = SerpAPI BYOK (no key → "unavailable"), refuses queries with "@". At max iterations it asks for a final
  answer instead of throwing.
- **P2.4 (Interview Prep):** `researchCompanyForInterview` (ReAct: web_search + search_knowledge + get_profile) runs
  before the draft behind `patched("interview-prep-react-v1")`. `verifiedBullets` drops any [web]/[notes] bullet whose
  tool returned nothing: in dev, llama3.2:3b tagged invented facts "[web]" with web search unavailable.
- **P2.3 fan-out A (Gmail accounts):** already covered: each pinned account has its own `a5.mail:<user>:<email>`
  schedule (0045), so accounts already run as independent parallel workflows. Nothing to build.
- **Measured on chandu-h110 (CPU-only, Ollama 0.32.6):** decode ~9 tok/s, prompt ~33 tok/s, throughput flat at
  1/2/4 concurrent requests. ReAct research ≈ 75 s; Interview Prep end to end ≈ 2 min.

**Phase 2 prod rollout (user):**
1. On the Ollama pod: `ollama pull nomic-embed-text`; set `OLLAMA_MAX_LOADED_MODELS=2` (was 1: with 1, every embed
   evicts the chat model), keep `OLLAMA_KEEP_ALIVE=30m`.
2. `OLLAMA_HOST` must be set in the **API** `.env` too (query embeddings); without it search is full-text only.
3. `./scripts/deploy.sh` (migration 0069 drops old vectors).
4. Turn on `knowledge-embedder-hourly` from the dashboard (D4 resolved: embeddings are local now).
5. Optional: a `serpapi` key in Secrets enables web_search for Interview Prep.

**Phase 2 DoD:**
- [x] `reactAgentActivity` exists and runs 5 tools (live: web_search, search_knowledge, fetch_job_details, get_profile, write_knowledge)
- [x] `ollamaWithTools()` works with llama3.2:3b tool_calls (mechanically reliable; reasoning quality weak, see guard)
- [ ] A2 uses child workflows for parallel job processing: **on hold** (user decision)
- [x] Interview Prep uses ReAct for company research
- [x] Multiple Gmail accounts triaged in parallel (already true via per-account schedules)

### P2.0 — Switch Embedder to nomic-embed-text (M3)
Run: `ollama pull nomic-embed-text` (768-dim).  
Modify `embedder.ts`: replace OpenAI embed call with `http://localhost:11434/api/embed`.  
DB migration: change `embedding` column type from `vector(1536)` to `vector(768)`. Drop existing embeddings, re-embed on next sweep.

### P2.1 — Generic `reactAgentActivity`
New file: `services/automations-worker/src/activities/react-agent.ts`  
See IMPLEMENTATION_ROADMAP.md P2.1 for full TypeScript pattern.

### P2.2 — `ollamaWithTools()` 
Add to `ollama.ts`: uses `/api/chat` (not `/api/generate`). Must be inside `_mutex.runExclusive()`.

### P2.3 — Multi-Agent Child Workflows
2-level fan-out using `wf.executeChild()`. See IMPLEMENTATION_ROADMAP.md P2.3.

### P2.4 — Wire ReAct into A2 + Interview Prep
See IMPLEMENTATION_ROADMAP.md P2.4.

---

## 5. Phase 3 — Intelligence Layer (~3 weeks, after Phase 2)

In order:
- **P3.0** — Temporal test suite (vitest + `@temporalio/testing`)
- **P3.0b** — ~~Per-automation enable/disable toggle (M7)~~ already exists (catalog grants, 0045)
- **P3.0c** — Dry-run mode (M8)
- **P3.0d** — DB slow query audit (M6) — one-time SQL, no code change
- **P3.0e** — Prometheus metrics (M5) — `prom-client` in `callback-server.ts`
- **P3.1** — Automation Health Dashboard (`automation_runs` table + `/health` page)
- **P3.2** — Goal Tracking + Automation Alignment
- **P3.3** — Weekly Narrative Workflow (Sunday 09:00 IST)
- **P3.4** — Simple SQL threshold correlation insights

See IMPLEMENTATION_ROADMAP.md for full specs on each.

---

## 6. Architecture Rules — Never Deviate

1. **Activities = all IO.** LLM calls, HTTP calls, DB writes → always in activities.
2. **Workflows = thin orchestration.** No business logic, no HTTP, no DB.
3. **Ollama LOCAL for all PII.** Email, financial data, health data → never to external LLMs.
4. **BYOK + graceful skip.** Missing credential → log `[aX.name] no_key, skipping` → return empty.
5. **Idempotent ingest on (source, source_id).** All ingest activities safe to replay.
6. **RLS always.** `withTenantTx(userId, orgId)` wraps all per-user API queries.
7. **SSE event at happy path end.** `cc.emitEvent({ userId, type, payload })`.
8. **Service token scopes.** Mint minimal scope per new integration endpoint.
9. **No `setTimeout` or raw cron.** All scheduled work = Temporal.
10. **Finance zones.** Money queries always specify `zone: 'personal'` or `'professional'`. Never query without zone.

---

## 7. Dev Commands

```bash
# API (from repo root):
cd apps/api && bun --hot --env-file=../../.env index.ts

# Web:
cd apps/web && API_ORIGIN=http://localhost:3001 bun run dev

# Worker:
cd services/automations-worker && pnpm worker

# Typecheck:
bunx tsc --noEmit          # in apps/api and apps/web
npx tsc --noEmit           # in services/automations-worker

# DB migrations (NOT run on API startup):
bun run migrate                                   # CC, from repo root
cd services/automations-worker && pnpm migrate    # worker DB

# Prod: ./scripts/deploy.sh on the VM (user runs it); pnpm inventory to check

# Temporal schedule init (system schedules only):
cd services/automations-worker && pnpm schedules:init
```

---

## 8. Known Pre-existing Issues (Do Not Fix Unless Asked)

- ~~`google-auth-library` type error in `google-oauth.ts`~~ — fixed 2026-10-28 (type now comes from `googleapis`).
- `apps/web/AGENTS.md`: prompt-injection stub. Leave it as-is.
- A7 GitHub PR writer is wired but not smoke-tested. Needs `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in worker `.env`.

---

## 9. Phase 0 Start — Exact File Order

Implement in this order to minimise conflicts:

1. `encryption-codec.ts` + `temporal-data-converter.ts` (new files — no conflicts)
2. `worker.ts` (add `dataConverter` + throttle options)
3. `ollama.ts` (mutex + num_predict + XML delimiters — single file, bulk edit)
4. `.env` additions for both Temporal and Ollama vars
5. Cron stagger in `init-schedules.ts` or automation schedule migration

After all 5 done → run verification checklist from Phase 0 DoD above.

---

*Full implementation specs: `docs/automations-research/IMPLEMENTATION_ROADMAP.md`*  
*Platform patterns: `docs/cc-platform-handoff.md`*  
*Architecture decisions: `docs/automations-research/DECISIONS_AND_ARCHITECTURE.md`*
