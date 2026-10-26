-- A4 — SECURITY DEFINER helpers so the worker's /interview-rounds/due and
-- /notified endpoints can scan across every user in an org without juggling
-- per-user RLS GUCs. Same shape as list_due_price_watches / list_due_ttd_windows.

CREATE OR REPLACE FUNCTION list_due_interview_rounds(
  p_org_id          uuid,
  p_window_upper    timestamptz,
  p_renotify_cutoff timestamptz
)
RETURNS TABLE (
  round_id          uuid,
  session_id        uuid,
  user_id           uuid,
  kind              text,
  scheduled_at      timestamptz,
  duration_min      int,
  interviewer       text,
  notes             text,
  company           text,
  role              text,
  last_notified_at  text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.session_id, r.user_id,
         r.kind, r.scheduled_at, r.duration_min,
         r.interviewer, r.notes,
         s.company, s.role,
         r.metadata->>'notifiedAt'
  FROM interview_rounds r
  JOIN interview_sessions s ON s.id = r.session_id
  WHERE r.org_id       = p_org_id
    AND r.outcome      IS NULL
    AND r.scheduled_at IS NOT NULL
    AND r.scheduled_at >  now()
    AND r.scheduled_at <= p_window_upper
    AND (
      r.metadata->>'notifiedAt' IS NULL
      OR (r.metadata->>'notifiedAt')::timestamptz < p_renotify_cutoff
    )
  ORDER BY r.scheduled_at ASC;
$$;

GRANT EXECUTE ON FUNCTION list_due_interview_rounds(uuid, timestamptz, timestamptz) TO command_center_app;


CREATE OR REPLACE FUNCTION mark_interview_rounds_notified(p_org_id uuid, p_ids uuid[])
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE interview_rounds
    SET metadata   = metadata || jsonb_build_object('notifiedAt', to_jsonb(now()::text)),
        updated_at = now()
    WHERE org_id = p_org_id
      AND id = ANY(p_ids)
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$$;

GRANT EXECUTE ON FUNCTION mark_interview_rounds_notified(uuid, uuid[]) TO command_center_app;
