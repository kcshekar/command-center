import { apiFetch } from "./api";

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
}
export interface WorkspaceKeyMaterial {
  id: string;
  name: string;
  kdfSalt: string;
  kdfIterations: number;
  wrappedKeyByPassword: string;
  wrapIvPassword: string;
  wrappedKeyByRecovery: string;
  wrapIvRecovery: string;
}

export const workspaceApi = {
  list: () => apiFetch<Workspace[]>("/workspaces"),

  create: (params: {
    name: string;
    kdfSalt: string;
    wrappedKeyByPassword: string;
    wrapIvPassword: string;
    wrappedKeyByRecovery: string;
    wrapIvRecovery: string;
  }) => apiFetch<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(params) }),

  getKeyMaterial: (workspaceId: string) => apiFetch<WorkspaceKeyMaterial>(`/workspaces/${workspaceId}`),

  changePassword: (workspaceId: string, params: { kdfSalt: string; wrappedKeyByPassword: string; wrapIvPassword: string }) =>
    apiFetch(`/workspaces/${workspaceId}/password`, { method: "PUT", body: JSON.stringify(params) }),

  reset: (workspaceId: string, confirmName: string) =>
    apiFetch(`/workspaces/${workspaceId}`, { method: "DELETE", body: JSON.stringify({ confirmName }) }),
};
