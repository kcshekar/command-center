# Current Automations — Deep-Dive Reference

> **Purpose:** Machine-readable reference for AI agents (Gemini, Claude, etc.) working on this codebase.
> Last scanned: 2026-10-25

---

## Architecture Overview

The automations system is built on **Temporal.io** — a durable workflow engine that survives crashes, retries, and long-running waits without losing state.

### Component Map

```
┌──────────────────────────────────────────────────────────────────┐
│  Temporal Cloud / Self-Hosted Temporal Server                    │
│  namespace: "personal"  |  task-queue: "personal-automations"    │
└────────────────┬────────────────────────────────────────────────-┘
                 │  schedules (cron)
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  services/automations-worker  (Node 22 + TypeScript)             │
│  ├── src/worker.ts             — Worker bootstrap + callback srv  │
│  ├── src/workflows/*.ts        — Durable Temporal workflow fns    │
│  ├── src/activities/           — Side-effectful activity fns      │
│  ├── src/ollama.ts             — Local Ollama LLM client          │
│  ├── src/cc-client.ts          — Command Center REST API client   │
│  ├── src/google-oauth.ts       — Gmail/Calendar/Tasks OAuth       │
│  ├── src/keepa.ts              — Amazon price API client          │
│  └── src/parsers/              — Deterministic email parsers      │
└────────────────┬─────────────────────────────────────────────────┘
                 │  cc-client (Bearer token / service identity)
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│  apps/api  (Bun + TypeScript HTTP server)                        │
│  └── modules/automations/routes.ts                               │
│      GET  /api/automations/catalog         — UI toggle panel     │
│      PATCH /api/automations/catalog/:id/grant — enable/disable   │
│      GET  /api/automations/schedules       — live Temporal state  │
│      POST /api/automations/schedules/:id/pause                   │
│      POST /api/automations/schedules/:id/unpause                 │
│      POST /api/automations/schedules/:id/trigger                 │
└──────────────────────────────────────────────────────────────────┘
```

### Key Technical Patterns

1. **Temporal Update handlers** — Workflows expose named Updates (e.g., `submitApproval`, `submitReplyApproval`) that let Slack button callbacks signal a waiting workflow.
2. **Parent-close ABANDON children** — `inboxTriageWorkflow` spawns `mailReplyWorkflow` with `PARENT_CLOSE_POLICY_ABANDON` so triage completes immediately and the reply has its own 24h window.
3. **Idempotency via (source, externalId)** — All CC writes use a `(source, externalId)` pair so replaying a workflow never double-creates records.
4. **Deterministic parsers first, Ollama fallback** — `parseExpenseEmail` runs bank-specific regex parsers; only if none match does it call the local Ollama LLM.
5. **SKIP overlap policy** — All Temporal schedules use `ScheduleOverlapPolicy.SKIP` so slow LLM runs don't stack up.
6. **Dual-zone security** — All CC writes use the Application Role + `withTenantTx` RLS context. The worker authenticates via a service token with explicit scopes.

---

## Existing Automations — Complete Catalog

### A0 — Morning Brief
- **Workflow:** `morningBriefWorkflow`
- **Schedule:** `morning-brief-daily` — Daily at 07:30 IST (`30 7 * * *`)
- **Activities:** `fetchCalendarEvents`, `fetchGoogleTasks`, `fetchCCDueReminders`, `postNotification`
- **Output:** Slack digest (calendar events next 24h + open tasks + reminders due in 7 days)
- **Input:** `{ userEmail, slackRouteKey }`
- **Retry:** 3 attempts, 1m timeout per activity

### A0b — Evening Wrap-Up
- **Workflow:** `eveningWrapWorkflow`
- **Schedule:** `evening-wrap-daily` — Daily at 20:00 IST (`0 20 * * *`)
- **Activities:** `fetchCompletedTasksToday`, `rolloverOverdueTasks`, `postNotification`
- **Output:** Slack digest (completed tasks today + rolled-over overdue tasks → tomorrow)
- **Fault tolerance:** Uses `Promise.allSettled` — partial Google API failures still post partial digest
- **Input:** `{ userEmail, slackRouteKey }`

### A1 — Tech News Ingest & LinkedIn Draft
- **Workflow:** `newsIngestWorkflow`
- **Schedule:** `a1-news-mon-thu` — Mon & Thu at 09:00 IST (`0 9 * * 1,4`)
- **Activities:** `ingestHnTopStories`, `draftAndPostNewsBrief`
- **Source:** Hacker News Top Stories API
- **LLM use:** Classifies each story by importance, drafts a LinkedIn-ready post from top stories
- **Storage:** Creates `knowledge_items` via CC API (idempotent on `sourceId`)
- **Output:** Slack post with briefId for review
- **Input:** `{ userId, limit: 15, classify: true, draft: true, minImportance: 4, routeKey }`

### A2 — Job Feed Ingest & Digest
- **Workflow:** `jobsIngestWorkflow`
- **Schedule:** `a2-jobs-daily` — Daily at 09:00 & 18:00 IST (`0 9,18 * * *`)
- **Activities:** `ingestAdzunaJobs`, `draftAndPostJobsDigest`
- **Source:** Adzuna Jobs API (user's own API key fetched from CC credentials)
- **LLM use:** Scores each job lead against user profile (skills, keywords, anti-keywords, salary prefs)
- **Storage:** Upserts `job_leads` via CC (idempotent on `sourceId`)
- **Output:** Slack digest with top leads (minScore: 4 by default)
- **Input:** `{ userId, resultsPerPage: 25, classify: true, draft: true, minScore: 4, routeKey }`

### A3 — Interview Prep (On-Demand)
- **Workflow:** `interviewPrepWorkflow`
- **Trigger:** User-triggered from Jobs UI ("Prep" button)
- **Activity:** `researchJobLeadForInterview`
- **LLM use:** Researches company + role, creates structured prep notes
- **Storage:** Creates interview_session + knowledge_item in CC
- **Output:** Returns `{ sessionId, briefId }` for UI navigation
- **Input:** `{ userId, jobLeadId }`

### A3b — Resume Tailor (On-Demand)
- **Workflow:** `resumeTailorWorkflow`
- **Trigger:** User-triggered from Jobs UI ("Tailor Resume" button)
- **Activity:** `tailorResumeForJobLead`
- **LLM use:** Tailors resume + drafts cover letter for specific job, optionally creates Gmail draft
- **Storage:** Creates 2 knowledge_items (resume + cover letter)
- **Output:** `{ resumeKnowledgeItemId, coverLetterKnowledgeItemId, gmailDraftId? }`
- **Input:** `{ userId, userEmail?, jobLeadId }`

### A4 — Google Calendar Interview Sync
- **Workflow:** `calendarInterviewSyncWorkflow`
- **Schedule:** `a4-calendar-sync-hourly` — Every hour (`0 * * * *`)
- **Activity:** `syncGoogleCalendarInterviews`
- **Logic:** Scans Google Calendar for events in next 30 days, fuzzy-matches event titles to existing `interview_sessions` by company name, upserts interview rounds idempotently via `calendarEventId`
- **Input:** `{ userId, userEmail, daysAhead: 30 }`

### A4b — Interview Reminders
- **Workflow:** `interviewRemindersWorkflow`
- **Schedule:** `a4-interview-reminders-15m` — Every 15 min (`*/15 * * * *`)
- **Activity:** `remindUpcomingInterviewRounds`
- **Logic:** Finds rounds due in next 24h, Slacks reminder if not notified in last 24h
- **Input:** `{ withinHours: 24, renotifyHours: 24, routeKey }`

### A5 — Inbox Triage (Flagship)
- **Workflow:** `inboxTriageWorkflow`
- **Schedule:** `inbox-triage-every-15m` — Every 15 min (`*/15 * * * *`)
- **Activities:** `fetchGmailHistory`, `classifyEmailOllama`, `trashGmailMessages`, `ingestExpenseFromEmail`, `ingestBillReminder`, `ingestJobEmailLead`, `ingestInterviewSchedulingEmail`, `logReplyNeeded`
- **LLM use:** Ollama (llama3.2:3b) classifies each email into one of 8 categories:
  - `promotional` → candidate for trash
  - `spam` → candidate for trash
  - `transactional_bank` → auto-ingest as expense
  - `actionable_bill` → auto-ingest as reminder
  - `job_posting` → ingest to job_leads (A2 chain)
  - `interview_scheduling` → ingest interview session + round (A4 chain)
  - `needs_reply` → spawn child `mailReplyWorkflow` (A5b)
  - `personal_important` → no action, digest only
- **Approval flow:** Posts Slack Block Kit card with Approve/Reject buttons for trash candidates. Waits up to 24h for Temporal Update via callback server.
- **Gmail cursor:** Uses `gmail_history_cursors` table to poll only new messages since last run
- **Input:** `{ userEmail, digestRouteKey, approvalRouteKey, userId }`

### A5b — Mail Reply (Child of A5)
- **Workflow:** `mailReplyWorkflow`
- **Trigger:** Spawned by `inboxTriageWorkflow` when email classified as `needs_reply`
- **Activities:** `fetchGmailMessageFull`, `draftReplyToEmail`, `sendGmailReply`, `postApprovalNotification`, `updateApprovalNotification`
- **LLM use:** Drafts a professional reply from the full email body
- **Approval flow:** Slack approval card with Send/Discard buttons. Waits 24h.
- **On approval:** Sends via Gmail API using the OAuth token

### A6 — Price Watch
- **Workflows:** `priceWatchInitialFetchWorkflow` (one-shot) + `priceWatchDailyPollWorkflow`
- **Schedule:** `price-watch-daily-poll` — Daily at 07:00 IST (before morning brief)
- **Activity:** `fetchInitialPriceSnapshot`, `listDuePriceWatches`
- **Source:** Keepa API (Amazon price tracking)
- **Logic:** Daily sweep fetches all unpaused watches not checked in 20h, sequential fan-out
- **Output:** Price snapshots written to CC; verdict transitions (drop/rise) Slacked

### A7 — Profile Refresh
- **Workflow:** `profileRefreshWorkflow`
- **Schedule:** `a7-profile-monthly` — 1st of month at 10:00 IST (`0 10 1 * *`)
- **Activity:** `refreshProfileDrafts`
- **LLM use:** Pulls recent knowledge_items + user profile, drafts updated LinkedIn bio / README / resume summary
- **Input:** `{ userId, recentDays: 30, routeKey }`

### A8 — Learning Digest
- **Workflow:** `learningIngestWorkflow`
- **Schedule:** `a8-learning-weekly` — Every Monday at 08:00 IST (`0 8 * * 1`)
- **Activities:** `ingestLearningReleases`, `draftAndPostLearningDigest`
- **Sources:** GitHub releases, dev.to tags, RSS feeds (from user's `learning_goals` table)
- **LLM use:** Classifies each lesson by relevance/importance, drafts a weekly digest
- **Input:** `{ userId, daysBack: 7, perRepo: 5, classify: true, draft: true, routeKey }`

### A10 — TTD (Tirupati Darshan) Prep
- **Workflow:** `ttdPrepWorkflow`
- **Schedule:** `ttd-prep-every-6h` — Every 6 hours (`0 */6 * * *`)
- **Activity:** `prepareTtdReminders`
- **Logic:** Fetches due TTD booking windows, resolves pilgrim identities, posts structured Slack notification with pilgrim PII pack (name, ID, DOB)
- **Input:** `{ withinHours: 48, renotifyHours: 24 }`

### A11 — Dependency Upgrade Scanner
- **Workflow:** `platformUpgradeScanWorkflow`
- **Schedule:** `a11-upgrader-monthly` — 1st of month at 11:00 IST (`0 11 1 * *`)
- **Activity:** `scanRepoDepUpgrades`
- **Logic:** Walks all `package.json` files in monorepo, checks npm registry for newer versions, categorizes as major/minor/patch, Slacks summary
- **Input:** `{ routeKey?, rootDir? }`
- **Note:** Review-only. Never auto-upgrades.

---

## Integration Points

| Integration | Auth Method | Used By |
|---|---|---|
| Google Gmail | OAuth2 tokens stored in `automations` DB | A5, A5b |
| Google Calendar | OAuth2 tokens | A4, A0 |
| Google Tasks | OAuth2 tokens | A0, A0b |
| Slack (via CC) | CC service token → `slack:send` scope | All |
| Ollama (local LLM) | `OLLAMA_HOST` env var | A1, A2, A5, A5b |
| Keepa API | BYOK stored in CC credentials | A6 |
| Adzuna API | BYOK stored in CC credentials | A2 |
| Command Center API | Short-lived service tokens (worker identity) | All |
| Temporal | `TEMPORAL_ADDRESS` env var | All |

---

## Critical Engineering Constraints for New Automations

1. **All activities must be idempotent** — Temporal may retry activities on failure.
2. **Workflow code must be deterministic** — No `Math.random()`, `Date.now()`, `fetch()`, or `console.log()` inside workflow functions. All side effects go in activities.
3. **LLM calls go in activities, never in workflows** — Ollama calls are non-deterministic; keep them inside activities.
4. **Use `wf.condition()` for waits** — Never use `setTimeout` or `sleep` in workflows; use Temporal's `condition()` for event-driven waits.
5. **Always check for `WorkflowExecutionAlreadyStartedError`** — When spawning child workflows, treat already-started as idempotent success.
6. **Register Update handlers before I/O** — To avoid race conditions with fast-arriving Slack button clicks.
7. **Service token scopes** — Add explicit scopes to `ALL_SCOPES` in `cc-client.ts` when adding new CC API calls.
