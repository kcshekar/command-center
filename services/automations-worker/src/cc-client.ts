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
  "prices:write",
  "prices:read",
  "credentials:read",
  "pilgrim:read",
  "ttd:read",
  "knowledge:read",
  "knowledge:write",
  "prompts:read",
  "learning:read",
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

  updateNotification: (routeKey: string, refs: PostedRef[], text: string, blocks?: unknown[]) =>
    call("/api/integrations/notify-update", {
      method: "POST",
      body: JSON.stringify({ routeKey, refs, text, blocks }),
    }),

  dueReminders: (days = 7) => call<DueReminder[]>(`/api/integrations/reminders/due?days=${days}`),

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
  }) => call<{ id: string; title: string; dueOn: string }>("/api/integrations/reminders", { method: "POST", body: JSON.stringify(params) }),

  // A6 Price Watcher — worker reads back the user's own BYOK key (CC owns the
  // DEK; the key crosses the wire once per call, over the already-authenticated
  // service-token channel). Returns null if the user has no key for that
  // service; the activity treats that as a soft-skip.
  getUserCredential: (userId: string, service: string) =>
    call<{ label: string; key: string } | null>(
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
