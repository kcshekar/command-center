-- Password vault. Same zero-knowledge pattern as secrets projects, now
-- scoped by workspace instead of user: each item gets its own DEK wrapped
-- under its workspace's key, so changing that workspace's password only
-- re-wraps the workspace key, not every item.
-- label/url are plaintext (list/search UX); username/password/notes are the
-- encrypted JSON payload.
CREATE TABLE vault_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
CREATE POLICY vault_items_workspace ON vault_items
  USING (EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = vault_items.workspace_id
      AND w.user_id = current_setting('app.current_user_id', true)::uuid
  ));
