import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "crypto";

function getEncryptionKey(): Buffer {
  // Dedicated KEK — no SESSION_SECRET fallback: coupling the two means
  // rotating the session secret silently invalidates every stored Slack
  // bot token. Fail loudly at boot instead.
  const secret = process.env.SLACK_ENCRYPTION_SECRET;
  if (!secret) throw new Error("SLACK_ENCRYPTION_SECRET must be set");
  return createHmac("sha256", "command-center-slack-kdf").update(secret).digest();
}

export function encryptSlackToken(plaintext: string): { ciphertext: Buffer; iv: Buffer } {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([encrypted, tag]), iv };
}

export function decryptSlackToken(ciphertext: Buffer, iv: Buffer): string {
  const key = getEncryptionKey();
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}

export function maskToken(token: string): string {
  if (!token || token.length < 12) return "********";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}
