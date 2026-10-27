-- Fix: in-app approval copies never left "pending" when the decision came
-- from Slack or the 24h window expired.
--
-- Root cause: notifications RLS requires app.current_user_id =
-- recipient_user_id, but the Slack socket handler only sets the org GUC, so
-- its settle UPDATE matched zero rows silently. Same pattern as
-- list_due_price_watches (0030): a SECURITY DEFINER function scoped to the
-- one org CC already verified. (Worker-driven settles — expiry, and the final
-- status after Slack/in-app clicks — go through notify-update's
-- approvalState, which runs inside the token owner's tenant tx.)

CREATE OR REPLACE FUNCTION settle_in_app_approval(
  p_org_id      uuid,
  p_workflow_id text,
  p_action_id   text,
  p_state       text
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH upd AS (
    UPDATE notifications
       SET approval_state      = p_state,
           approval_decided_at = now(),
           read_at             = COALESCE(read_at, now())
     WHERE org_id = p_org_id
       AND is_approval = true
       AND approval_workflow_id = p_workflow_id
       AND approval_action_id = p_action_id
       AND approval_state IS NULL
       AND p_state IN ('approved', 'rejected', 'expired')
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$$;

GRANT EXECUTE ON FUNCTION settle_in_app_approval(uuid, text, text, text) TO command_center_app;

-- One-time backfill for rows already stuck. Their text was rewritten by the
-- worker with the final outcome, which is the only record of it.
UPDATE notifications
   SET approval_state = CASE
         WHEN text LIKE '✅%' OR text LIKE '⚠️ Send failed%' THEN 'approved'
         WHEN text LIKE '❌%' THEN 'rejected'
         ELSE 'expired'
       END,
       approval_decided_at = COALESCE(approval_decided_at, now()),
       read_at = COALESCE(read_at, now())
 WHERE is_approval = true
   AND approval_state IS NULL
   AND (text LIKE '✅%' OR text LIKE '❌%' OR text LIKE '⌛%' OR text LIKE '⚠️ Send failed%'
        OR created_at < now() - INTERVAL '25 hours');
