-- A6 Phase 2.6: SECURITY DEFINER list of watches due for a daily poll.
--
-- The service-token-authenticated poll runs as the worker's home_user. Per-user
-- RLS on price_watches would hide every other user's rows, so we go through a
-- resolver function that bypasses RLS for the single org we trust the caller
-- to belong to (CC verifies the token's org before calling).
--
-- Returns the minimum payload the worker needs to call Keepa: nothing beyond
-- what the initial-fetch workflow already receives.

CREATE OR REPLACE FUNCTION list_due_price_watches(p_org_id uuid, p_cutoff timestamptz)
RETURNS TABLE (
  watch_id    uuid,
  user_id     uuid,
  source      text,
  external_id text,
  url         text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, user_id, source, external_id, url
  FROM price_watches
  WHERE org_id = p_org_id
    AND paused = false
    AND (last_checked_at IS NULL OR last_checked_at < p_cutoff);
$$;

GRANT EXECUTE ON FUNCTION list_due_price_watches(uuid, timestamptz) TO command_center_app;
