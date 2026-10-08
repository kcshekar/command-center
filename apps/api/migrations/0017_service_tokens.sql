-- Org-scoped bearer tokens for machine-to-machine auth (Automations Worker
-- → Command Center API). Only the SHA-256 hash is stored; the raw token
-- string is shown once at creation and cannot be recovered.

CREATE TABLE service_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,                            -- e.g. "Automations Worker - Home Server"
  token_hash      text NOT NULL UNIQUE,                     -- SHA-256 hex of the raw token
  token_prefix    text NOT NULL,                            -- first 12 chars for UI display (e.g. "cc_st_a1b2c3")
  scopes          text[] NOT NULL DEFAULT '{}',             -- e.g. {'expenses:write','reminders:write','reminders:read'}
  acting_user_id  uuid NOT NULL REFERENCES users(id),       -- audit attribution + RLS user context
  expires_at      timestamptz,                              -- optional expiry
  last_used_at    timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_tokens_org_idx ON service_tokens(org_id);

ALTER TABLE service_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_tokens_tenant ON service_tokens
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
ALTER TABLE service_tokens FORCE ROW LEVEL SECURITY;

-- Idempotency keys for external-source writes (Gmail message IDs, etc.).
-- Partial index leaves existing NULL rows untouched (no accidental conflicts
-- with hand-created expenses/reminders that have no source).
ALTER TABLE expenses
  ADD COLUMN source text,
  ADD COLUMN external_id text;
CREATE UNIQUE INDEX expenses_source_ext_idx
  ON expenses (org_id, source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;

ALTER TABLE reminders
  ADD COLUMN source text,
  ADD COLUMN external_id text;
CREATE UNIQUE INDEX reminders_source_ext_idx
  ON reminders (org_id, source, external_id)
  WHERE source IS NOT NULL AND external_id IS NOT NULL;

-- SECURITY DEFINER resolver: bearer-token auth happens BEFORE tenant context
-- is set, so the restricted app role can't SELECT service_tokens directly
-- (RLS filters everything to a not-yet-set org). This narrow function runs
-- as its owner (admin role, whoever ran the migration) with just enough
-- rights to resolve one hash, then the caller sets tenant context and takes
-- over. Bumps last_used_at as a side effect so idle tokens are visible.
CREATE OR REPLACE FUNCTION resolve_service_token(p_token_hash text)
RETURNS TABLE (
  token_id       uuid,
  org_id         uuid,
  acting_user_id uuid,
  role           text,
  scopes         text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    st.id,
    st.org_id,
    st.acting_user_id,
    u.role,
    st.scopes
  FROM service_tokens st
  JOIN users u ON u.id = st.acting_user_id
  WHERE st.token_hash = p_token_hash
    AND (st.expires_at IS NULL OR st.expires_at > now());

  UPDATE service_tokens SET last_used_at = now() WHERE token_hash = p_token_hash;
END;
$$;

-- Grant execute so the restricted app role can call the resolver.
GRANT EXECUTE ON FUNCTION resolve_service_token(text) TO command_center_app;
