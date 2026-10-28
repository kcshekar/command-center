import { getToken, ccBaseUrl, evictTokenCache, evictIdentityCache } from "./cc-token-store.js";

// Thin fetch wrapper around Command Center's /api/integrations/* endpoints.
// Auth: short-lived service tokens minted by cc-token-store from the
// worker's worker_identity row (install script seeds it, UI rotates it).
// Falls back to CC_SERVICE_TOKEN env var when the identity row is missing
// (zero-downtime migration path).
//
// For now every call uses the ALL_SCOPES set — once we add scope-split per
// activity we'll thread a scopes array through each helper.

const ALL_SCOPES = [
  "slack:send",
  "reminders:read",
  "reminders:write",
  "expenses:write",
  "expenses:read",
  "occasions:read",
  "life:read",
  "travel:write",
  "invoices:write",
  "prices:write",
  "prices:read",
  "credentials:read",
  "pilgrim:read",
  "ttd:read",
  "knowledge:read",
  "knowledge:write",
  "prompts:read",
  "learning:read",
  "profile:read",
  "jobs:read",
  "jobs:write",
  "interviews:read",
  "interviews:write",
  "events:write",
  "failures:write",
] as const;

async function call<T = unknown>(path: string, init?: RequestInit, retryOn401 = true): Promise<T> {
  const base = await ccBaseUrl();
  const token = await getToken([...ALL_SCOPES]);
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 && retryOn401) {
    // Token or identity may be stale — flush both caches and retry once.
    evictTokenCache();
    evictIdentityCache();
    return call<T>(path, init, false);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CC ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface DueReminder {
  id: string;
  title: string;
  category: string;
  due_on: string;
  recurrence: string | null;
  notified_at: string | null;
}

export interface PostedRef {
  channel: string;
  ts: string;
}

export const cc = {
  notify: (routeKey: string, text: string) =>
    call("/api/integrations/notify", { method: "POST", body: JSON.stringify({ routeKey, text }) }),

  notifyApproval: async (routeKey: string, text: string, blocks: unknown[], workflowId: string, actionId: string): Promise<PostedRef[]> => {
    const res = await call<{ refs: PostedRef[] }>("/api/integrations/notify-approval", {
      method: "POST",
      body: JSON.stringify({ routeKey, text, blocks, workflowId, actionId }),
    });
    return res.refs;
  },

  updateNotification: (routeKey: string, refs: PostedRef[], text: string, blocks?: unknown[], approvalState?: "approved" | "rejected" | "expired") =>
    call("/api/integrations/notify-update", {
      method: "POST",
      body: JSON.stringify({ routeKey, refs, text, blocks, approvalState }),
    }),

  dueReminders: (days = 7, userId?: string) =>
    call<DueReminder[]>(`/api/integrations/reminders/due?days=${days}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`),

  upsertExternalAccount: (params: {
    service: string;
    userId: string;
    label?: string;
    scopes: string[];
    status?: string;
    lastRefreshedAt?: string;
    metadata?: Record<string, unknown>;
  }) =>
    call("/api/integrations/external-accounts", { method: "POST", body: JSON.stringify(params) }),

  createExpense: (params: {
    accountName?: string;
    amountCents: number | string;
    currency?: string;
    category: string;
    occurredOn: string;
    note?: string;
    source: string;
    externalId: string;
    userId?: string;                          // owner; CC defaults to the token's user
    zone?: "personal" | "professional";      // CC defaults to personal
  }) => call<{ id: string; amountCents: string }>("/api/integrations/expenses", { method: "POST", body: JSON.stringify(params) }),

  createReminder: (params: {
    title: string;
    category: string;
    dueOn: string;
    recurrence?: string;
    source: string;
    externalId: string;
    resourceType?: string;
    resourceId?: string;
    userId?: string;                          // owner; CC defaults to the token's user
  }) => call<{ id: string; title: string; dueOn: string }>("/api/integrations/reminders", { method: "POST", body: JSON.stringify(params) }),

  // A6 Price Watcher — worker reads back the user's own BYOK key (CC owns the
  // DEK; the key crosses the wire once per call, over the already-authenticated
  // service-token channel). Returns null if the user has no key for that
  // service; the activity treats that as a soft-skip. `metadata` carries
  // non-secret context (e.g. Adzuna app_id).
  getUserCredential: (userId: string, service: string) =>
    call<{ label: string; key: string; metadata: Record<string, unknown> } | null>(
      `/api/integrations/user-credentials/${encodeURIComponent(userId)}/${encodeURIComponent(service)}`
    ).catch((err) => {
      if (err instanceof Error && / 404/.test(err.message)) return null;
      throw err;
    }),

  // Worker reports a snapshot (one price history row + mirror of latest on
  // the parent). CC owns the write to be RLS-safe and to compute verdict.
  // userId is the owning user — CC re-enters the tenant tx with it so RLS
  // can enforce normally. The token's `prices:write` scope is the gate.
  postPriceSnapshot: (watchId: string, body: {
    userId: string;
    price: number;
    currency?: string;
    title?: string | null;
    imageUrl?: string | null;
    sourceMeta?: Record<string, unknown>;
  }) => call(`/api/integrations/price-watches/${encodeURIComponent(watchId)}/snapshot`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // A6 Phase 2.6 — list of watches due for the daily poll (every user in the
  // service token's org that isn't paused and hasn't been checked recently).
  dueWatches: (minHoursSince = 20) =>
    call<Array<{ watchId: string; userId: string; source: string; externalId: string | null; url: string }>>(
      `/api/integrations/price-watches/due?minHours=${minHoursSince}`
    ),

  // A10.3 — TTD prep. Three sibling calls: imminent windows, pilgrim pack
  // for a user, bulk notified-mark.
  dueTtdWindows: (withinHours = 48, renotifyHours = 24) =>
    call<Array<{
      windowId: string; userId: string; darshanDate: string; slotType: string;
      releaseAt: string; pilgrimIds: string[]; note: string | null;
      bookingRef: string | null; lastNotifiedAt: string | null;
    }>>(`/api/integrations/ttd-windows/due?withinHours=${withinHours}&renotifyHours=${renotifyHours}`),

  pilgrimsForUser: (userId: string, ids?: string[]) => {
    const q = new URLSearchParams({ userId });
    if (ids && ids.length) q.set("ids", ids.join(","));
    return call<Array<{
      id: string; fullName: string; gender: string | null; idType: string | null;
      relationship: string; note: string | null; metadata: Record<string, unknown>;
      pii: { dob?: string; idNumber?: string; phone?: string; email?: string; address?: string };
    }>>(`/api/integrations/pilgrim-identities?${q.toString()}`);
  },

  markTtdWindowsNotified: (ids: string[]) =>
    call<{ updated: number }>(`/api/integrations/ttd-windows/notified`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  // A1.1 — knowledge_items create/list. Idempotent via (user_id, source,
  // sourceId): CC returns 200 with the existing row on collision, 201 for
  // a fresh insert. Worker treats both as success.
  createKnowledgeItem: (body: {
    userId: string;
    type?: string;
    title: string;
    body?: string;
    tags?: string[];
    source?: string;
    sourceId?: string | null;
    metadata?: Record<string, unknown>;
  }) => call<{
    id: string; type: string; title: string; source: string;
    sourceId: string | null; createdAt: string;
  }>(`/api/integrations/knowledge-items`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listKnowledgeItems: (params: { userId: string; source?: string; type?: string; limit?: number }) => {
    const q = new URLSearchParams({ userId: params.userId });
    if (params.source) q.set("source", params.source);
    if (params.type)   q.set("type", params.type);
    if (params.limit)  q.set("limit", String(params.limit));
    return call<Array<{
      id: string; type: string; title: string; source: string;
      sourceId: string | null; metadata: Record<string, unknown>; createdAt: string;
    }>>(`/api/integrations/knowledge-items?${q.toString()}`);
  },

  getKnowledgeItemFull: (id: string, userId: string) =>
    call<{
      id: string; type: string; title: string; body: string | null;
      tags: string[]; source: string; sourceId: string | null;
      metadata: Record<string, unknown>;
      createdAt: string; updatedAt: string;
    }>(`/api/integrations/knowledge-items/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`),

  listUnembeddedKnowledgeItems: (limit = 10) =>
    call<Array<{ id: string; userId: string; title: string; body: string | null; type: string }>>(
      `/api/integrations/knowledge-items/unembedded?limit=${limit}`
    ),

  patchKnowledgeItemEmbedding: (id: string, body: { userId: string; embedding: number[] }) =>
    call(`/api/integrations/knowledge-items/${encodeURIComponent(id)}/embedding`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  patchKnowledgeItemMetadata: (id: string, body: {
    userId: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }) => call(`/api/integrations/knowledge-items/${encodeURIComponent(id)}/metadata`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }),

  // A1.2 — effective prompt (user override merged over org default). Returns
  // null on 404 so the activity can fall back to a hardcoded prompt baked
  // into the worker without failing the whole run.
  // A2.2 — profile + job_lead integration helpers.
  getUserProfile: (userId: string) =>
    call<null | {
      headline: string | null; yearsExp: number | null; location: string | null;
      remotePref: string; minSalaryLpa: number | null; currency: string;
      skills: string[]; keywords: string[]; antiKeywords: string[];
      bio: string | null; metadata: Record<string, unknown>;
    }>(`/api/integrations/user-profile?userId=${encodeURIComponent(userId)}`),

  // N5 — one day's spending by category (zone is required by CC).
  dailyExpenses: (userId: string, zone: "personal" | "professional", date: string) =>
    call<{ date: string; zone: "personal" | "professional"; categories: import("./activities/spend-report.js").DayCategory[] }>(
      `/api/integrations/expenses/daily?userId=${encodeURIComponent(userId)}&zone=${zone}&date=${date}`
    ),

  // N12 — CA invoice batches: prepare (no email) and send (after approval).
  prepareCaBatches: (userId: string, periodMonth: string) =>
    call<import("./ca-card.js").PreparedBatch[]>(`/api/integrations/ca-batches/prepare`, {
      method: "POST", body: JSON.stringify({ userId, periodMonth }),
    }),
  sendCaBatch: (userId: string, batchId: string) =>
    call(`/api/integrations/ca-batches/${encodeURIComponent(batchId)}/send`, { method: "POST", body: JSON.stringify({ userId }) }),

  // R14 — travel bookings.
  upsertTravelBooking: (body: {
    userId: string; sourceMessageId: string; kind: string; provider: string | null; reference: string | null;
    from: string | null; to: string | null; departAt: string; endAt: string | null;
  }) => call<{ id: string }>(`/api/integrations/travel`, { method: "POST", body: JSON.stringify(body) }),
  departingTrips: (userId: string, from: string, to: string) =>
    call<import("./activities/travel.js").TripBooking[]>(
      `/api/integrations/travel/departing?userId=${encodeURIComponent(userId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    ),

  // P1.0 — dead-letter an external API failure (upsert on the open row).
  recordFailedItem: (body: {
    userId: string; automationId: string; itemType: string; sourceId?: string;
    payload: unknown; errorCode?: string; errorMessage?: string; retryAfter?: string;
  }) => call<{ id: string; attempts: number }>(`/api/integrations/failed-items`, { method: "POST", body: JSON.stringify(body) }),

  // N13 / P1.3 — keyword search over the user's knowledge items (websearch syntax).
  searchKnowledgeItems: (userId: string | undefined, q: string, limit = 3, type?: string) =>
    call<Array<{ id: string; type: string; title: string; source: string; body: string | null; createdOn: string }>>(
      `/api/integrations/knowledge-items/search?q=${encodeURIComponent(q)}&limit=${limit}${userId ? `&userId=${encodeURIComponent(userId)}` : ""}${type ? `&type=${encodeURIComponent(type)}` : ""}`
    ),

  // R11 / R7 / R9 — life trackers.
  lifeHabits: (userId: string) =>
    call<import("./activities/life-reports.js").HabitDays[]>(`/api/integrations/life/habits?userId=${encodeURIComponent(userId)}`),
  lifeGroceries: (userId: string) =>
    call<Array<{ name: string }>>(`/api/integrations/life/groceries?userId=${encodeURIComponent(userId)}`),
  lifeVehicles: (userId: string) =>
    call<import("./activities/life-reports.js").Vehicle[]>(`/api/integrations/life/vehicles?userId=${encodeURIComponent(userId)}`),

  // R3 — the user's birthdays / anniversaries.
  occasions: (userId: string) =>
    call<import("./activities/occasions.js").Occasion[]>(`/api/integrations/occasions?userId=${encodeURIComponent(userId)}`),

  // N9 / R13 / R10 — money reads for one user (zone required where it applies).
  financeBills: (userId: string, zone: "personal" | "professional") =>
    call<import("./activities/money-reports.js").Bill[]>(
      `/api/integrations/finance/bills?userId=${encodeURIComponent(userId)}&zone=${zone}`
    ),
  financeBalances: (userId: string, zone: "personal" | "professional") =>
    call<import("./activities/money-reports.js").Balance[]>(
      `/api/integrations/finance/balances?userId=${encodeURIComponent(userId)}&zone=${zone}`
    ),
  netWorthSnapshot: (userId: string, on: string) =>
    call<{ snapshot: import("./activities/money-reports.js").NetWorthSnapshot | null; previous: import("./activities/money-reports.js").NetWorthSnapshot | null }>(
      `/api/integrations/finance/net-worth-snapshot`, { method: "POST", body: JSON.stringify({ userId, on }) }
    ),
  financeBudgets: (userId: string, date: string) =>
    call<{ date: string; budgets: import("./activities/money-reports.js").BudgetStatus[] }>(
      `/api/integrations/finance/budgets?userId=${encodeURIComponent(userId)}&date=${date}`
    ),

  // SSE push — emit a user-scoped event the UI can react to. Best-effort:
  // call sites should not await / propagate failures.
  emitEvent: (body: { userId: string; type: string; payload?: Record<string, unknown> }) =>
    call(`/api/integrations/events`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // A4 — read sessions for the calendar matcher.
  listInterviewSessions: (userId: string) =>
    call<Array<{ id: string; company: string; role: string }>>(
      `/api/integrations/interview-sessions?userId=${encodeURIComponent(userId)}`
    ),

  // A4 — upsert a round discovered from Google Calendar.
  upsertCalendarInterviewRound: (body: {
    userId: string; sessionId: string; calendarEventId: string;
    kind: string; scheduledAt: string;
    durationMin?: number; interviewer?: string; notes?: string;
  }) => call<{ id: string; created: boolean }>(
    `/api/integrations/interview-rounds/from-calendar`,
    { method: "POST", body: JSON.stringify(body) }
  ),

  // A4 — upcoming interview rounds + bulk notified-mark.
  dueInterviewRounds: (withinHours = 24, renotifyHours = 24) =>
    call<Array<{
      roundId: string; sessionId: string; userId: string;
      kind: string; scheduledAt: string;
      durationMin: number | null; interviewer: string | null;
      notes: string | null;
      company: string; role: string;
      lastNotifiedAt: string | null;
    }>>(`/api/integrations/interview-rounds/due?withinHours=${withinHours}&renotifyHours=${renotifyHours}`),

  markInterviewRoundsNotified: (ids: string[]) =>
    call<{ updated: number }>(`/api/integrations/interview-rounds/notified`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  // A3.prep — fetch a single job_lead for the research step.
  getJobLead: (id: string, userId: string) =>
    call<{
      id: string; source: string; sourceId: string | null;
      title: string; company: string | null; location: string | null; url: string;
      salaryMin: number | null; salaryMax: number | null;
      currency: string | null; salaryPeriod: string | null;
      description: string | null; postedAt: string | null;
      score: number | null; scoreReason: string | null;
    }>(`/api/integrations/job-leads/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`),

  // A3.prep — upsert the interview_session (idempotent per source_job_lead_id).
  upsertInterviewSession: (body: {
    userId: string;
    company: string;
    role: string;
    sourceJobLeadId?: string;
    notes?: string;
    metadata?: Record<string, unknown>;
  }) => call<{
    id: string; company: string; role: string;
    sourceJobLeadId: string | null;
    status: string; createdAt: string;
  }>(`/api/integrations/interview-sessions`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  scoreJobLead: (id: string, body: { userId: string; score: number; reason?: string }) =>
    call(`/api/integrations/job-leads/${encodeURIComponent(id)}/score`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  upsertJobLead: (body: {
    userId: string; source: string; sourceId: string;
    title: string; url: string;
    company?: string | null; location?: string | null;
    salaryMin?: number | null; salaryMax?: number | null;
    currency?: string | null; salaryPeriod?: string | null;
    description?: string | null; postedAt?: string | null;
    metadata?: Record<string, unknown>;
  }) => call<{ id: string; sourceId: string; title: string; created: boolean }>(
    `/api/integrations/job-leads`,
    { method: "POST", body: JSON.stringify(body) }
  ),

  // A8.1 — enabled learning goals for a user.
  listLearningGoals: (userId: string) =>
    call<Array<{
      id: string; sourceKind: "github_release" | "dev_to_tag" | "rss";
      target: string; weight: number; note: string | null;
      metadata: Record<string, unknown>;
    }>>(`/api/integrations/learning-goals?userId=${encodeURIComponent(userId)}`),

  getEffectivePrompt: (name: string, userId: string) =>
    call<{ body: string; model: string | null; temperature: number | null; hasOverride: boolean } | null>(
      `/api/integrations/prompts/${encodeURIComponent(name)}?userId=${encodeURIComponent(userId)}`
    ).catch((err) => {
      if (err instanceof Error && / 404/.test(err.message)) return null;
      throw err;
    }),
};
