-- The worker requests its whole scope list (cc-client ALL_SCOPES) on every
-- mint, and a mint that names any scope outside allowed_scopes is a 403 — so
-- one missing scope breaks every worker call. Earlier migrations only added
-- a new scope to clients already holding a related one, which skipped worker
-- clients created before those features (prod's held just the original 4).
-- Grant the full set to every worker client; existing scopes are kept.
-- Keep this list in sync with ALLOWED_SCOPES (worker-clients routes) and
-- ALL_SCOPES (worker cc-client).
UPDATE worker_clients
   SET allowed_scopes = ARRAY(
         SELECT DISTINCT s FROM unnest(allowed_scopes || ARRAY[
           'slack:send', 'reminders:read', 'reminders:write',
           'expenses:write', 'expenses:read', 'occasions:read', 'life:read',
           'travel:write', 'invoices:write', 'prices:write', 'prices:read',
           'credentials:read', 'pilgrim:read', 'ttd:read',
           'knowledge:read', 'knowledge:write', 'prompts:read', 'learning:read',
           'profile:read', 'jobs:read', 'jobs:write',
           'interviews:read', 'interviews:write', 'events:write'
         ]::text[]) AS s ORDER BY s);
