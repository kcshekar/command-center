import { apiFetch } from "./api";

// Routes (admin — same channel-agnostic shape used across all channel types)
export interface NotificationRoute {
  id: string;
  route_key: string;
  channel_type: "slack" | "in_app" | string;
  connection_id: string | null;
  connection_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  is_enabled: boolean;
  allow_buttons: boolean;
  allowed_approver_slack_ids: string[];
  created_at: string;
  updated_at: string;
}

// Per-user in-app queue
export interface InAppNotification {
  id: string;
  route_key: string;
  text: string;
  blocks: unknown[] | null;
  is_approval: boolean;
  approval_state: "approved" | "rejected" | "expired" | null;
  approval_action_id: string | null;
  approval_workflow_id: string | null;
  read_at: string | null;
  created_at: string;
}

export const notificationsApi = {
  listRoutes: () => apiFetch<NotificationRoute[]>("/notifications/routes"),

  upsertRoute: (params: {
    routeKey: string;
    channelType: "slack" | "in_app";
    connectionId?: string | null;
    channelId?: string | null;
    channelName?: string | null;
    isEnabled?: boolean;
    allowButtons?: boolean;
    allowedApproverSlackIds?: string[];
  }) => apiFetch<NotificationRoute>("/notifications/routes", { method: "POST", body: JSON.stringify(params) }),

  removeRoute: (routeId: string) => apiFetch(`/notifications/routes/${routeId}`, { method: "DELETE" }),

  listInApp: (unreadOnly = false) =>
    apiFetch<InAppNotification[]>(`/notifications${unreadOnly ? "?unread=1" : ""}`),

  markRead: (id: string) => apiFetch(`/notifications/${id}/read`, { method: "POST" }),

  respond: (id: string, decision: "approved" | "rejected") =>
    apiFetch<{ ok: true; decision: string }>(`/notifications/${id}/respond`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
};
