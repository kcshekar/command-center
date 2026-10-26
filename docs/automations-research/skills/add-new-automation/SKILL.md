---
name: add-new-automation
description: >
  Step-by-step guide for adding a new Temporal automation workflow to the
  Command Center automations-worker. Use this skill whenever creating a new
  workflow, activity, or schedule in services/automations-worker/.

---

# Skill: Add New Automation

## Overview

This codebase uses **Temporal.io** for durable workflow orchestration. All
automations follow a strict separation between Workflows (deterministic, no
side effects) and Activities (all I/O, LLM calls, API calls).

**Runtime:** Node 22 + TypeScript (pnpm, tsx)
**LLM:** Local Ollama (`src/ollama.ts`) — `ollamaJson()` for structured output, `ollamaText()` for prose
**API bridge:** `src/cc-client.ts` — authenticated fetch wrapper to Command Center REST API
**Slack:** All notifications go through `cc.notify()` or `cc.notifyApproval()` — never call Slack directly

---

## When to Use

- Adding a new scheduled automation
- Adding an on-demand workflow triggered from the CC UI
- Extending an existing automation with new steps

---

## Core Process

### Step 1: Define the Activity

Create or extend `src/activities/<name>.ts`:

```typescript
// src/activities/my-feature.ts
import { cc } from "../cc-client.js";
import { ollamaText } from "../ollama.js";

export async function myFeatureActivity(input: { userId: string; param: string }): Promise<{ result: string }> {
  // ALL side effects here: API calls, DB reads, LLM calls, filesystem I/O
  const data = await someExternalApi(input.param);
  const summary = await ollamaText(`Summarize: ${data}`);
  await cc.notify("automations.digest", summary);
  return { result: summary };
}
```

**Rules:**
- Activities MUST be idempotent — Temporal may retry them on failure
- Keep each activity focused on one logical unit of work
- Use `cc.getUserCredential(userId, service)` for BYOK API keys (Keepa, Adzuna pattern)
- Add the export to `src/activities/index.ts`

### Step 2: Define the Workflow

Create `src/workflows/<name>.ts`:

```typescript
// src/workflows/my-feature.ts
import * as wf from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { myFeatureActivity } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3, initialInterval: "10s" },
});

export interface MyFeatureInput {
  userId: string;
  routeKey?: string;
}

export async function myFeatureWorkflow(input: MyFeatureInput): Promise<{ result: string }> {
  // ONLY deterministic orchestration logic here. No API calls, no Math.random(), no Date.now()
  return myFeatureActivity({ userId: input.userId, param: "value" });
}
```

**Rules:**
- Workflow functions MUST be deterministic — same inputs always produce same sequence of calls
- NO `fetch()`, `Date.now()`, `Math.random()`, `console.log()` in workflow code
- For human-in-the-loop: use `wf.defineUpdate()` + `wf.setHandler()` + `wf.condition()` (see inbox-triage.ts for the full pattern)
- Register Update handlers BEFORE any `await` activity calls (race condition prevention)

### Step 3: Export from Workflow Index

```typescript
// src/workflows/index.ts — add your export:
export { myFeatureWorkflow } from "./my-feature.js";
```

```typescript
// src/activities/index.ts — add your export:
export { myFeatureActivity } from "./my-feature.js";
```

### Step 4: Register a Schedule (if cron-triggered)

Add to `src/scripts/init-schedules.ts`:

```typescript
await upsertSchedule(client, {
  scheduleId: "my-feature-daily",
  cron: "0 10 * * *",           // 10:00 every day in scheduleTimezone
  workflowType: "myFeatureWorkflow",
  args: [{ userId: newsUserId, routeKey: digest }],
  taskQueue,
  policies: commonPolicies,     // SKIP overlap + 1h catchup window
  timezone: scheduleTimezone,   // Always use this var (IST by default)
});
```

Run `pnpm schedules:init -- user@gmail.com` to apply.

### Step 5: Add to automation_catalog (if UI-toggle needed)

```sql
-- Add a migration in services/automations-worker/migrations/
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, default_enabled)
VALUES (
  'my-feature',
  'My Feature',
  'Does the thing every day',
  ARRAY['slack:send'],
  '0 10 * * *',
  false
);
```

### Step 6: Add CC scopes if needed

In `src/cc-client.ts`, add to `ALL_SCOPES` array and add the helper method to the `cc` object.

---

## Examples

### Minimal scheduled digest workflow (reference: morning-brief.ts)
```typescript
export async function morningBriefWorkflow(input: { userEmail: string; slackRouteKey: string }): Promise<void> {
  const [events, tasks] = await Promise.all([
    fetchCalendarEvents(input.userEmail, 24),
    fetchGoogleTasks(input.userEmail),
  ]);
  const lines = ["*Morning brief*", ...events.map(e => `• ${e.summary}`)];
  await postNotification(input.slackRouteKey, lines.join("\n"));
}
```

### Human-in-the-loop approval pattern (reference: inbox-triage.ts)
```typescript
const submitApproval = wf.defineUpdate<{ success: boolean }, [ApprovalPayload]>("submitApproval");

export async function approvalWorkflow(input: Input): Promise<void> {
  // 1. Register handler BEFORE any await
  let state: "pending" | "approved" | "rejected" = "pending";
  wf.setHandler(submitApproval, (p) => { state = p.decision; return { success: true }; }, {
    validator: (_p) => { if (state !== "pending") throw new Error(`already ${state}`); }
  });

  // 2. Do work...
  const refs = await postApprovalNotification(routeKey, "Approve?", blocks, wf.workflowInfo().workflowId, actionId);

  // 3. Wait up to 24h for button click
  const decided = await wf.condition(() => state !== "pending", "24 hours");

  // 4. Act on decision
  if (!decided || state === "rejected") { /* handle */ return; }
  await doTheApprovedThing();
}
```

---

## Common Rationalizations

| Agent Excuse | Correct Engineering Rebuttal |
|---|---|
| "I'll put the API call directly in the workflow" | API calls are non-deterministic. Temporal replays workflows — calling fetch() will break replay. Always put I/O in activities. |
| "I'll use Math.random() for a unique ID in the workflow" | Non-deterministic. Use `wf.workflowInfo().workflowId` or generate IDs in an activity. |
| "I'll register the Update handler after the first await" | Race condition: a Slack button click can arrive before you register the handler. Always register before any await. |
| "I'll skip the SKIP overlap policy — just this once" | A slow Ollama run will cause stacked cron triggers. Always use `ScheduleOverlapPolicy.SKIP`. |

---

## Red Flags

- `fetch()` or any HTTP call inside a `workflow/*.ts` file (not inside `proxyActivities`)
- `new Date()` or `Date.now()` inside a workflow function
- Missing `workflowsPath` in `Worker.create()` when adding workflows
- Forgetting to export from `src/workflows/index.ts` (worker won't find the workflow type)
- Using `console.log()` inside workflows (use `wf.log.info()` instead)

---

## Verification Checklist

- [ ] Activity is exported from `src/activities/index.ts`
- [ ] Workflow is exported from `src/workflows/index.ts`
- [ ] Workflow function is deterministic (no I/O, no random, no Date.now)
- [ ] Activities are idempotent
- [ ] Schedule added to `init-schedules.ts` and tested with `pnpm schedules:init`
- [ ] New CC API calls have scopes in `ALL_SCOPES`
- [ ] `pnpm typecheck` passes
- [ ] Worker restarts cleanly: `pnpm worker`
