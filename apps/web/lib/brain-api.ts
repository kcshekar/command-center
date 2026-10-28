import { apiFetch } from "./api";

// P1.1 — knowledge_items (the RAG memory), not kb_commands (Command Vault).
export interface KnowledgeItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  tags: string[];
  source: string;
  sharedWithOrg: boolean;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeInput = { type: string; title: string; body: string; tags: string[] };

const qs = (p: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => !!e[1])).toString();

export const brainApi = {
  list: (type?: string) => apiFetch<KnowledgeItem[]>(`/knowledge-items?${qs({ type, limit: "100" })}`),
  search: (q: string, type?: string) => apiFetch<KnowledgeItem[]>(`/knowledge-items/search?${qs({ q, type, limit: "50" })}`),
  create: (body: KnowledgeInput) => apiFetch<KnowledgeItem>(`/knowledge-items`, { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: Partial<KnowledgeInput>) =>
    apiFetch<KnowledgeItem>(`/knowledge-items/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (id: string) => apiFetch(`/knowledge-items/${id}`, { method: "DELETE" }),
};
