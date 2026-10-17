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

// ─── Worker identities (H5) ────────────────────────────────────────────────
export interface WorkerClient {
  id: string;
  name: string;
  client_id: string;
  client_secret_prefix: string;
  allowed_scopes: string[];
  home_user_id: string;
  default_ttl_seconds: number;
  is_active: boolean;
  created_at: string;
  rotated_at: string | null;
  last_mint_at: string | null;
  live_minted_count: number;
}

export interface NewWorkerClient {
  id: string;
  name: string;
  client_id: string;
  client_secret: string; // raw, shown once
  client_secret_prefix: string;
  allowed_scopes: string[];
  default_ttl_seconds: number;
  created_at: string;
}

export interface RotatedWorkerClient {
  id: string;
  client_id: string;
  client_secret: string; // raw, shown once
  client_secret_prefix: string;
  rotated_at: string;
}

export const workerClientsApi = {
  list: () => apiFetch<WorkerClient[]>("/worker-clients"),
  create: (params: { name: string; allowedScopes: string[]; homeUserId?: string; defaultTtlSeconds?: number }) =>
    apiFetch<NewWorkerClient>("/worker-clients", { method: "POST", body: JSON.stringify(params) }),
  rotate: (id: string) => apiFetch<RotatedWorkerClient>(`/worker-clients/${id}/rotate`, { method: "POST" }),
  remove: (id: string) => apiFetch(`/worker-clients/${id}`, { method: "DELETE" }),
  update: (id: string, params: { isActive?: boolean; name?: string; allowedScopes?: string[]; defaultTtlSeconds?: number }) =>
    apiFetch(`/worker-clients/${id}`, { method: "PATCH", body: JSON.stringify(params) }),
};
