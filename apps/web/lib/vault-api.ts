import { apiFetch } from "./api";

export interface VaultItemSummary {
  id: string;
  label: string;
  url: string | null;
  updated_at: string;
}
export interface VaultItemDetail {
  id: string;
  label: string;
  url: string | null;
  workspaceId: string;
  ciphertext: string;
  iv: string;
  wrappedDek: string;
  wrapIv: string;
  updatedAt: string;
}

export const vaultApi = {
  list: (workspaceId: string) => apiFetch<VaultItemSummary[]>(`/vault/items?workspaceId=${workspaceId}`),
  get: (itemId: string) => apiFetch<VaultItemDetail>(`/vault/items/${itemId}`),
  create: (params: { workspaceId: string; label: string; url?: string; ciphertext: string; iv: string; wrappedDek: string; wrapIv: string }) =>
    apiFetch<{ id: string; label: string; url: string | null }>("/vault/items", { method: "POST", body: JSON.stringify(params) }),
  update: (itemId: string, params: { label: string; url?: string; ciphertext: string; iv: string; wrappedDek: string; wrapIv: string }) =>
    apiFetch(`/vault/items/${itemId}`, { method: "PUT", body: JSON.stringify(params) }),
  remove: (itemId: string) => apiFetch(`/vault/items/${itemId}`, { method: "DELETE" }),
  copyEvent: (itemId: string, field: "username" | "password") =>
    apiFetch(`/vault/items/${itemId}/copy-event`, { method: "POST", body: JSON.stringify({ field }) }),
};
