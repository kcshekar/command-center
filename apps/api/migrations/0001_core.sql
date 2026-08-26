CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member','contractor')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Generic per-resource RBAC scoping, shared across modules (e.g. a contractor
-- limited to one secrets project, or one finance project's payroll data).
-- resource_type + resource_id point at rows in module-owned tables — no FK,
-- so core never depends on a module's schema (keeps modules independently droppable).
CREATE TABLE resource_grants (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  scope         text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','write','payroll_only')),
  PRIMARY KEY (user_id, resource_type, resource_id)
);

-- Append-only. RLS below denies UPDATE/DELETE entirely (no policy defined for
-- them), so the immutability guarantee holds even if the app role is compromised.
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL,
  actor_id      uuid NOT NULL REFERENCES users(id),
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   uuid,
  ip            inet,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at DESC);

-- No RLS on users: login must look a user up by email before any org context
-- exists (chicken-and-egg), so this table can't be tenant-gated at the row
-- level. It holds only id/email/argon2-hash/role — the sensitive data (secrets,
-- vault, financial records) lives in tables below that DO carry strict RLS,
-- and app code still scopes org_id explicitly wherever it matters.

ALTER TABLE resource_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY grants_tenant_isolation ON resource_grants
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
-- deliberately no UPDATE/DELETE policy: those commands are denied outright

-- FORCE is required because the migration-running role owns these tables,
-- and table owners bypass RLS by default (only non-owners are restricted
-- otherwise). Without FORCE, RLS would be a no-op against our own app role.
ALTER TABLE resource_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
