import { apiFetch } from "./api";
import type { NavArea } from "@/lib/nav-items";

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
  lastRunStatus: string | null;     // Temporal status name of the latest run
  createdAt: string | null;
  lastUpdatedAt: string | null;
}

export interface GrantAccount {
  email: string;
  zone?: "personal" | "professional";
}

export interface CatalogRow {
  id: string;                       // e.g. 'a1.news'
  name: string;
  description: string;
  requiredScopes: string[];
  cadenceDefault: string | null;    // 'cron:0 9 * * *' | 'event' | 'manual'
  cadence: string;                  // human form, e.g. "Every 15 min", "On demand"
  chainsTo: string[];               // downstream catalog ids
  defaultEnabled: boolean;
  area: Exclude<NavArea, "system"> | "mail" | "platform";
  uiRoute: string | null;           // page hosting its UI; null = background-only
  uiLabel: string | null;           // sidebar label (one row per page carries it)
  icon: string | null;              // lucide name, mapped in nav-items.ts
  enabled: boolean;                 // per the current user's grant
  config: { accounts?: GrantAccount[] };
  hasSchedule: boolean;             // enabling creates the user's Temporal schedule(s)
  perAccount: boolean;              // one schedule per pinned Google account
  usesZone: boolean;                // files money per account zone (personal / business)
  scheduleOverride: string | null;
  grantUpdatedAt: string | null;
}

export interface RunRow {
  workflowId: string;
  scheduleId: string | null;        // "<automationId>:<userId>[:<email>]"
  workflowType: string;
  status: string;                   // Temporal status: COMPLETED | FAILED | RUNNING | …
  startTime: string;
  closeTime: string | null;
}

export const automationsApi = {
  runs: (automationId?: string, limit = 50) =>
    apiFetch<RunRow[]>(`/automations/runs?limit=${limit}${automationId ? `&automationId=${encodeURIComponent(automationId)}` : ""}`),
  list: () => apiFetch<ScheduleRow[]>("/automations/schedules"),
  pause: (id: string) => apiFetch(`/automations/schedules/${encodeURIComponent(id)}/pause`, { method: "POST" }),
  unpause: (id: string) => apiFetch(`/automations/schedules/${encodeURIComponent(id)}/unpause`, { method: "POST" }),
  trigger: (id: string) => apiFetch(`/automations/schedules/${encodeURIComponent(id)}/trigger`, { method: "POST" }),
  catalog: () => apiFetch<CatalogRow[]>("/automations/catalog"),
  setGrantEnabled: (id: string, enabled: boolean) => automationsApi.setGrant(id, { enabled }),
  // Saves the grant and reconciles the user's Temporal schedules server-side.
  setGrant: (id: string, body: { enabled?: boolean; accounts?: GrantAccount[] }) =>
    apiFetch<{
      automationId: string;
      enabled: boolean;
      config: { accounts?: GrantAccount[] };
      scheduleOverride: string | null;
      grantUpdatedAt: string;
      scheduleIds: string[];
    }>(`/automations/catalog/${encodeURIComponent(id)}/grant`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  googleAccounts: () => apiFetch<string[]>("/automations/google-accounts"),
};
