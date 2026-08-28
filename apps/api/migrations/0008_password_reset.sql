-- Login-password reset (standard Argon2id-hashed account auth, unrelated to
-- the zero-knowledge workspace master passwords). Stores only a hash of the
-- token, never the raw value — same reasoning as password hashing, except
-- the token is already high-entropy random so a plain SHA-256 is enough.
-- No RLS: like `users`, this must be queryable pre-session (by token, before
-- any org/user context exists).
CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);
