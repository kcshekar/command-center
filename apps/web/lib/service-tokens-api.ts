import { apiFetch } from "./api";

export interface ServiceToken {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  acting_user_id: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_by: string;
  created_at: string;
}

export interface NewServiceToken extends ServiceToken {
  token: string; // raw token, returned exactly once at creation
}

export const AVAILABLE_SCOPES = ["expenses:write", "reminders:write", "reminders:read", "slack:send"] as const;

export const serviceTokensApi = {
  list: () => apiFetch<ServiceToken[]>("/service-tokens"),
  create: (params: { name: string; scopes: string[]; expiresAt?: string }) =>
    apiFetch<NewServiceToken>("/service-tokens", { method: "POST", body: JSON.stringify(params) }),
  revoke: (id: string) => apiFetch(`/service-tokens/${id}`, { method: "DELETE" }),
};
