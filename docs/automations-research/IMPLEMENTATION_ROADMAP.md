# CC Platform Roadmap — Master Plan
> **Updated:** 2026-10-28 — Added M2, M3, M5, M6, M7, M8, M9, M11, M12 + DLQ into phases.
> **Purpose:** Machine-readable roadmap for Claude/Gemini agents. Load this doc when the user asks to implement any Phase 0–4 item.
> **Status:** PLANNED — Phase 0 ready to implement.
> **Last Updated:** 2026-10-27
> **DO NOT START** any Phase 1+ item before Phase 0 is fully shipped.

---

## Phase 0 — Critical Fixes (Ship First, ~1 week)

### P0.1 — Temporal AES-GCM Payload Encryption
**Status:** NOT STARTED  
**Priority:** CRITICAL  
**Problem:** Temporal workflow history stores all activity args and results as plain JSON. Email bodies, expense amounts, medication names, bank account numbers are visible in Temporal Web UI to anyone with namespace access.

**Implementation:**
1. Create `services/automations-worker/src/encryption-codec.ts` implementing `PayloadCodec` interface using AES-GCM via Node.js `crypto.subtle` (WebCrypto API). Reuse AES helpers from existing `crypto.ts` if compatible, otherwise use `webcrypto`.
2. Create `services/automations-worker/src/temporal-data-converter.ts` that instantiates `EncryptionCodec` with `TEMPORAL_PAYLOAD_DEK` env var and returns a `DefaultDataConverter` with `payloadCodecs: [codec]`.
3. Modify `services/automations-worker/src/worker.ts`: add `dataConverter: await getTemporalDataConverter()` to `Worker.create()`.
4. Add `TEMPORAL_PAYLOAD_DEK=<32-byte base64 secret>` to `services/automations-worker/.env` (generate with `openssl rand -base64 32`).
5. **Optional but recommended:** Create a Codec Server Express app on port 8081 with `/encode` and `/decode` endpoints so Temporal UI can decrypt payloads during debugging.

**Key constraint:** Both the Temporal Client (when starting workflows from API) AND the Worker must use the same DataConverter. If the API ever starts workflows directly, it also needs this converter.

**Env vars added:**
- `TEMPORAL_PAYLOAD_DEK` — 32-byte AES-GCM key (base64 encoded)

---

### P0.2 — Ollama Concurrency Semaphore + Env Vars
**Status:** NOT STARTED  
**Priority:** CRITICAL  
**Problem:** Multiple Temporal activities call `ollama.ts` functions simultaneously with no throttle. Concurrent Ollama calls can freeze the Mac for 30–60 seconds. No context window (num_ctx) limits set — wastes RAM.

**Implementation:**
1. Modify `services/automations-worker/src/ollama.ts`:
   - Add module-level `Mutex` from `async-mutex` package (or write a 5-line semaphore class). All `ollamaJson()` and `ollamaText()` calls wrap in `_mutex.runExclusive()`.
   - Add optional `ctx` parameter (default 512 for classification, 2048 for generation) and pass as `options.num_ctx` in request body.
   - Short classification prompts (classifyEmail, extractExpense, extractBill): use `ctx=512`.
   - Generation prompts (ollamaText for drafts, affirmations): use `ctx=2048`.
2. Add to `services/automations-worker/.env`:
   ```
   OLLAMA_NUM_PARALLEL=1
   OLLAMA_MAX_LOADED_MODELS=1
   OLLAMA_NUM_THREADS=<physical_core_count_of_mac>
   OLLAMA_KEEP_ALIVE=30m
   ```
   These are read by the Ollama daemon, not the worker. Set them before starting Ollama.

**Package:** `async-mutex` — already likely in `node_modules`. If not: `pnpm add async-mutex` in `services/automations-worker`.

---

### P0.3 — Cron Staggering + Temporal Task Queue Throttle
**Status:** NOT STARTED  
**Priority:** CRITICAL  
**Problem:** Multiple daily automations fire at the same cron time, hitting Google/Adzuna APIs simultaneously. Temporal has no task queue throttle configured.

**Implementation:**
1. **Stagger schedule times** in the automation schedule catalog (DB migration or `init-schedules.ts`):
   - A0 (Morning Brief): `0 7 * * *` (07:00 IST — unchanged)
   - A1/A3 (News): `5 7 * * *` (07:05 IST)
   - A2 (Jobs): `10 7 * * *` (07:10 IST)
   - A6 (Learning): `15 7 * * *` (07:15 IST)
   - Other dailies: continue at +5min intervals
2. **Worker throttle** in `services/automations-worker/src/worker.ts`:
   ```typescript
   const worker = await Worker.create({
     ...existing,
     maxTaskQueueActivitiesPerSecond: 2,      // global: 2 activities/sec max
     maxConcurrentActivityTaskExecutions: 4,   // max 4 activities running at once
   });
   ```

---

### P0.4 — Prompt Injection Guard in Email Processing
**Status:** NOT STARTED  
**Priority:** IMPORTANT  
**Problem:** Email body content passed directly to Ollama prompts without sanitization. Malicious emails can inject instructions.

**Implementation:**
1. In `services/automations-worker/src/ollama.ts`, update all 3 extraction functions (`classifyEmail`, `extractExpense`, `extractBill`) to wrap user-controlled content in XML delimiters:
   ```
   From: <from>
   Subject: <subject>
   Body: <body>...content...</body>
   ```
2. Truncate user content: snippet/body max 1000 chars, subject max 200 chars, from max 100 chars.
3. Tighten schema rejection: if Ollama returns JSON that fails schema validation → return null (already partially done, make explicit for all 3 functions).

### P0.5 — OLLAMA_KEEP_ALIVE + num_predict Cap (M12)
**Status:** NOT STARTED  
**Priority:** IMPORTANT  
**Problem:** Ollama unloads model between runs → 5–15s cold-start delay per automation. Also no upper bound on tokens generated.

**Implementation:**
1. Add to `services/automations-worker/.env`: `OLLAMA_KEEP_ALIVE=30m` (read by Ollama daemon, not worker)
2. Add `num_predict` to all Ollama calls:
   - Classification calls (`classifyEmail`, `extractExpense`, `extractBill`, `classifyNewsItem`): `num_predict: 150`
   - Draft generation calls (`ollamaText`): `num_predict: 500`
   - Structured JSON extraction: `num_predict: 100`
3. This bounds maximum token generation per call, preventing runaway generation from stuck prompts.

**Definition of Done (Phase 0):**
- [ ] Temporal Web UI shows `binary/encrypted` payloads, not plain text
- [ ] Running morning-brief + inbox-triage simultaneously does NOT spike CPU/freeze Mac
- [ ] Cron schedule table shows staggered times (not all at 07:00)
- [ ] Email prompts use XML delimiters in all 3 Ollama extraction functions
- [ ] OLLAMA_KEEP_ALIVE set; cold-start delay eliminated between automations

---

## Phase 1 — Knowledge Base / Active RAG (~3 weeks)

> **Prerequisite:** Phase 0 complete.

### P1.0 — Dead Letter Queue (DLQ) for External API Failures
**Status:** NOT STARTED  
**Priority:** HIGH  
**Problem:** Failed job leads, news stories, CVE findings are silently dropped with `console.warn`. No visibility, no retry. You won't know a 429 from Adzuna ate your job leads.

**New DB migration:** `apps/api/migrations/0051_failed_items.sql`
```sql
CREATE TABLE failed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id TEXT NOT NULL,       -- 'A2', 'N14'
  item_type TEXT NOT NULL,           -- 'job_lead', 'dep_vuln'
  source_id TEXT,
  payload JSONB NOT NULL,            -- original data for replay
  error_message TEXT,
  error_code TEXT,                   -- 'ADZUNA_429', 'OSV_TIMEOUT'
  attempts INT DEFAULT 1,
  failed_at TIMESTAMPTZ DEFAULT NOW(),
  retry_after TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  user_id UUID NOT NULL
);
CREATE INDEX idx_fi_user_unresolved ON failed_items (user_id, failed_at DESC)
  WHERE resolved_at IS NULL;
```

**New `cc-client.ts` method:** `cc.recordFailedItem(input)` — POST `/api/integrations/failed-items`

**Changes to activities:**
- `jobs.ts` `ingestAdzunaJobs`: replace bare `console.warn` + `failed++` with `cc.recordFailedItem()` for 429/503 errors. Other errors still skip silently.
- `security-scan.ts` `collectFindings`: record OSV timeout failures to DLQ.
- Pattern: only route to DLQ on **external API failures** (HTTP error codes). Internal logic failures (missing profile, bad JSON) stay as logs.

**UI:** Add "Failed Items" section to Phase 3 /health page. Shows by automation with Retry + Dismiss buttons.

---

### P1.0b — Codec Server for Temporal UI (M9)
**Status:** NOT STARTED  
**Problem:** After Phase 0.1 encryption, Temporal Web UI shows `binary/encrypted` blobs — debugging becomes blind.

**Implementation:** Create `services/automations-worker/src/codec-server.ts` — minimal Express app on port 8081:
- POST `/decode` — receives array of Temporal Payload objects → decrypts using same `EncryptionCodec` → returns plaintext JSON
- POST `/encode` — reverse (for UI completeness)
- Configure Temporal Web UI: Settings → Codec Server → `http://localhost:8081`
- CORS: restrict to `http://localhost:8233` (Temporal Web UI) only

**Effort:** ~2 hours

---

### P1.0c — Per-API Dedicated Task Queues (M11)
**Status:** NOT STARTED  
**Problem:** All activities share one task queue (`personal-automations`). A Google API 429 storm affects Adzuna and vice versa. No isolation.

**Implementation:**
1. Create separate task queues in worker:
   - `google-api` queue: `maxTaskQueueActivitiesPerSecond: 1` (Google is strict)
   - `external-jobs-api` queue: `maxTaskQueueActivitiesPerSecond: 2`
   - `ollama-local` queue: `maxConcurrentActivityTaskExecutions: 1` (already covered by mutex, but queue isolation adds clarity)
2. Route activities to queues: Gmail/Calendar/Tasks activities → `google-api`. Adzuna/SerpAPI → `external-jobs-api`. Ollama → `ollama-local`.
3. Update `services/automations-worker/src/worker.ts` to create and register 3 workers (or use a single multi-queue worker if SDK supports it).

**Effort:** ~1 day

### P1.1 — /brain Page (UI) + Command Vault Rename
**Status:** NOT STARTED  
**Problem:** knowledge_items are filled by the embedder but no automation reads them. The /knowledge page serves kb_commands (snippet clipboard), which is a different system. Navigation is confusing.

**Implementation:**
1. Rename `/knowledge` → `/vault` in Next.js: `apps/web/app/(app)/knowledge/` → `apps/web/app/(app)/vault/`
2. Update `apps/web/lib/nav-items.ts`: rename "Knowledge" → "Command Vault" (icon: `Terminal`).
3. Create `apps/web/app/(app)/brain/page.tsx` — new page for knowledge_items:
   - Search bar (calls hybrid search endpoint)
   - Type filter tabs: all / profile / resume / note / lesson / snippet / brief
   - Card grid with title, type badge, content preview, embedding status badge
   - Item detail drawer with full content + edit
4. Add nav entry "Brain" with icon `Brain` or `Cpu` to nav-items.ts.
5. **Seed data task for user:** Add 5–10 knowledge_items manually to /brain before testing RAG (profile, tech stack, resume summary, 2–3 lessons learned).

**Files changed:**
- `apps/web/app/(app)/knowledge/` → moved to `vault/`
- `apps/web/app/(app)/brain/page.tsx` — new
- `apps/web/lib/nav-items.ts` — updated

---

### P1.2 — Hybrid Search Endpoint (pgvector + FTS + RRF)
**Status:** NOT STARTED  

**New endpoint:** `GET /api/integrations/knowledge/search`  
**Query params:** `q` (text query), `embedding` (base64 vector — optional, computed server-side), `type` (optional filter), `limit` (default 10)  
**Auth:** Service token with `knowledge:read` scope (already exists)

**DB query pattern (add to `apps/api/modules/knowledge-items/routes.ts`):**
```sql
WITH vec AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
  FROM knowledge_items
  WHERE org_id = $2 AND embedding IS NOT NULL
  LIMIT 20
),
fts AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(search_vector, query) DESC) AS rank
  FROM knowledge_items,
       plainto_tsquery('english', $3) AS query
  WHERE org_id = $2 AND search_vector @@ query
  LIMIT 20
),
rrf AS (
  SELECT COALESCE(v.id, f.id) AS id,
    COALESCE(1.0/(60 + v.rank), 0) + COALESCE(1.0/(60 + f.rank), 0) AS score
  FROM vec v FULL OUTER JOIN fts f ON v.id = f.id
)
SELECT ki.id, ki.title, ki.content, ki.type, ki.metadata, r.score
FROM rrf r JOIN knowledge_items ki ON ki.id = r.id
ORDER BY r.score DESC LIMIT $4;
```

**Note:** Embedding generation for the query string must happen at the API layer (call OpenAI or local Ollama nomic-embed-text). The worker sends text → API generates embedding → runs hybrid query.

---

### P1.3 — RAG Retrieval Activity in Worker
**Status:** NOT STARTED  

**New file:** `services/automations-worker/src/activities/knowledge-rag.ts`

```typescript
// Retrieves top-k knowledge items matching the query using hybrid search.
// The API handles embedding generation — worker just sends text.
export async function retrieveKnowledgeContext(
  query: string,
  opts?: { type?: string; limit?: number }
): Promise<Array<{ id: string; title: string; content: string; type: string }>> {
  return cc.searchKnowledge(query, opts?.type, opts?.limit ?? 5);
}
```

**Update `services/automations-worker/src/cc-client.ts`:**
Add `cc.searchKnowledge(query: string, type?: string, limit?: number)` calling the new endpoint.

**Export** from `services/automations-worker/src/activities/index.ts`.

---

### P1.4 — Wire RAG into A2 (Job Hunt) + Automater
**Status:** NOT STARTED  

**A2 (jobs.ts workflow):**
- Before `ingestAdzunaJobs`: call `retrieveKnowledgeContext("user tech stack skills experience", { type: "profile" })`.
- Pass the retrieved profile as `userContext` arg to `ingestAdzunaJobs` activity.
- Inside `ingestAdzunaJobs`: inject `userContext` into the job scoring Ollama prompt.

**Automater (upgrader.ts workflow):**
- Before proposing improvements: call `retrieveKnowledgeContext("automation improvements tried", { type: "lesson" })`.
- Filter out suggestions that match already-tried lessons.

**Definition of Done (Phase 1):**
- [ ] /brain page exists and shows knowledge_items with search
- [ ] /vault page shows kb_commands (renamed from /knowledge)
- [ ] Hybrid search returns results in <200ms for typical queries
- [ ] A2 job scoring Ollama prompt includes user profile context
- [ ] Automater reads recent lesson items before proposing

---

## Phase 2 — ReAct Loop + Tool Calling + Multi-Agent (~4 weeks)

> **Prerequisite:** Phase 1 complete (RAG activity must exist for tool calls).

### P2.0 — Switch Embedder to Local Ollama nomic-embed-text (M3)
**Status:** NOT STARTED  
**Priority:** IMPORTANT (privacy + cost)  
**Problem:** `embedder.ts` sends all `knowledge_items` content (personal notes, lessons, financial briefs) to `api.openai.com/v1/embeddings`. Your BYOK key, but it's external data.

**Implementation:**
1. In Ollama, pull nomic-embed-text: `ollama pull nomic-embed-text` (768-dim vs OpenAI's 1536)
2. Modify `embedder.ts`:
   - Replace `openaiEmbed()` with `ollamaEmbed(text)` calling `http://localhost:11434/api/embed`
   - Model: `nomic-embed-text` (768-dim, local, free, no data leaves machine)
3. **DB migration:** If already have 1536-dim embeddings, need to reset column to `vector(768)` or keep both and migrate gradually.
   - Recommendation: add `EMBED_DIM=768` env var, add migration to `ALTER COLUMN embedding TYPE vector(768)`, drop old vectors, re-embed on next sweep.
4. Remove OpenAI credential requirement for embedder. Users without an OpenAI key will now still get embeddings.

**Privacy benefit:** Zero external data for personal knowledge items.
**Cost benefit:** Eliminates ~$0.003/day OpenAI embedding cost entirely.
**Effort:** ~1 day

**Important:** nomic-embed-text must be running in Ollama before worker starts. Add to `.env`: `EMBED_MODEL=nomic-embed-text`, `EMBED_DIM=768`.

---

### P2.0b — Temporal Workflow Versioning Strategy (M4)
**Status:** NOT STARTED  
**Problem:** If you change a running workflow (e.g., add a new activity), Temporal replays the history with the new code → non-determinism error → workflow fails.

**Implementation pattern (for Phase 2+ workflow changes):**
```typescript
// In any workflow being changed:
import { patched } from '@temporalio/workflow';

// Before change:
// const result = await oldActivity();

// After change (uses patching):
if (patched('add-rag-context-v1')) {
  const context = await retrieveKnowledgeContext(query);
  const result = await newActivity(context);
} else {
  const result = await oldActivity();
}
```

**Rule:** Use `patched()` for any workflow that may have running instances. Remove old patch branch after all instances complete (usually after 1 week).

### P2.1 — Generic ReAct Agent Activity
**Status:** NOT STARTED  

**My call:** YES — implement ReAct. It fits the Temporal architecture perfectly. The loop runs INSIDE a single activity (the whole loop is non-deterministic IO = activity). Temporal provides outer durability. Minimal effort: ~2 days for the reusable activity + tool registry.

**New file:** `services/automations-worker/src/activities/react-agent.ts`

**Pattern:**
```typescript
export async function reactAgentActivity(input: {
  goal: string;
  tools: ToolName[];
  initialContext?: string;
  maxIterations?: number;
}): Promise<{ result: string; toolCallLog: ToolCallRecord[] }> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.tools) },
    { role: 'user', content: input.goal },
  ];
  if (input.initialContext) {
    messages.push({ role: 'assistant', content: `Context: ${input.initialContext}` });
  }
  
  const log: ToolCallRecord[] = [];
  const maxIter = input.maxIterations ?? 6;
  
  for (let i = 0; i < maxIter; i++) {
    const response = await ollamaWithTools(messages, getToolDefinitions(input.tools));
    messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
    
    if (!response.tool_calls?.length) {
      return { result: response.content, toolCallLog: log };
    }
    
    for (const call of response.tool_calls) {
      const result = await executeTool(call.function.name, call.function.arguments);
      log.push({ tool: call.function.name, args: call.function.arguments, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  throw new Error(`ReAct loop exceeded ${maxIter} iterations`);
}
```

**Tool registry (5 tools for Phase 2):**

| Tool | What it does | Privacy |
|------|-------------|---------|
| `search_knowledge` | Hybrid search of knowledge_items | Local only |
| `get_profile` | Fetch profile-type knowledge items | Local only |
| `fetch_job_details` | Fetch job from CC jobs table | Local only |
| `web_search` | Search web (company name / public info only) | No PII sent |
| `write_knowledge` | Save note/lesson to knowledge_items | Local only |

---

### P2.2 — LLM Tool Calling via Ollama (ollamaWithTools)
**Status:** NOT STARTED  

Add `ollamaWithTools()` to `services/automations-worker/src/ollama.ts`:

```typescript
// Uses /api/chat (not /api/generate) — required for tool calling
export async function ollamaWithTools(
  messages: OllamaMessage[],
  tools: OllamaTool[]
): Promise<{ content: string; tool_calls?: OllamaToolCall[] }> {
  return _mutex.runExclusive(async () => {
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama tool call error: ${res.status}`);
    return (await res.json()).message;
  });
}
```

**Validated use cases (applies ReAct + tool calling):**
1. **A2 Job Hunt** — LLM decides: "search_knowledge" for profile → "fetch_job_details" → score
2. **Interview Prep** — LLM decides: "web_search" company → "get_profile" → "search_knowledge" past notes → draft questions
3. **Automater** — LLM decides: "web_search" improvements → "search_knowledge" tried things → "write_knowledge" findings

**NOT using tool calling for:** Email classification, expense extraction, budget reports, bill reminders — these are LLM-free or single-shot structured extraction. ReAct adds no value there.

---

### P2.3 — Multi-Agent Child Workflow Pattern
**Status:** NOT STARTED  

**Two practical fan-outs for Phase 2:**

**Fan-out A — Parallel Gmail accounts triage:**
```typescript
// In inboxTriageWorkflow (or a new coordinator):
const triageResults = await Promise.all(
  gmailAccounts.map(account =>
    wf.executeChild('inboxTriageWorkflow', {
      args: [{ userEmail: account.email, zone: account.zone, ...routeKeys }],
      taskQueue: TASK_QUEUE,
      parentClosePolicy: ParentClosePolicy.TERMINATE,
    })
  )
);
```

**Fan-out B — Parallel job processing (1 child per job):**
```typescript
// In jobsIngestWorkflow, after fetching new jobs:
const processedJobs = await Promise.all(
  newJobLeads.map(job =>
    wf.executeChild('processJobLeadWorkflow', {
      args: [{ jobId: job.id, userId: input.userId }],
      taskQueue: TASK_QUEUE,
    })
  )
);
// Each child: fetch full desc → RAG user profile → ReAct score → tailor → save
```

**NOT implementing:** Full CrewAI-style multi-agent teams (researcher + writer + reviewer agents). Too complex for current use cases. The above 2-level fan-out gives 80% of the benefit.

---

### P2.4 — Wire ReAct into Job Hunt + Interview Prep
**Status:** NOT STARTED  

**A2 (jobsIngestWorkflow):**
- Refactor `draftAndPostJobsDigest` → split into parallel `processJobLeadWorkflow` child workflows
- Each child calls `reactAgentActivity` with goal: "Score and personalise this job for the user"
- Tools used: `get_profile`, `fetch_job_details`, `search_knowledge`

**Interview Prep workflow:**
- Before drafting questions, call `reactAgentActivity` with goal: "Research this company and tailor interview prep"
- Tools used: `web_search` (company research), `get_profile`, `search_knowledge` (past interview notes)

**Definition of Done (Phase 2):**
- [ ] `reactAgentActivity` exists and runs 5 tools
- [ ] `ollamaWithTools()` works with llama3.2:3b tool_calls
- [ ] A2 uses child workflows for parallel job processing
- [ ] Interview Prep uses ReAct for company research
- [ ] Multiple Gmail accounts triaged in parallel via child workflows

---

## Phase 3 — Intelligence Layer (~3 weeks)

> **Prerequisite:** Phase 2 complete + automations running stably for 2+ weeks.

### P3.0 — Temporal Test Suite (M2)
**Status:** NOT STARTED  
**Problem:** Zero automated tests. Every workflow change risks silent regression.

**Implementation:** `@temporalio/testing` provides a `TestWorkflowEnvironment` for unit-testing workflows without a real Temporal server.

**Files to create:**
- `services/automations-worker/src/workflows/morning-brief.test.ts`
- `services/automations-worker/src/workflows/inbox-triage.test.ts`
- `services/automations-worker/src/workflows/jobs.test.ts`

**Test pattern:**
```typescript
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { morningBriefWorkflow } from './morning-brief.js';

test('morning-brief: skips weather when userId missing', async () => {
  const env = await TestWorkflowEnvironment.createLocal();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    activities: { /* mock activities */ fetchCalendarEvents: async () => [] },
    workflowsPath: require.resolve('./index.js'),
    taskQueue: 'test',
  });
  await worker.runUntil(async () => {
    const result = await env.client.workflow.execute(morningBriefWorkflow, {
      taskQueue: 'test',
      args: [{ userEmail: 'test@example.com', slackRouteKey: 'test' }],
      workflowId: 'test-brief-1',
    });
    expect(result).toBeUndefined(); // void return
  });
  await env.teardown();
});
```

**Coverage target (Phase 3):** morningBriefWorkflow, inboxTriageWorkflow, jobsIngestWorkflow — basic happy path + skip-on-missing-key cases.

---

### P3.0b — Per-Automation Enable/Disable Toggle (M7)
**Status:** NOT STARTED  
**Problem:** Disabling an automation in UI only prevents next scheduled run. Already-running workflows run to completion.

**Implementation:**
1. Add `enabled` column to `automations` or `automation_schedules` table (already may exist — verify).
2. Add enabled check at start of each workflow:
```typescript
// Add to all workflows that support mid-run kill:
const config = await fetchAutomationConfig(automationId);
if (!config.enabled) {
  await postNotification(routeKey, `[${automationId}] disabled — skipping this run`);
  return;
}
```
3. UI toggle in /health page triggers PATCH `/api/automations/:id/enabled`.
4. Temporal scheduled workflow: set Temporal Schedule to PAUSE state when disabled (prevents next scheduled trigger too).

---

### P3.0c — Automation Dry-Run Mode (M8)
**Status:** NOT STARTED  

**Implementation:**
- All workflow input interfaces add: `dryRun?: boolean`
- When `dryRun: true`:
  - No `postNotification()` calls → no Slack messages
  - No `cc.upsertJobLead()` or other write activities
  - Returns a preview JSON of what would have happened
- API route: `POST /api/triggers/:automationId/dry-run` → starts workflow with `{ dryRun: true }`

---

### P3.0d — DB Slow Query Audit (M6)
**Status:** NOT STARTED  

**One-time action:**
```sql
-- Enable pg_stat_statements (if not enabled)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- After 1 week of data, run:
SELECT query, calls, total_exec_time/calls AS avg_ms, rows
FROM pg_stat_statements
WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user)
ORDER BY avg_ms DESC
LIMIT 20;
```

**Common indexes likely missing (based on query patterns):**
```sql
-- knowledge_items: search by user + type
CREATE INDEX IF NOT EXISTS idx_ki_user_type ON knowledge_items (user_id, type);
-- expenses: time range queries per user
CREATE INDEX IF NOT EXISTS idx_exp_user_date ON expenses (user_id, occurred_on DESC);
-- automation_runs: recent runs per automation
CREATE INDEX IF NOT EXISTS idx_runs_auto_at ON automation_runs (automation_id, run_at DESC);
```

---

### P3.0e — Prometheus Metrics Export (M5)
**Status:** NOT STARTED  

**Implementation:**
```typescript
// services/automations-worker/src/metrics.ts — add to worker startup
import { register, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
collectDefaultMetrics(); // CPU, memory, event loop lag

export const activityRunsTotal = new Counter({
  name: 'cc_activity_runs_total',
  labelNames: ['activity', 'status'],
});
export const activityDurationMs = new Histogram({
  name: 'cc_activity_duration_ms',
  labelNames: ['activity'],
  buckets: [100, 500, 1000, 3000, 10000, 30000],
});
```

Expose `/metrics` on port 3005 in `callback-server.ts`. Scrape with Prometheus or read directly.

### P3.1 — Automation Health Dashboard
**Status:** NOT STARTED  

**New DB table (migration `0050_automation_runs.sql`):**
```sql
CREATE TABLE automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id) NOT NULL,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL CHECK(status IN ('success','failed','skipped')),
  summary JSONB,           -- {fetched:5, stored:3, skippedReason:'no_key'}
  duration_ms INT,
  workflow_id TEXT,        -- Temporal workflow ID for linking
  error_message TEXT,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_runs_user_at ON automation_runs (user_id, run_at DESC);
CREATE INDEX idx_runs_automation ON automation_runs (automation_id, run_at DESC);
```

**Pattern:** Activities call `cc.recordAutomationRun(automationId, status, summary)` at the end of happy and error paths. This writes to the table AND emits an SSE event `automation:run` for live UI refresh.

**New API route:** `GET /api/integrations/automation-runs?limit=50` (service token, `runs:read` scope)

**New UI page:** `apps/web/app/(app)/health/page.tsx`
- Shows all automations as cards: name, last run time, status badge, summary stats
- "View in Temporal" deep link for failures
- Live refresh via `useLiveEvents(['automation:run'])`

---

### P3.2 — Goal Tracking + Automation Alignment
**Status:** NOT STARTED  

**New DB tables:**
```sql
CREATE TABLE goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  category TEXT CHECK(category IN ('career','finance','health','learning','other')),
  target_date DATE,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','achieved','abandoned')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE goal_automations (
  goal_id UUID REFERENCES goals(id),
  automation_id TEXT NOT NULL,  -- e.g. 'A2', 'N5'
  PRIMARY KEY (goal_id, automation_id)
);
```

**Goal → automation mapping (hardcoded in Phase 3, configurable later):**
- `career` goal → A2 (jobs), interview-prep, resume-tailor
- `finance` goal → N5 (expense report), R10 (budget), R12 (net worth)
- `health` goal → R11 (habit bot), R8 (sleep), N11 (health tracker)

**On goal creation:** Auto-enable aligned automations + send Slack notification.

**Important constraint:** Track ONLY quantitative sub-goals (applications/week, savings/month). Avoid vague "% complete" for qualitative goals. For `career` goals, track: `applications_this_week` + `interviews_scheduled_this_week` from existing automation_runs data.

---

### P3.3 — Weekly Narrative Report (weeklyNarrativeWorkflow)
**Status:** NOT STARTED  

**New workflow:** `services/automations-worker/src/workflows/weekly-narrative.ts`  
**Cron:** `0 9 * * 0` (09:00 IST every Sunday)  
**Task queue:** `personal-automations` (existing)

**Activities to call (all local, no PII external):**
1. `fetchWeeklyExpenseSummary(userId, 'personal')` — Zone A total vs. budget
2. `fetchWeeklyJobStats(userId)` — applications + interviews this week
3. `fetchWeeklyLearningStats(userId)` — articles consumed
4. `fetchWeeklyHabitStats(userId)` — streak counts
5. `ollamaText(prompt)` — 2–3 sentence narrative synthesis (LOCAL ONLY — no PII out)

**Slack message format:**
```
*Your Week — Oct 21–27*
💰 Spent ₹8,420 (78% of ₹10,800 budget) · 3 subscriptions active
💼 Applied to 7 jobs · 2 interviews scheduled
📚 Read 4 articles · Completed 1 course module
🌱 Habits: 5/7 days streak
_Insight: Good job hunt week. Keep your budget buffer for the weekend._
```

---

### P3.4 — Simple Correlation Insights (SQL threshold checks)
**Status:** NOT STARTED  

**NOT a full correlation engine** — simple threshold-based SQL patterns added to morning brief and weekly narrative.

**Threshold checks to implement:**
```sql
-- Check: sleep low AND habit drop
SELECT
  CASE WHEN avg_sleep_hrs < 6.5 AND habit_completion_rate < 0.6
  THEN 'Your sleep average dropped below 6.5h this week. This often affects habit completion.'
  ELSE NULL END AS insight
FROM (
  SELECT AVG(sleep_hours) AS avg_sleep_hrs,
         AVG(completed::INT)::FLOAT AS habit_completion_rate
  FROM health_logs
  WHERE user_id = $1 AND logged_at > NOW() - INTERVAL '7 days'
) s;

-- Check: budget exceeded AND new subscriptions
SELECT
  CASE WHEN total_spent > budget_limit AND new_subs > 0
  THEN 'You exceeded your budget this week and added new subscriptions. Review recurring costs.'
  ELSE NULL END
FROM ...;
```

Add these insights as optional lines in the morning brief and weekly narrative. Never force them — only show when threshold fires.

**Definition of Done (Phase 3):**
- [ ] /health page shows all automation run statuses with live refresh
- [ ] Goals can be created in UI; aligned automations auto-activate
- [ ] Weekly Narrative fires Sunday 09:00 IST with correct data
- [ ] At least 2 threshold-based insights wired into morning brief

---

## Phase 4 — Voice + Future (Post-stable, after Phase 0–3 stable for 4+ weeks)

### P4.1 — Voice Input Layer
**Recommendation:** Start with Siri Shortcut (iOS) + Web Speech API (PWA). No new infrastructure needed.

**Siri Shortcut:**
1. Create Siri Shortcut on iPhone: "Speak to CC" → captures voice → text → POST to `http://localhost:3001/api/triggers/voice` with `{ command: "<text>", userId: "<uuid>" }`
2. Add `/api/triggers/voice` API route that parses the command text with Ollama locally → routes to appropriate workflow start
3. Works on local network only — no public internet exposure needed

**Web Speech API (PWA):**
1. Add `manifest.json` to Next.js web app to enable PWA installation
2. Add voice input button to CC header that uses `window.SpeechRecognition`
3. Captured text → submitted to `/api/triggers/voice` endpoint

### P4.2 — Full Knowledge Graph (deferred)
Add only when knowledge_items > 5,000 or multiple users. Requires entity extraction → `kg_entities` + `kg_relationships` tables → recursive CTE graph traversal.

### P4.3 — Statistical Correlation Analysis (deferred)
Add only when 6+ months of health + finance + habit data exists. Use Pearson/Spearman correlation, visualised in CC UI.

---

## Missing Items Tracker

| ID | Item | Phase | Status | Category |
|----|------|-------|--------|----------|
| M1 | CI/CD pipeline (GitHub Actions) | 4 | Pending | DevOps |
| M2 | Temporal test suite (A0, A5, A2) | 3 | **In Plan P3.0** | Quality |
| M3 | Switch embedder to local nomic-embed-text | 2 | **In Plan P2.0** | Cost/Privacy |
| M4 | Temporal workflow versioning (patching) | 2 | **In Plan P2.0b** | Architecture |
| M5 | Prometheus metrics export (port 3005) | 3 | **In Plan P3.0e** | Observability |
| M6 | DB slow query + index audit | 3 | **In Plan P3.0d** | Performance |
| M7 | Per-automation enable/disable toggle | 3 | **In Plan P3.0b** | UX |
| M8 | Automation dry-run mode | 3 | **In Plan P3.0c** | DX |
| M9 | Codec server for Temporal UI | 1 | **In Plan P1.0b** | DX |
| M10 | Worker /health endpoint | 1 | Pending | Ops |
| M11 | Per-API dedicated task queues | 1 | **In Plan P1.0c** | Reliability |
| M12 | OLLAMA_KEEP_ALIVE + num_predict cap | 0 | **In Plan P0.5** | Performance |
| DLQ | Dead letter queue for external API failures | 1 | **In Plan P1.0** | Reliability |

---

## Architecture Principles (Locked — Do Not Deviate)

1. **Temporal for all scheduled and long-running work.** Never use `setTimeout` or raw cron in the worker.
2. **Activities for all non-deterministic IO.** LLM calls, HTTP calls, DB writes — all in activities, not workflows.
3. **Workflows are thin orchestrators.** Call activities, handle results, emit events. No business logic.
4. **Local Ollama for all PII.** Email content, financial data, health data, contacts — NEVER sent to external LLMs.
5. **External LLM only for public data.** Company research, news summarisation, job description text (public).
6. **Idempotent ingest on (source, source_id).** All ingest activities must be safe to replay.
7. **RLS always.** Every API route that reads per-user data wraps in `withTenantTx`.
8. **BYOK with graceful skip.** If API key is missing → log `[aX.name] no_key, skipping` → return empty result, never crash.
9. **SSE event at happy path end.** Every automation activity emits `cc.emitEvent` for live UI refresh.
10. **Service token scopes.** Never use ALL_SCOPES permanently — mint minimal scope per new integration.

---

## Related Docs
- `docs/automations-research/DECISIONS_AND_ARCHITECTURE.md` — all decisions locked (Finance zones, NotificationChannel, LLM privacy policy)
- `docs/automations-research/NEW_AUTOMATIONS_PROPOSAL.md` — full automation catalog (N1–N15, R1–R15)
- `docs/automations-research/CURRENT_AUTOMATIONS.md` — A0–A9 current status
- `docs/cc-platform-handoff.md` — monorepo structure, patterns, recipe for new automations
