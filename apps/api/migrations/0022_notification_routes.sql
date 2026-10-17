-- B1: rename slack_routes → notification_routes, add channel_type.
-- slack_connections stays (Slack-specific bot/app token storage); only
-- route-level concepts generalize.
--
-- channel_type values:
--   'slack'  → connection_id references slack_connections, channel_id is a Slack channel ID
--   'in_app' → connection_id and channel_id are NULL; notifications land in CC's own notifications table
--
-- Legacy slack_routes rows are migrated with channel_type='slack'.

ALTER TABLE slack_routes RENAME TO notification_routes;

ALTER TABLE notification_routes
  ADD COLUMN channel_type text NOT NULL DEFAULT 'slack',
  ALTER COLUMN connection_id DROP NOT NULL,
  ALTER COLUMN channel_id    DROP NOT NULL;

-- Policy name follows the table name convention.
DROP POLICY IF EXISTS slack_routes_tenant     ON notification_routes;
DROP POLICY IF EXISTS slack_routes_isolation  ON notification_routes;
CREATE POLICY notification_routes_tenant ON notification_routes
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

-- Keep the per-org unique constraint on route_key under its new name.
ALTER INDEX IF EXISTS slack_routes_org_id_route_key_key RENAME TO notification_routes_org_id_route_key_key;
