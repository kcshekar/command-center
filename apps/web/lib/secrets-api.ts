import { apiFetch } from "./api";

export interface Project {
  id: string;
  name: string;
  created_at: string;
  environment_count: number;
}
export interface ProjectDetail {
  id: string;
  name: string;
  workspaceId: string;
  wrappedDek: string;
  wrapIv: string;
  environments: { id: string; name: string; secret_count: number }[];
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
  updateProject: (projectId: string, name: string) => apiFetch(`/secrets/projects/${projectId}`, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteProject: (projectId: string) => apiFetch(`/secrets/projects/${projectId}`, { method: "DELETE" }),

  createEnvironment: (projectId: string, name: string) =>
    apiFetch<{ id: string; name: string }>(`/secrets/projects/${projectId}/environments`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  updateEnvironment: (envId: string, name: string) => apiFetch(`/secrets/environments/${envId}`, { method: "PUT", body: JSON.stringify({ name }) }),
  deleteEnvironment: (envId: string) => apiFetch(`/secrets/environments/${envId}`, { method: "DELETE" }),

  listSecrets: (envId: string) => apiFetch<SecretItem[]>(`/secrets/environments/${envId}/secrets`),
  upsertSecret: (envId: string, keyLabel: string, ciphertext: string, iv: string) =>
    apiFetch(`/secrets/environments/${envId}/secrets`, {
      method: "POST",
      body: JSON.stringify({ keyLabel, ciphertext, iv }),
    }),
  updateSecret: (secretId: string, params: { keyLabel?: string; ciphertext?: string; iv?: string }) =>
    apiFetch(`/secrets/${secretId}`, { method: "PUT", body: JSON.stringify(params) }),
  deleteSecret: (secretId: string) => apiFetch(`/secrets/${secretId}`, { method: "DELETE" }),

  reveal: (secretId: string) => apiFetch<{ ciphertext: string; iv: string }>(`/secrets/${secretId}/reveal`, { method: "POST" }),
  copyEvent: (secretId: string) => apiFetch(`/secrets/${secretId}/copy-event`, { method: "POST" }),

  // Fallback for the import dialog when pasted/uploaded text isn't clean
  // JSON or .env syntax — asks local Ollama to structure it.
  extractKeyValuePairs: (text: string) => apiFetch<Record<string, string>>("/secrets/extract", { method: "POST", body: JSON.stringify({ text }) }),
};
