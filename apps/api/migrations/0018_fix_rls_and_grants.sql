-- Two systemic fixes that burned us during prod rollout:
--
-- 1. FORCE RLS on service_tokens was blocking the resolve_service_token
--    SECURITY DEFINER function. The function must run pre-tenant (no
--    app.current_org_id set), so the policy filters every row. Without FORCE,
--    the owner (migrator role) bypasses RLS naturally — which is what
--    SECURITY DEFINER + an owner-grant pattern expects. command_center_app is
--    still filtered by the policy, so the security property we actually care
--    about (restricted role can't read other orgs' tokens) is preserved.
--
-- 2. Table-level GRANTs for command_center_app weren't being set by default,
--    so every new table added by a migration needed a manual GRANT. Fix:
--    backfill existing tables and set ALTER DEFAULT PRIVILEGES so future
--    migrations never need the manual step.

ALTER TABLE service_tokens NO FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO command_center_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO command_center_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO command_center_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO command_center_app;
