-- CC-side metadata mirror of the worker's google_oauth_tokens table. The
-- worker remains the only system that holds encrypted refresh tokens; CC
-- stores just what the UI needs to show (which Google accounts are connected,
-- when they last refreshed). Worker upserts here via a service token on every
-- auth and every refresh.

CREATE TABLE google_oauth_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email              text NOT NULL,
  scopes             text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'active',          -- active | revoked | error
  last_refreshed_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

ALTER TABLE google_oauth_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY google_oauth_accounts_tenant ON google_oauth_accounts
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
-- No FORCE: owner (migrator) bypasses so service-token upserts can resolve
-- cross-org during authentication without the resolve-then-set-tenant dance.

GRANT SELECT, INSERT, UPDATE, DELETE ON google_oauth_accounts TO command_center_app;
