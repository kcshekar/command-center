-- Phase 2.1a: Per-user credential store (BYOK) for external APIs the
-- automations call: Keepa for A6, OpenAI/Replicate for A1+A9 later, JSearch
-- for A2 later, etc. One row per (user, service, label) so the same user may
-- hold more than one key per service.
--
-- Encryption: pgcrypto's pgp_sym_encrypt / pgp_sym_decrypt with a DEK the
-- app passes at call time. The DEK lives in the api process .env
-- (USER_CREDENTIALS_DEK) today; it moves to GCP Secret Manager when we move
-- to the GCP VM. The DEK NEVER lives in the DB.
--
-- key_prefix (plain text, first 6 chars) is kept so the UI can show
-- "sk_live_abc...dEF" style display without a decrypt round-trip.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE user_credentials (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service     text NOT NULL,                          -- 'keepa' | 'openai' | 'replicate' | 'jsearch' | 'serpapi' | 'reddit' | ...
  label       text NOT NULL DEFAULT 'primary',       -- distinguish multiple keys for one service
  key_enc     bytea NOT NULL,                         -- pgp_sym_encrypt(key, DEK)
  key_prefix  text,                                   -- first ~6 chars of raw key, for UI display
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,     -- any non-secret context: scopes, host, notes
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, service, label)
);

CREATE INDEX user_credentials_user_service_idx
  ON user_credentials(user_id, service);

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_credentials_tenant ON user_credentials
  USING (
    org_id  = current_setting('app.current_org_id',  true)::uuid
    AND user_id = current_setting('app.current_user_id', true)::uuid
  );
-- No FORCE: cc_admin bypasses, matching worker_clients / automation_grants.

GRANT SELECT, INSERT, UPDATE, DELETE ON user_credentials TO command_center_app;
