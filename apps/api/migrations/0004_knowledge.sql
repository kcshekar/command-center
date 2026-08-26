-- Shared team knowledge base: no per-resource RBAC (unlike secrets/vault) —
-- any org member can read/write, org-level RLS is enough. This matches the
-- feature's intent (a shared command reference), not a locked-down resource.
CREATE TABLE kb_commands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  title         text NOT NULL,
  command_text  text NOT NULL,
  context       text,
  notes         text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kb_comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  command_id    uuid NOT NULL REFERENCES kb_commands(id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users(id),
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Generic across modules (resource_type + resource_id, no FK) so any future
-- module can attach files without a schema change here. Server only ever
-- stores the object key + metadata — the binary goes straight to GCS via a
-- pre-signed URL, never through this process.
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  object_key    text NOT NULL,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_resource_idx ON attachments (resource_type, resource_id);

ALTER TABLE kb_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY kb_commands_tenant ON kb_commands
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE kb_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY kb_comments_tenant ON kb_comments
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_tenant ON attachments
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
