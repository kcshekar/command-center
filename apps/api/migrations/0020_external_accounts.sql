-- CC-side mirror of the worker's external_credentials (metadata only, no tokens).
-- Replaces google_oauth_accounts; the old table stays alive for one deploy cycle
-- so rollback is safe. Follow-up migration drops it after A1 stabilizes.

CREATE TABLE external_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service            text NOT NULL,                   -- 'google' | 'github' | 'slack_user' | …
  user_id            text NOT NULL,                   -- the service's canonical id (email, login, …)
  label              text NOT NULL DEFAULT 'primary', -- lets one user hold several creds per service
  scopes             text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'active',
  last_refreshed_at  timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, service, user_id, label)
);

ALTER TABLE external_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_accounts_tenant ON external_accounts
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
-- No FORCE: service-token upsert needs to find existing rows pre-tenant, same
-- reasoning as google_oauth_accounts and (post-0018) service_tokens.

GRANT SELECT, INSERT, UPDATE, DELETE ON external_accounts TO command_center_app;

-- Backfill from google_oauth_accounts so the UI shows existing Google accounts
-- immediately after CC boots on the new code.
INSERT INTO external_accounts (
  org_id, service, user_id, label, scopes, status, last_refreshed_at, created_at, updated_at
)
SELECT
  org_id, 'google', email, 'primary', scopes, status, last_refreshed_at, created_at, updated_at
FROM google_oauth_accounts
ON CONFLICT (org_id, service, user_id, label) DO NOTHING;
