// Encryption helper for pilgrim_identities (migration 0034). Separate DEK
// from user_credentials so pilgrim PII and third-party API keys rotate
// independently. Same pattern otherwise: DEK in env only, pgcrypto does the
// work inside SQL, DEK is passed as a bound parameter so Bun.SQL never inlines
// it into the statement text.

export function getPilgrimIdentitiesDek(): string {
  const dek = process.env.PILGRIM_IDENTITIES_DEK;
  if (!dek) {
    throw new Error(
      "PILGRIM_IDENTITIES_DEK must be set — generate with `openssl rand -hex 32` and add to apps/api/.env"
    );
  }
  return dek;
}

export const ID_TYPES = ["aadhaar", "passport", "voter_id", "driving_license"] as const;
export type IdType = (typeof ID_TYPES)[number];

export const RELATIONSHIPS = ["self", "spouse", "parent", "child", "other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const GENDERS = ["male", "female", "other"] as const;
export type Gender = (typeof GENDERS)[number];

// Fields that live inside the encrypted blob. The UI/API returns these in the
// clear after decryption; keeping them in one blob means one pgcrypto call per
// row instead of five.
export interface PilgrimPii {
  dob?: string;         // YYYY-MM-DD
  idNumber?: string;
  phone?: string;
  email?: string;
  address?: string;
}
