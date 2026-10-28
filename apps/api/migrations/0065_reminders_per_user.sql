-- Reminders become per-user: a reminder is visible only to the user it was
-- created for (created_by). Web creates as the signed-in user; the worker
-- creates as the schedule's user (or the token's user when none is given).
-- Every existing row was created by its org's owner, so no backfill.
-- No zone here (unlike finance): a reminder is always someone's own nudge.
DROP POLICY reminders_tenant ON reminders;
CREATE POLICY reminders_tenant ON reminders USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND created_by = current_setting('app.current_user_id', true)::uuid
);
CREATE INDEX reminders_owner_due_idx ON reminders (created_by, due_on);
