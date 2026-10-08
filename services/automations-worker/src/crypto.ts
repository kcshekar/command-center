import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

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
