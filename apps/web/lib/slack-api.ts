import { apiFetch } from "./api";

export interface SlackConnection {
  id: string;
  name: string;
  workspace_id: string;
  bot_user_id: string;
  status: "active" | "disabled" | "error" | "revoked";
  granted_scopes: string[];
  last_verified_at: string;
  created_at: string;
  updated_at?: string;
}

export interface SlackRoute {
  id: string;
  route_key: string;
  connection_id: string;
  connection_name: string;
  channel_id: string;
  channel_name: string | null;
  is_enabled: boolean;
  allow_buttons: boolean;
  allowed_approver_slack_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface EnvStatus {
  envConfigured: boolean;
  hasDbConnections: boolean;
}

export const slackApi = {
  envStatus: () => apiFetch<EnvStatus>("/slack/env-status"),
  migrateEnv: () => apiFetch<{ migrated: boolean; connectionId: string; routeId: string }>("/slack/migrate-env", { method: "POST" }),
  
  listConnections: () => apiFetch<SlackConnection[]>("/slack/connections"),
  createConnection: (params: { name: string; botToken: string; appToken?: string }) =>
    apiFetch<SlackConnection>("/slack/connections", { method: "POST", body: JSON.stringify(params) }),
  updateConnection: (connectionId: string, params: { name?: string; botToken?: string; appToken?: string; status?: string }) =>
    apiFetch(`/slack/connections/${connectionId}`, { method: "PUT", body: JSON.stringify(params) }),
  removeConnection: (connectionId: string) =>
    apiFetch(`/slack/connections/${connectionId}`, { method: "DELETE" }),
  testConnection: (connectionId: string) =>
    apiFetch<{ ok: boolean; workspaceId?: string; botUserId?: string; scopes?: string[]; error?: string }>(`/slack/connections/${connectionId}/test`, { method: "POST" }),

  listRoutes: () => apiFetch<SlackRoute[]>("/slack/routes"),
  upsertRoute: (params: {
    routeKey: string;
    connectionId: string;
    channelId: string;
    channelName?: string;
    isEnabled?: boolean;
    allowButtons?: boolean;
    allowedApproverSlackIds?: string[];
  }) => apiFetch<SlackRoute>("/slack/routes", { method: "POST", body: JSON.stringify(params) }),
  removeRoute: (routeId: string) => apiFetch(`/slack/routes/${routeId}`, { method: "DELETE" }),
};
