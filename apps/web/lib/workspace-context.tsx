"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { workspaceApi } from "./workspace-api";
import { ApiError } from "./api";
import {
  generateSalt,
  deriveArgon2idPasswordKey,
  derivePasswordKeyFor,
  ARGON2ID_PARAMS,
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
    const passwordKey = await deriveArgon2idPasswordKey(password, salt);
    const newWorkspaceKey = await generateKey();
    const { recoveryKey, recoveryKeyString } = await generateRecoveryKey();
    const { wrapped: wrappedByPassword, wrapIv: wrapIvPassword } = await wrapKey(newWorkspaceKey, passwordKey);
    const { wrapped: wrappedByRecovery, wrapIv: wrapIvRecovery } = await wrapKey(newWorkspaceKey, recoveryKey);

    const workspace = await workspaceApi.create({
      name,
      kdfAlgorithm: "argon2id",
      kdfSalt: toBase64(salt),
      kdfIterations: ARGON2ID_PARAMS.t,
      kdfMemoryKib: ARGON2ID_PARAMS.m,
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
    const algorithm = km.kdfAlgorithm ?? "pbkdf2";
    // Workspaces still on PBKDF2 get transparently upgraded to Argon2id
    // right here — needs the unwrapped key extractable just this once, to
    // re-wrap it under a fresh Argon2id-derived key before use.
    const needsUpgrade = algorithm === "pbkdf2";
    const passwordKey = await derivePasswordKeyFor(algorithm, password, fromBase64(km.kdfSalt), km.kdfIterations, km.kdfMemoryKib);
    try {
      const key = await unwrapKey(km.wrappedKeyByPassword, km.wrapIvPassword, passwordKey, needsUpgrade);
      if (needsUpgrade) await rewrapAndPersist(workspaceId, key, password);
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
    const currentPasswordKey = await derivePasswordKeyFor(
      km.kdfAlgorithm ?? "pbkdf2",
      currentPassword,
      fromBase64(km.kdfSalt),
      km.kdfIterations,
      km.kdfMemoryKib
    );
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

  // Always (re)wraps under Argon2id — this is the one place a workspace's
  // password wrapping is written, so change-password, recovery, and the
  // transparent PBKDF2-upgrade-on-unlock path all move a workspace forward
  // to the current KDF, never backward.
  async function rewrapAndPersist(workspaceId: string, workspaceKeyMaterial: CryptoKey, newPassword: string) {
    const newSalt = generateSalt();
    const newPasswordKey = await deriveArgon2idPasswordKey(newPassword, newSalt);
    const { wrapped, wrapIv } = await wrapKey(workspaceKeyMaterial, newPasswordKey);
    await workspaceApi.changePassword(workspaceId, {
      kdfAlgorithm: "argon2id",
      kdfSalt: toBase64(newSalt),
      kdfIterations: ARGON2ID_PARAMS.t,
      kdfMemoryKib: ARGON2ID_PARAMS.m,
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
