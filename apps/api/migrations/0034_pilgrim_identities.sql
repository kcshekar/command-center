-- A10.1 — Pilgrim identities (TTD slot booking prep foundation).
--
-- A row per family member the user books for. Cleartext fields let the UI
-- list rows ("Mother, Aadhaar") without decrypting; sensitive fields (dob,
-- id_number, phone, email, address) travel inside a single pgp_sym_encrypt'd
-- jsonb blob so pgcrypto only runs once per row.
--
-- DEK: process.env.PILGRIM_IDENTITIES_DEK — distinct from USER_CREDENTIALS_DEK
-- so pilgrim/PII and API-key secrets rotate independently.
-- Pattern copied from user_credentials (migration 0027).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE pilgrim_identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  full_name     text NOT NULL,
  gender        text,                                 -- 'male' | 'female' | 'other'
  id_type       text,                                 -- 'aadhaar' | 'passport' | 'voter_id' | 'driving_license'
  relationship  text NOT NULL DEFAULT 'self',         -- 'self' | 'spouse' | 'parent' | 'child' | 'other'

  -- Encrypted PII blob (jsonb). Fields: { dob, idNumber, phone, email, address }
  pii_enc       bytea,

  note          text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pilgrim_identities_user_idx ON pilgrim_identities(user_id);

ALTER TABLE pilgrim_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY pilgrim_identities_tenant ON pilgrim_identities
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON pilgrim_identities TO command_center_app;
