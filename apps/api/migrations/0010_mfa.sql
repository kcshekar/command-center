ALTER TABLE users
  ADD COLUMN mfa_secret bytea,
  ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;

-- One-time-use backup codes for logging in if the authenticator device is
-- lost. Hashed the same way as login passwords (Bun.password/argon2id) —
-- they're bearer secrets, so they get the same at-rest protection.
CREATE TABLE mfa_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_backup_codes_user_id_idx ON mfa_backup_codes(user_id);
