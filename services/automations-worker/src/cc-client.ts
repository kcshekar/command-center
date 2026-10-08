// Thin fetch wrapper around Command Center's /api/integrations/* endpoints.
// Auth: single service token loaded from env (rotate by re-issuing in CC UI).

const BASE = process.env.CC_BASE_URL ?? "http://localhost:3001";
const TOKEN = process.env.CC_SERVICE_TOKEN;

if (!TOKEN) throw new Error("CC_SERVICE_TOKEN must be set");

async function call<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
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

export interface PostedMessage {
  channel: string;
  ts: string;
}

export const cc = {
  postSlack: (routeKey: string, text: string) =>
    call("/api/integrations/slack-send", { method: "POST", body: JSON.stringify({ routeKey, text }) }),

  postSlackApproval: (routeKey: string, text: string, blocks: unknown[]) =>
    call<PostedMessage>("/api/integrations/slack-approval", {
      method: "POST",
      body: JSON.stringify({ routeKey, text, blocks }),
    }),

  updateSlackMessage: (routeKey: string, channel: string, ts: string, text: string, blocks?: unknown[]) =>
    call("/api/integrations/slack-update", {
      method: "POST",
      body: JSON.stringify({ routeKey, channel, ts, text, blocks }),
    }),

  dueReminders: (days = 7) => call<DueReminder[]>(`/api/integrations/reminders/due?days=${days}`),

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
