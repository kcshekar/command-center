import { hashPassword, verifyPassword } from "./auth";

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(20)); // RFC 4226 recommends >=160 bits
}

// RFC 4648 base32, no padding — the form authenticator apps expect for
// manual entry / the otpauth:// QR payload. We only ever encode our own
// generated secrets, so no decoder is needed.
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function otpauthUrl(email: string, secret: Uint8Array): string {
  const label = encodeURIComponent(`Command Center:${email}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=Command%20Center&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message as BufferSource);
  return new Uint8Array(sig);
}

// RFC 6238 TOTP: HMAC-SHA1 over the 30-second time step, dynamically
// truncated to a 6-digit code.
export async function totpAt(secret: Uint8Array, timeStep: number): Promise<string> {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(timeStep), false);
  const digest = await hmacSha1(secret, new Uint8Array(counter.buffer));
  const offset = digest[19]! & 0xf;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

// Accepts the current step and one step on either side, to absorb clock
// drift between server and authenticator app without widening the replay
// window further than necessary.
export async function verifyTotp(secret: Uint8Array, token: string): Promise<boolean> {
  const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (const offset of [0, -1, 1]) {
    if ((await totpAt(secret, step + offset)) === token) return true;
  }
  return false;
}

function randomBackupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const digits = Array.from(bytes, (b) => (b % 10).toString()).join("");
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, randomBackupCode);
}

export const hashBackupCode = hashPassword;

// Checks a candidate code against every unused hash for the user; the
// caller is responsible for marking the matched row used_at.
export async function findMatchingBackupCode(
  candidate: string,
  rows: { id: string; code_hash: string }[]
): Promise<string | null> {
  for (const row of rows) {
    if (await verifyPassword(candidate, row.code_hash)) return row.id;
  }
  return null;
}
