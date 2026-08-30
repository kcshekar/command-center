// Zero-knowledge client-side crypto. Native Web Crypto API for everything
// except the password KDF (Argon2id, via @noble/hashes — Web Crypto has no
// native Argon2). Runs in the browser; also runs under Bun (same global
// crypto.subtle), which is how the *_check.ts scratch scripts exercise it
// without a browser.
//
// Key hierarchy (per Workspace):
//   master password + salt --Argon2id (or legacy PBKDF2)--> password key (AES-GCM)
//   random recovery key (shown to user once)  ---------------+
//                                                             |
//   both wrap the SAME randomly-generated workspace key <----+
//   workspace key --wraps--> per-project/per-item DEK --encrypts--> values
//
// The workspace key is never derived — it's random, generated once, and
// wrapped twice (by password, by recovery key). This indirection is what
// makes changing the password (or recovering via the recovery key) cheap:
// only the small wrapped-workspace-key changes, never the underlying DEKs
// or the secrets they encrypt.
//
// No canary needed to validate a password: attempting to unwrap
// wrapped_key_by_password with the wrong password-derived key fails
// outright (AES-GCM auth tag mismatch) — that failure IS the validation.
//
// Workspaces created before this migration were wrapped with PBKDF2; their
// kdf_algorithm stays 'pbkdf2' until the next successful unlock, password
// change, or recovery, at which point they're transparently re-wrapped
// under Argon2id (see workspace-context.tsx).
import { argon2idAsync } from "@noble/hashes/argon2.js";

const PBKDF2_ITERATIONS = 210_000;
export type KdfAlgorithm = "pbkdf2" | "argon2id";
// OWASP-minimum-recommended Argon2id cost params, sized to stay responsive
// in pure-JS (no WASM) inside a browser tab.
export const ARGON2ID_PARAMS = { t: 2, m: 19_456, p: 1 } as const;

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function generateIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12));
}

// Generic random AES-256-GCM key — used for DEKs and for the workspace key
// itself (same primitive, different role).
export async function generateKey(): Promise<CryptoKey> {
  // extractable: true — must be, so it can be exported and wrapped below.
  // The unwrapped key only ever exists in memory, never persisted.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveArgon2idPasswordKey(
  password: string,
  salt: Uint8Array,
  memoryKib: number = ARGON2ID_PARAMS.m,
  timeCost: number = ARGON2ID_PARAMS.t
): Promise<CryptoKey> {
  const raw = await argon2idAsync(password, salt, { t: timeCost, m: memoryKib, p: ARGON2ID_PARAMS.p, dkLen: 32 });
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Dispatches to whichever KDF a workspace's stored key material says it was
// wrapped with — lets unlock/change-password/recovery share one call site
// regardless of whether that workspace has been upgraded to Argon2id yet.
export function derivePasswordKeyFor(
  algorithm: KdfAlgorithm,
  password: string,
  salt: Uint8Array,
  iterations: number,
  memoryKib: number | null
): Promise<CryptoKey> {
  if (algorithm === "argon2id") return deriveArgon2idPasswordKey(password, salt, memoryKib ?? ARGON2ID_PARAMS.m, iterations);
  return derivePasswordKey(password, salt, iterations);
}

// A recovery key is high-entropy random bytes used directly as an AES key —
// no PBKDF2 needed (it's not human-memorable, so no need to slow-hash it).
// The string form is what's shown to the user once, to save themselves.
export async function generateRecoveryKey(): Promise<{ recoveryKey: CryptoKey; recoveryKeyString: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const recoveryKeyString = toBase64(raw);
  const recoveryKey = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { recoveryKey, recoveryKeyString };
}

export async function importRecoveryKey(recoveryKeyString: string): Promise<CryptoKey> {
  const raw = fromBase64(recoveryKeyString);
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// Generic wrap/unwrap: used for DEK-under-workspace-key, and for
// workspace-key-under-password-key / workspace-key-under-recovery-key.
export async function wrapKey(keyToWrap: CryptoKey, wrappingKey: CryptoKey): Promise<{ wrapped: string; wrapIv: string }> {
  const raw = await crypto.subtle.exportKey("raw", keyToWrap);
  const iv = generateIv();
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, wrappingKey, raw);
  return { wrapped: toBase64(wrapped), wrapIv: toBase64(iv) };
}

// extractable defaults to false (least privilege — most unwrapped keys, like
// DEKs, only ever need to encrypt/decrypt, never be re-wrapped). Pass true
// when the caller needs to re-wrap the result under a different key, e.g.
// the workspace key during a password change or recovery.
export async function unwrapKey(
  wrapped: string,
  wrapIv: string,
  wrappingKey: CryptoKey,
  extractable = false
): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapIv) as BufferSource },
    wrappingKey,
    fromBase64(wrapped) as BufferSource
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", extractable, ["encrypt", "decrypt"]);
}

export async function encryptData(key: CryptoKey, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = generateIv();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: toBase64(ct), iv: toBase64(iv) };
}

export async function decryptData(key: CryptoKey, ciphertext: string, iv: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) as BufferSource },
    key,
    fromBase64(ciphertext) as BufferSource
  );
  return new TextDecoder().decode(pt);
}

export { toBase64, fromBase64 };
