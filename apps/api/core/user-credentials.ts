// Encryption helper for user_credentials (migration 0027). The DEK lives in
// the api process env, never in the DB, never in a log line. We don't do
// Node-side crypto here — pgcrypto's pgp_sym_encrypt / pgp_sym_decrypt handle
// it in SQL, and the DEK is passed as a bound parameter so Bun.SQL does not
// inline it into the SQL text.

export function getUserCredentialsDek(): string {
  const dek = process.env.USER_CREDENTIALS_DEK;
  if (!dek) {
    throw new Error(
      "USER_CREDENTIALS_DEK must be set — generate with `openssl rand -base64 32` and add to apps/api/.env"
    );
  }
  return dek;
}

// Known services the UI offers in its dropdown + validates against. Users
// can only set keys for services on this list; keeps typos from scattering
// across the DB.
export const KNOWN_SERVICES = [
  "keepa",
  "openweather", // N15: weather + AQI in the morning brief
  "openai",
  "anthropic",
  "replicate",
  "jsearch",
  "serpapi",
  "reddit",
  "github",
  "adzuna",
  "buffer",
] as const;

export type KnownService = (typeof KNOWN_SERVICES)[number];

export function isKnownService(s: string): s is KnownService {
  return (KNOWN_SERVICES as readonly string[]).includes(s);
}

// Short prefix stored alongside the ciphertext so the UI can show
// "sk_live_abc…" without decrypting.
export function keyPrefix(raw: string): string {
  return raw.slice(0, Math.min(6, raw.length));
}
