import { getToken, ccBaseUrl, evictTokenCache, evictIdentityCache } from "./cc-token-store.js";

// Thin fetch wrapper around Command Center's /api/integrations/* endpoints.
// Auth: short-lived service tokens minted by cc-token-store from the
// worker's worker_identity row (install script seeds it, UI rotates it).
// Falls back to CC_SERVICE_TOKEN env var when the identity row is missing
// (zero-downtime migration path).
//
// For now every call uses the ALL_SCOPES set — once we add scope-split per
// activity we'll thread a scopes array through each helper.

const ALL_SCOPES = ["slack:send", "reminders:read", "reminders:write", "expenses:write"] as const;

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
};
