import { apiFetch } from "./api";

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  project_count: number;
  vault_item_count: number;
}
export interface WorkspaceKeyMaterial {
  id: string;
  name: string;
  kdfAlgorithm: "pbkdf2" | "argon2id";
  kdfSalt: string;
  kdfIterations: number;
  kdfMemoryKib: number | null;
  wrappedKeyByPassword: string;
  wrapIvPassword: string;
  wrappedKeyByRecovery: string;
  wrapIvRecovery: string;
}

interface PasswordKdfParams {
  kdfAlgorithm: string;
  kdfSalt: string;
  kdfIterations: number;
  kdfMemoryKib?: number;
}

export const workspaceApi = {
  list: () => apiFetch<Workspace[]>("/workspaces"),

  create: (params: PasswordKdfParams & {
    name: string;
    wrappedKeyByPassword: string;
    wrapIvPassword: string;
    wrappedKeyByRecovery: string;
    wrapIvRecovery: string;
  }) => apiFetch<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(params) }),

  getKeyMaterial: (workspaceId: string) => apiFetch<WorkspaceKeyMaterial>(`/workspaces/${workspaceId}`),

  changePassword: (workspaceId: string, params: PasswordKdfParams & { wrappedKeyByPassword: string; wrapIvPassword: string }) =>
    apiFetch(`/workspaces/${workspaceId}/password`, { method: "PUT", body: JSON.stringify(params) }),

  reset: (workspaceId: string, confirmName: string) =>
    apiFetch(`/workspaces/${workspaceId}`, { method: "DELETE", body: JSON.stringify({ confirmName }) }),
};
