import { apiFetch } from "./api";

export interface Reminder {
  id: string;
  title: string;
  category: string;
  due_on: string;
  recurrence: string | null;
  notified_at: string | null;
}

export const remindersApi = {
  list: (days = 30) => apiFetch<Reminder[]>(`/reminders?days=${days}`),
  create: (params: { title: string; category: string; dueOn: string; recurrence?: string; resourceType?: string; resourceId?: string }) =>
    apiFetch<Reminder>("/reminders", { method: "POST", body: JSON.stringify(params) }),
  update: (id: string, params: { title: string; category: string; dueOn: string; recurrence?: string }) =>
    apiFetch(`/reminders/${id}`, { method: "PUT", body: JSON.stringify(params) }),
  remove: (id: string) => apiFetch(`/reminders/${id}`, { method: "DELETE" }),
  acknowledge: (id: string) => apiFetch<{ ok: true; nextDueOn: string | null }>(`/reminders/${id}/acknowledge`, { method: "POST" }),
  notifyDue: () => apiFetch<{ notified: number }>("/reminders/notify-due", { method: "POST" }),
};

export const REMINDER_CATEGORIES = ["bill", "insurance", "loan", "credit_card", "vehicle", "other"] as const;
