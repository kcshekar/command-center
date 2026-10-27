import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Verifies the OAuth `state` CC signs at GET /api/integrations/oauth-state.
// Returns the CC user + org it was issued to, or null if forged/expired.
export function verifyOAuthState(state: string | null): { ccUserId: string; orgId: string } | null {
  const secret = process.env.WORKER_CALLBACK_TOKEN;
  if (!state || !secret) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { u, o, exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof u !== "string" || typeof o !== "string" || typeof exp !== "number" || exp < Date.now()) return null;
    return { ccUserId: u, orgId: o };
  } catch {
    return null;
  }
}

// Same pattern as CC's slack-crypto.ts: HMAC-SHA256 as a KDF over the env
// secret (Extract half of HKDF, which for a high-entropy secret is enough
// to produce a stable 32-byte AES key).
function kek(): Buffer {
  const secret = process.env.AUTOMATIONS_ENCRYPTION_SECRET;
  if (!secret) throw new Error("AUTOMATIONS_ENCRYPTION_SECRET must be set");
  return createHmac("sha256", "automations-worker-kdf-v1").update(secret).digest();
}

export function encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]), iv };
}

export function decrypt(ciphertext: Buffer, iv: Buffer): string {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", kek(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}
