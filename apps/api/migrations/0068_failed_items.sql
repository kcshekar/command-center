-- P1.0: dead-letter queue for external API failures the worker used to drop
-- with a console.warn (Adzuna/SerpAPI/JSearch 429s, learning-feed 5xx, ...).
-- One open row per (owner, automation, item_type, source_id): a repeat failure
-- bumps attempts instead of stacking. payload is what's needed to replay.
-- Read/retry UI lands with the Phase 3 /health page.
CREATE TABLE failed_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  automation_id  text NOT NULL,                -- catalog id: 'a2.jobs', 'a8.learning'
  item_type      text NOT NULL,                -- 'job_search', 'learning_feed'
  source_id      text NOT NULL DEFAULT '',
  payload        jsonb NOT NULL,
  error_code     text,                         -- 'ADZUNA_429', 'GITHUB_503', 'NETWORK'
  error_message  text,
  attempts       int NOT NULL DEFAULT 1,
  failed_at      timestamptz NOT NULL DEFAULT now(),
  retry_after    timestamptz,
  resolved_at    timestamptz
);
CREATE UNIQUE INDEX failed_items_open_uq ON failed_items (owner_user_id, automation_id, item_type, source_id)
  WHERE resolved_at IS NULL;
CREATE INDEX failed_items_owner_open_idx ON failed_items (owner_user_id, failed_at DESC) WHERE resolved_at IS NULL;
ALTER TABLE failed_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY failed_items_owner ON failed_items USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON failed_items TO command_center_app;

-- The worker mints every scope in ALL_SCOPES; a missing one is a 403 on every
-- call (see 0066), so grant failures:write to every worker client up front.
UPDATE worker_clients
   SET allowed_scopes = array_append(allowed_scopes, 'failures:write')
 WHERE NOT ('failures:write' = ANY(allowed_scopes));
