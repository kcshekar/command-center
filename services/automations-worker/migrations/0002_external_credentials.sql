-- Generic credential storage. google_oauth_tokens is kept alive for one deploy
-- cycle so a rollback is safe; a follow-up migration drops it after A1 stabilizes.

CREATE TABLE external_credentials (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service                 text NOT NULL,                            -- 'google' | 'github' | 'slack_user' | …
  user_id                 text NOT NULL,                            -- service's canonical identifier (email, login, …)
  label                   text NOT NULL DEFAULT 'primary',          -- lets one user hold several creds per service
  encrypted_access_token  bytea NOT NULL,
  access_token_iv         bytea NOT NULL,
  encrypted_refresh_token bytea,                                    -- nullable: some services don't issue one
  refresh_token_iv        bytea,
  token_expiry            timestamptz,
  scopes                  text[] NOT NULL DEFAULT '{}',
  metadata                jsonb NOT NULL DEFAULT '{}',              -- service-specific extras (install_id, team_id, …)
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service, user_id, label)
);

-- Backfill from google_oauth_tokens so existing Google activities keep working
-- immediately after the worker boots on the new code.
INSERT INTO external_credentials (
  service, user_id, label,
  encrypted_access_token, access_token_iv,
  encrypted_refresh_token, refresh_token_iv,
  token_expiry, scopes, created_at, updated_at
)
SELECT
  'google', user_email, 'primary',
  encrypted_access_token, access_token_iv,
  encrypted_refresh_token, refresh_token_iv,
  token_expiry, scopes, created_at, updated_at
FROM google_oauth_tokens
ON CONFLICT (service, user_id, label) DO NOTHING;
