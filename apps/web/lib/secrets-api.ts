import { apiFetch } from "./api";

export interface Project {
  id: string;
  name: string;
  created_at: string;
}
export interface ProjectDetail {
  id: string;
  name: string;
  workspaceId: string;
  wrappedDek: string;
  wrapIv: string;
  environments: { id: string; name: string }[];
}
export interface SecretItem {
  id: string;
  keyLabel: string;
  ciphertext: string;
  iv: string;
  version: number;
  updatedAt: string;
}

export const secretsApi = {
  listProjects: (workspaceId: string) => apiFetch<Project[]>(`/secrets/projects?workspaceId=${workspaceId}`),
  createProject: (workspaceId: string, name: string, wrappedDek: string, wrapIv: string) =>
    apiFetch<Project>("/secrets/projects", {
      method: "POST",
      body: JSON.stringify({ workspaceId, name, wrappedDek, wrapIv }),
    }),
  getProject: (projectId: string) => apiFetch<ProjectDetail>(`/secrets/projects/${projectId}`),

  createEnvironment: (projectId: string, name: string) =>
    apiFetch<{ id: string; name: string }>(`/secrets/projects/${projectId}/environments`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  listSecrets: (envId: string) => apiFetch<SecretItem[]>(`/secrets/environments/${envId}/secrets`),
  upsertSecret: (envId: string, keyLabel: string, ciphertext: string, iv: string) =>
    apiFetch(`/secrets/environments/${envId}/secrets`, {
      method: "POST",
      body: JSON.stringify({ keyLabel, ciphertext, iv }),
    }),

  reveal: (secretId: string) => apiFetch<{ ciphertext: string; iv: string }>(`/secrets/${secretId}/reveal`, { method: "POST" }),
  copyEvent: (secretId: string) => apiFetch(`/secrets/${secretId}/copy-event`, { method: "POST" }),
};
