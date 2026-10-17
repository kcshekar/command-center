-- B2: allow multiple channels per route_key (fan-out). A single route_key can
-- post to both Slack and the in-app bell. Each (route_key, channel_type) pair
-- is still unique, so you can't accidentally create two slack rows for the
-- same key.

ALTER TABLE notification_routes
  DROP CONSTRAINT IF EXISTS notification_routes_org_id_route_key_key;

ALTER TABLE notification_routes
  ADD CONSTRAINT notification_routes_org_id_route_key_channel_type_key
    UNIQUE (org_id, route_key, channel_type);
