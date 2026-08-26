-- Password vault. Same zero-knowledge pattern as secrets projects: each item
-- gets its own DEK wrapped under the owner's master key, so rotating the
-- master password only needs to re-wrap DEKs, not re-encrypt every payload.
-- label/url are plaintext (list/search UX); username/password/notes are the
-- encrypted JSON payload.
CREATE TABLE vault_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  label         text NOT NULL,
  url           text,
  ciphertext    bytea NOT NULL,
  iv            bytea NOT NULL,
  wrapped_dek   bytea NOT NULL,
  wrap_iv       bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vault_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_items_tenant ON vault_items
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
