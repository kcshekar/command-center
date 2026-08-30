"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, ApiError } from "./api";

interface AuthUser {
  userId: string;
  orgId: string;
  role: "owner" | "admin" | "member" | "contractor";
  mfaEnabled: boolean;
}

type LoginOutcome = { mfaRequired: true; mfaToken: string } | { mfaRequired: false };

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signup: (orgName: string, email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  completeMfaLogin: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<AuthUser>("/auth/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function signup(orgName: string, email: string, password: string) {
    const u = await apiFetch<AuthUser>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ orgName, email, password }),
    });
    setUser(u);
  }

  async function login(email: string, password: string): Promise<LoginOutcome> {
    const res = await apiFetch<AuthUser | { mfaRequired: true; mfaToken: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if ("mfaRequired" in res) return res;
    setUser(res);
    return { mfaRequired: false };
  }

  async function completeMfaLogin(mfaToken: string, code: string) {
    const u = await apiFetch<AuthUser>("/auth/login/mfa", { method: "POST", body: JSON.stringify({ mfaToken, code }) });
    setUser(u);
  }

  async function logout() {
    await apiFetch("/auth/logout", { method: "POST" });
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, signup, login, completeMfaLogin, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };
