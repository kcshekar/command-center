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

export const slackApi = {
  listConnections: () => apiFetch<SlackConnection[]>("/slack/connections"),
  createConnection: (params: { name: string; botToken: string; appToken?: string }) =>
    apiFetch<SlackConnection>("/slack/connections", { method: "POST", body: JSON.stringify(params) }),
  updateConnection: (connectionId: string, params: { name?: string; botToken?: string; appToken?: string; status?: string }) =>
    apiFetch(`/slack/connections/${connectionId}`, { method: "PUT", body: JSON.stringify(params) }),
  removeConnection: (connectionId: string) =>
    apiFetch(`/slack/connections/${connectionId}`, { method: "DELETE" }),
  testConnection: (connectionId: string) =>
    apiFetch<{ ok: boolean; workspaceId?: string; botUserId?: string; scopes?: string[]; error?: string }>(`/slack/connections/${connectionId}/test`, { method: "POST" }),
};
