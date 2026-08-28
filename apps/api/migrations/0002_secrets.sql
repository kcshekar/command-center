-- A Workspace is an independent zero-knowledge compartment: its own master
-- password, its own recovery key, its own projects/vault items. One login
-- (one user) can own many workspaces (e.g. "Personal", "CUVA", "Client X") —
-- there is no sharing between users, so access is simply "does this
-- workspace belong to the logged-in user," no RBAC/resource_grants involved.
--
-- The actual symmetric key that wraps every project/vault-item DEK is a
-- randomly generated "workspace key" — NOT derived directly from the
-- password. It's wrapped twice: once under a PBKDF2(password) key, once
-- under a separately random recovery key (shown to the user once at
-- creation, never stored in usable form). This indirection is what makes
-- both non-destructive password changes AND non-destructive recovery
-- possible — changing the password only re-wraps this one small key, never
-- the underlying secrets.
--
-- No canary needed: attempting to unwrap wrapped_key_by_password with the
-- wrong password-derived key fails outright (AES-GCM auth tag mismatch) —
-- that failure IS the password check.
CREATE TABLE workspaces (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  kdf_salt               bytea NOT NULL,
  kdf_iterations         int NOT NULL DEFAULT 210000,
  wrapped_key_by_password bytea NOT NULL,
  wrap_iv_password       bytea NOT NULL,
  wrapped_key_by_recovery bytea NOT NULL,
  wrap_iv_recovery       bytea NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  wrapped_dek   bytea NOT NULL,
  wrap_iv       bytea NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
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

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_self ON workspaces
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_workspace ON projects
  USING (EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = projects.workspace_id
      AND w.user_id = current_setting('app.current_user_id', true)::uuid
  ));

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
CREATE POLICY environments_workspace ON environments
  USING (EXISTS (
    SELECT 1 FROM projects p JOIN workspaces w ON w.id = p.workspace_id
    WHERE p.id = environments.project_id
      AND w.user_id = current_setting('app.current_user_id', true)::uuid
  ));

ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY secrets_workspace ON secrets
  USING (EXISTS (
    SELECT 1 FROM environments e
    JOIN projects p ON p.id = e.project_id
    JOIN workspaces w ON w.id = p.workspace_id
    WHERE e.id = secrets.environment_id
      AND w.user_id = current_setting('app.current_user_id', true)::uuid
  ));
