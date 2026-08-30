import { apiFetch } from "./api";

export const mfaApi = {
  setup: () => apiFetch<{ secret: string; otpauthUrl: string }>("/auth/mfa/setup", { method: "POST" }),
  enable: (token: string) => apiFetch<{ backupCodes: string[] }>("/auth/mfa/enable", { method: "POST", body: JSON.stringify({ token }) }),
  disable: (password: string) => apiFetch<{ ok: boolean }>("/auth/mfa/disable", { method: "POST", body: JSON.stringify({ password }) }),
};
