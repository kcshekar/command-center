import { apiFetch } from "./api";

export interface AuditEntry {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  actor_email: string;
}

export const auditApi = {
  list: (before?: string) =>
    apiFetch<AuditEntry[]>(`/audit-log${before ? `?before=${before}` : ""}`),
};
