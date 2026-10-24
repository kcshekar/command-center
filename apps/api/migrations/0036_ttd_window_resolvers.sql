-- A10.3 — SECURITY DEFINER helpers for the worker's TTD prep poll.
--
--   list_due_ttd_windows   — windows whose release_at is in the imminent
--                            window and that we haven't recently pinged
--   mark_ttd_windows_notified — bump last_notified_at in bulk after Slack
--
-- Both bypass per-user RLS so one service-token call can span every user in
-- the org. The CC endpoint is already scope-gated (`ttd:read`); these are
-- the standard pattern for worker-side cross-user reads/writes.

CREATE OR REPLACE FUNCTION list_due_ttd_windows(
  p_org_id            uuid,
  p_release_cutoff    timestamptz,
  p_renotify_cutoff   timestamptz
)
RETURNS TABLE (
  window_id          uuid,
  user_id            uuid,
  darshan_date       date,
  slot_type          text,
  release_at         timestamptz,
  pilgrim_ids        uuid[],
  note               text,
  booking_ref        text,
  last_notified_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, user_id, darshan_date, slot_type, release_at, pilgrim_ids,
         note, booking_ref, last_notified_at
  FROM ttd_windows
  WHERE org_id      = p_org_id
    AND status      = 'planned'
    AND release_at IS NOT NULL
    AND release_at <= p_release_cutoff
    AND (last_notified_at IS NULL OR last_notified_at < p_renotify_cutoff)
  ORDER BY release_at ASC;
$$;

GRANT EXECUTE ON FUNCTION list_due_ttd_windows(uuid, timestamptz, timestamptz) TO command_center_app;


CREATE OR REPLACE FUNCTION mark_ttd_windows_notified(
  p_org_id uuid,
  p_ids    uuid[]
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE ttd_windows
    SET last_notified_at = now(), updated_at = now()
    WHERE org_id = p_org_id
      AND id = ANY(p_ids)
    RETURNING 1
  )
  SELECT count(*)::int FROM updated;
$$;

GRANT EXECUTE ON FUNCTION mark_ttd_windows_notified(uuid, uuid[]) TO command_center_app;
