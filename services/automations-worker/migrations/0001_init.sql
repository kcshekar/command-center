-- Worker-private storage. Isolated from the command_center DB (D3).

CREATE TABLE google_oauth_tokens (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email              text NOT NULL UNIQUE,
  encrypted_access_token  bytea NOT NULL,
  access_token_iv         bytea NOT NULL,
  encrypted_refresh_token bytea NOT NULL,
  refresh_token_iv        bytea NOT NULL,
  token_expiry            timestamptz NOT NULL,
  scopes                  text[] NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gmail_history_cursors (
  user_email      text PRIMARY KEY REFERENCES google_oauth_tokens(user_email) ON DELETE CASCADE,
  last_history_id numeric(20, 0) NOT NULL,
  last_synced_at  timestamptz NOT NULL DEFAULT now()
);
