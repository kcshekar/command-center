import { apiFetch } from "./api";

export interface ScheduleRow {
  id: string;
  workflowType: string | null;
  taskQueue: string | null;
  cadence: string;
  paused: boolean;
  note: string | null;
  numActions: number;
  recentActions: Array<{ scheduleTime: string; actualTime: string; workflowId: string | null }>;
  nextRuns: string[];
  runningCount: number;
  createdAt: string | null;
  lastUpdatedAt: string | null;
}

export interface CatalogRow {
  id: string;                       // e.g. 'a1.news'
  name: string;
  description: string;
  requiredScopes: string[];
  cadenceDefault: string | null;    // 'cron:0 9 * * *' | 'event' | 'manual'
  chainsTo: string[];               // downstream catalog ids
  defaultEnabled: boolean;
  enabled: boolean;                 // per the current user's grant
  scheduleOverride: string | null;
  grantUpdatedAt: string | null;
}

export const automationsApi = {
  list: () => apiFetch<ScheduleRow[]>("/automations/schedules"),
  pause: (id: string) => apiFetch(`/automations/schedules/${encodeURIComponent(id)}/pause`, { method: "POST" }),
  unpause: (id: string) => apiFetch(`/automations/schedules/${encodeURIComponent(id)}/unpause`, { method: "POST" }),
  trigger: (id: string) => apiFetch(`/automations/schedules/${encodeURIComponent(id)}/trigger`, { method: "POST" }),
  catalog: () => apiFetch<CatalogRow[]>("/automations/catalog"),
  setGrantEnabled: (id: string, enabled: boolean) =>
    apiFetch<{
      automationId: string;
      enabled: boolean;
      scheduleOverride: string | null;
      grantUpdatedAt: string;
    }>(`/automations/catalog/${encodeURIComponent(id)}/grant`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
};
