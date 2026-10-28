# Claude Code — Command Center Handoff
> **Created:** 2026-10-28  
> **Purpose:** Read this FIRST. It is the single source of truth for what to implement and in what order.  
> **Repo:** `/Users/chandrashekar/Documents/Workspace/personal/memoryAllocator` (monorepo)  
> **Owner:** korpolechandrashekar@gmail.com  

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
  - Key sourced from `process.env.TEMPORAL_PAYLOAD_DEK` (32-byte base64)
- CREATE: `services/automations-worker/src/temporal-data-converter.ts`
  - Returns `DefaultDataConverter` with `payloadCodecs: [new EncryptionCodec()]`
- MODIFY: `services/automations-worker/src/worker.ts`
  - Add `dataConverter: await getTemporalDataConverter()` to `Worker.create()`
- ADD to `services/automations-worker/.env`:
  ```
  TEMPORAL_PAYLOAD_DEK=<run: openssl rand -base64 32>
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
OLLAMA_MAX_LOADED_MODELS=1
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

**Phase 0 Definition of Done:**
- [ ] `Temporal Web UI` shows `binary/encrypted` (not plain text) for workflow history payloads
- [ ] `TEMPORAL_PAYLOAD_DEK` env var set in worker `.env`
- [ ] `classifyEmail` / `extractExpense` / `extractBill` all use `_mutex.runExclusive()`
- [ ] All Ollama calls have `num_predict` cap
- [ ] `OLLAMA_KEEP_ALIVE=30m` in env
- [ ] `worker.ts` has `maxTaskQueueActivitiesPerSecond: 2`
- [ ] Cron schedules are staggered (not all firing simultaneously)
- [ ] XML delimiters in all 3 email extraction prompts

---

## 3. Phase 1 — Knowledge Base + DLQ (~3 weeks, after Phase 0)

### P1.0 — Dead Letter Queue for External API Failures
**New migration:** `apps/api/migrations/0051_failed_items.sql`
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
- **P3.0b** — Per-automation enable/disable toggle (M7)
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
cd apps/web && pnpm dev

# Worker:
cd services/automations-worker && pnpm worker

# Typecheck:
bunx tsc --noEmit          # in apps/api and apps/web
npx tsc --noEmit           # in services/automations-worker

# DB migrations (run from apps/api):
# Add migration SQL file as 00NN_name.sql then restart API (Bun auto-runs migrations on startup)

# Temporal schedule init (system schedules only):
cd services/automations-worker && pnpm schedules:init
```

---

## 8. Known Pre-existing Issues (Do Not Fix Unless Asked)

- `services/automations-worker`: `google-auth-library` TypeScript resolution error in `google-oauth.ts` — pre-existing, unrelated to any Phase 0–3 work. Ignore it.
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
