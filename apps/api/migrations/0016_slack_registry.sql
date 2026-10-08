CREATE TABLE slack_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  workspace_id            text NOT NULL,
  bot_user_id             text NOT NULL,
  encrypted_bot_token     bytea NOT NULL,
  bot_token_iv            bytea NOT NULL,
  encrypted_app_token     bytea,
  app_token_iv            bytea,
  encrypted_refresh_token bytea,
  refresh_token_iv        bytea,
  token_expires_at        timestamptz,
  granted_scopes          text[] NOT NULL DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error', 'revoked')),
  last_verified_at        timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slack_connections_org_idx ON slack_connections(org_id);

CREATE TABLE slack_routes (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  route_key                   text NOT NULL,
  connection_id               uuid NOT NULL REFERENCES slack_connections(id) ON DELETE CASCADE,
  channel_id                  text NOT NULL,
  channel_name                text,
  is_enabled                  boolean NOT NULL DEFAULT true,
  allow_buttons               boolean NOT NULL DEFAULT false,
  allowed_approver_slack_ids  text[] NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, route_key)
);

CREATE INDEX slack_routes_org_idx ON slack_routes(org_id);

ALTER TABLE slack_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY slack_connections_tenant ON slack_connections
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
ALTER TABLE slack_connections FORCE ROW LEVEL SECURITY;

ALTER TABLE slack_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY slack_routes_tenant ON slack_routes
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
ALTER TABLE slack_routes FORCE ROW LEVEL SECURITY;
