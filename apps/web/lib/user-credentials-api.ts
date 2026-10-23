import { apiFetch } from "./api";

export interface UserCredential {
  service: string;
  label: string;
  keyPrefix: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UserCredentialsResponse {
  knownServices: readonly string[];
  credentials: UserCredential[];
}

export const userCredentialsApi = {
  list: () => apiFetch<UserCredentialsResponse>("/user-credentials"),

  save: (input: { service: string; label?: string; key: string; metadata?: Record<string, unknown> }) =>
    apiFetch<UserCredential>("/user-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),

  remove: (service: string, label: string) =>
    apiFetch(`/user-credentials/${encodeURIComponent(service)}/${encodeURIComponent(label)}`, {
      method: "DELETE",
    }),
};
