"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { workspaceApi } from "./workspace-api";
import { ApiError } from "./api";
import {
  generateSalt,
  derivePasswordKey,
  generateKey,
  generateRecoveryKey,
  importRecoveryKey,
  wrapKey,
  unwrapKey,
  toBase64,
  fromBase64,
} from "./zk-crypto";

interface WorkspaceContextValue {
  activeWorkspaceId: string | null;
  activeWorkspaceName: string | null;
  workspaceKey: CryptoKey | null;
  unlocked: boolean;
  create: (name: string, password: string) => Promise<{ id: string; recoveryKeyString: string }>;
  unlock: (workspaceId: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  lock: () => void;
  changePassword: (workspaceId: string, currentPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  recoverWithKey: (workspaceId: string, recoveryKeyString: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  resetWorkspace: (workspaceId: string, confirmName: string) => Promise<{ ok: boolean; error?: string }>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// Only one workspace is ever "unlocked" (its key in memory) at a time — the
// workspace key never persists anywhere, not even sessionStorage. Switching
// workspaces or reloading the page always requires re-entering the password.
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeWorkspaceName, setActiveWorkspaceName] = useState<string | null>(null);
  const [workspaceKey, setWorkspaceKey] = useState<CryptoKey | null>(null);

  async function create(name: string, password: string) {
    const salt = generateSalt();
    const passwordKey = await derivePasswordKey(password, salt);
    const newWorkspaceKey = await generateKey();
    const { recoveryKey, recoveryKeyString } = await generateRecoveryKey();
    const { wrapped: wrappedByPassword, wrapIv: wrapIvPassword } = await wrapKey(newWorkspaceKey, passwordKey);
    const { wrapped: wrappedByRecovery, wrapIv: wrapIvRecovery } = await wrapKey(newWorkspaceKey, recoveryKey);

    const workspace = await workspaceApi.create({
      name,
      kdfSalt: toBase64(salt),
      wrappedKeyByPassword: wrappedByPassword,
      wrapIvPassword,
      wrappedKeyByRecovery: wrappedByRecovery,
      wrapIvRecovery,
    });

    setActiveWorkspaceId(workspace.id);
    setActiveWorkspaceName(workspace.name);
    setWorkspaceKey(newWorkspaceKey);
    return { id: workspace.id, recoveryKeyString };
  }

  async function unlock(workspaceId: string, password: string) {
    const km = await workspaceApi.getKeyMaterial(workspaceId);
    const passwordKey = await derivePasswordKey(password, fromBase64(km.kdfSalt), km.kdfIterations);
    try {
      const key = await unwrapKey(km.wrappedKeyByPassword, km.wrapIvPassword, passwordKey);
      setActiveWorkspaceId(workspaceId);
      setActiveWorkspaceName(km.name);
      setWorkspaceKey(key);
      return { ok: true };
    } catch {
      return { ok: false, error: "Incorrect password" };
    }
  }

  function lock() {
    setActiveWorkspaceId(null);
    setActiveWorkspaceName(null);
    setWorkspaceKey(null);
  }

  // Change-password and recovery are standalone re-authentications, not
  // reuses of the ambient unlocked session key — the day-to-day unlocked key
  // stays non-extractable (least privilege); only these flows unwrap with
  // extractable:true, specifically because they need to re-wrap it.
  async function changePassword(workspaceId: string, currentPassword: string, newPassword: string) {
    const km = await workspaceApi.getKeyMaterial(workspaceId);
    const currentPasswordKey = await derivePasswordKey(currentPassword, fromBase64(km.kdfSalt), km.kdfIterations);
    let key: CryptoKey;
    try {
      key = await unwrapKey(km.wrappedKeyByPassword, km.wrapIvPassword, currentPasswordKey, true);
    } catch {
      return { ok: false, error: "Current password is incorrect" };
    }
    await rewrapAndPersist(workspaceId, key, newPassword);
    return { ok: true };
  }

  async function recoverWithKey(workspaceId: string, recoveryKeyString: string, newPassword: string) {
    const km = await workspaceApi.getKeyMaterial(workspaceId);
    let recoveryKey: CryptoKey;
    try {
      recoveryKey = await importRecoveryKey(recoveryKeyString.trim());
    } catch {
      return { ok: false, error: "That doesn't look like a valid recovery key" };
    }
    let key: CryptoKey;
    try {
      key = await unwrapKey(km.wrappedKeyByRecovery, km.wrapIvRecovery, recoveryKey, true);
    } catch {
      return { ok: false, error: "Recovery key is incorrect" };
    }
    await rewrapAndPersist(workspaceId, key, newPassword);
    // Already have the key in hand — unlock immediately rather than making
    // the user type the brand-new password right back in.
    setActiveWorkspaceId(workspaceId);
    setActiveWorkspaceName(km.name);
    setWorkspaceKey(key);
    return { ok: true };
  }

  async function rewrapAndPersist(workspaceId: string, workspaceKeyMaterial: CryptoKey, newPassword: string) {
    const newSalt = generateSalt();
    const newPasswordKey = await derivePasswordKey(newPassword, newSalt);
    const { wrapped, wrapIv } = await wrapKey(workspaceKeyMaterial, newPasswordKey);
    await workspaceApi.changePassword(workspaceId, {
      kdfSalt: toBase64(newSalt),
      wrappedKeyByPassword: wrapped,
      wrapIvPassword: wrapIv,
    });
  }

  async function resetWorkspace(workspaceId: string, confirmName: string) {
    try {
      await workspaceApi.reset(workspaceId, confirmName);
      if (activeWorkspaceId === workspaceId) lock();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof ApiError ? e.message : "Failed to reset workspace" };
    }
  }

  return (
    <WorkspaceContext.Provider
      value={{
        activeWorkspaceId,
        activeWorkspaceName,
        workspaceKey,
        unlocked: workspaceKey !== null,
        create,
        unlock,
        lock,
        changePassword,
        recoverWithKey,
        resetWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
