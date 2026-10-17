-- H5a: worker_clients registers each automations worker as a trusted OAuth2
-- client (client_id + client_secret). The worker uses these to call the mint
-- endpoint, which issues short-lived service_tokens. Removes the need to
-- paste a long-lived cc_st_... into the worker's .env.
--
-- A home_org_id + home_user_id lets the mint endpoint default to the right
-- tenant when the caller doesn't specify (today's single-org case).

CREATE TABLE worker_clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,                                 -- e.g. "Automations Worker — home VM"
  client_id           text NOT NULL UNIQUE,                          -- "worker_" + hex, non-secret
  client_secret_hash  text NOT NULL,                                 -- SHA-256 of raw secret; raw shown once
  client_secret_prefix text NOT NULL,                                -- first 12 chars for UI display
  allowed_scopes      text[] NOT NULL DEFAULT '{}',                  -- max scopes a mint call can request
  home_org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  home_user_id        uuid NOT NULL REFERENCES users(id),            -- acting_user for minted tokens
  is_active           boolean NOT NULL DEFAULT true,
  default_ttl_seconds integer NOT NULL DEFAULT 3600,                 -- 1h; tightenable later
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  rotated_at          timestamptz,
  last_mint_at        timestamptz
);

CREATE INDEX worker_clients_org_idx ON worker_clients(home_org_id);

ALTER TABLE worker_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_clients_tenant ON worker_clients
  USING (home_org_id = current_setting('app.current_org_id', true)::uuid);
-- No FORCE: owner (cc_admin) + mint resolver (SECURITY DEFINER) must bypass,
-- same pattern as service_tokens post-0018.

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_clients TO command_center_app;

-- Audit which client minted each short-lived token, and give it a label.
ALTER TABLE service_tokens
  ADD COLUMN minted_by_client_id uuid REFERENCES worker_clients(id) ON DELETE SET NULL,
  ADD COLUMN purpose text;

CREATE INDEX service_tokens_minted_by_idx ON service_tokens(minted_by_client_id);

-- SECURITY DEFINER resolver that validates client_id/client_secret_hash and
-- returns the row the mint endpoint needs. Same reasoning as
-- resolve_service_token: happens pre-tenant, needs to bypass RLS. Owner is
-- the admin role (cc_admin on prod) which bypasses because worker_clients is
-- not FORCE'd. We leave it defaulting to the function creator's role.
CREATE OR REPLACE FUNCTION resolve_worker_client(p_client_id text, p_secret_hash text)
RETURNS TABLE (
  id              uuid,
  home_org_id     uuid,
  home_user_id    uuid,
  allowed_scopes  text[],
  default_ttl_seconds integer,
  is_active       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT w.id, w.home_org_id, w.home_user_id, w.allowed_scopes,
         w.default_ttl_seconds, w.is_active
  FROM worker_clients w
  WHERE w.client_id = p_client_id
    AND w.client_secret_hash = p_secret_hash
    AND w.is_active = true;

  UPDATE worker_clients SET last_mint_at = now()
  WHERE client_id = p_client_id AND client_secret_hash = p_secret_hash;
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_worker_client(text, text) TO command_center_app;
