-- Zero-knowledge vault-unlock config, one per user. kdf_salt + canary let the
-- client verify a master password locally (derive key, try to decrypt the
-- canary) without ever sending the password or key to the server.
CREATE TABLE user_vault_config (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf_salt          bytea NOT NULL,
  kdf_iterations    int NOT NULL DEFAULT 210000,
  canary_ciphertext bytea NOT NULL,
  canary_iv         bytea NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- A project's DEK is wrapped under exactly one user's master key (owner_id) —
-- true zero-knowledge sharing across users needs per-recipient (asymmetric)
-- key wrapping, which is out of scope here. A single operator managing their
-- own projects (the stated use case) doesn't need it; org-mates can be
-- granted metadata/RBAC access via resource_grants but can't decrypt secrets
-- without the owner's master password.
CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  owner_id      uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  wrapped_dek   bytea NOT NULL,
  wrap_iv       bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  UNIQUE (project_id, name)
);

-- ciphertext already includes the AES-GCM auth tag (SubtleCrypto.encrypt
-- appends it) — no separate auth_tag column needed.
CREATE TABLE secrets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key_label      text NOT NULL,
  ciphertext     bytea NOT NULL,
  iv             bytea NOT NULL,
  version        int NOT NULL DEFAULT 1,
  updated_by     uuid NOT NULL REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, key_label)
);

ALTER TABLE user_vault_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_config_self ON user_vault_config
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant ON projects
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
CREATE POLICY environments_tenant ON environments
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = environments.project_id
      AND p.org_id = current_setting('app.current_org_id', true)::uuid
  ));

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY secrets_tenant ON secrets
  USING (EXISTS (
    SELECT 1 FROM environments e JOIN projects p ON p.id = e.project_id
    WHERE e.id = secrets.environment_id
      AND p.org_id = current_setting('app.current_org_id', true)::uuid
  ));
