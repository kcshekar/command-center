-- Existing workspaces stay on PBKDF2 (kdf_iterations already holds their
-- iteration count); new workspaces and any password change/recovery on an
-- old workspace switch to Argon2id, using kdf_iterations as time cost and
-- kdf_memory_kib as memory cost.
ALTER TABLE workspaces
  ADD COLUMN kdf_algorithm text NOT NULL DEFAULT 'pbkdf2',
  ADD COLUMN kdf_memory_kib int;
