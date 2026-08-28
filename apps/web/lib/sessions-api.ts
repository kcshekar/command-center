import { apiFetch } from "./api";

export interface SessionSummary {
  token: string;
  createdAt: number;
  isCurrent: boolean;
}

export const sessionsApi = {
  list: () => apiFetch<SessionSummary[]>("/auth/sessions"),
  revokeOthers: () => apiFetch<{ revoked: number }>("/auth/sessions/revoke-others", { method: "POST" }),
};
