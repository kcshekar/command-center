-- P2: personal vs business money, and personal rows private to their owner.
--
-- Before: accounts / expenses / recurring_bills were org-scoped only, so any
-- second org member saw everyone's spending, and worker-ingested expenses had
-- no owner at all.
--
--   zone           'personal' (private to owner_user_id) | 'professional'
--                  (shared with the org: projects, payroll, CA, tax side)
--   owner_user_id  who the row belongs to; personal rows are visible only to them
--
-- An expense's zone defaults from its account's zone at insert time (API), and
-- can be moved either way by its owner (D2). Existing rows become the org
-- owner's personal rows — every org has exactly one owner (verified 2026-10-27).

ALTER TABLE accounts
  ADD COLUMN owner_user_id uuid REFERENCES users(id),
  ADD COLUMN zone text NOT NULL DEFAULT 'personal' CHECK (zone IN ('personal', 'professional'));
ALTER TABLE expenses
  ADD COLUMN owner_user_id uuid REFERENCES users(id),
  ADD COLUMN zone text NOT NULL DEFAULT 'personal' CHECK (zone IN ('personal', 'professional'));
ALTER TABLE recurring_bills
  ADD COLUMN owner_user_id uuid REFERENCES users(id),
  ADD COLUMN zone text NOT NULL DEFAULT 'personal' CHECK (zone IN ('personal', 'professional'));

UPDATE accounts t        SET owner_user_id = u.id FROM users u WHERE u.org_id = t.org_id AND u.role = 'owner' AND t.owner_user_id IS NULL;
UPDATE expenses t        SET owner_user_id = u.id FROM users u WHERE u.org_id = t.org_id AND u.role = 'owner' AND t.owner_user_id IS NULL;
UPDATE recurring_bills t SET owner_user_id = u.id FROM users u WHERE u.org_id = t.org_id AND u.role = 'owner' AND t.owner_user_id IS NULL;

ALTER TABLE accounts        ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE expenses        ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE recurring_bills ALTER COLUMN owner_user_id SET NOT NULL;

CREATE INDEX expenses_owner_zone_idx ON expenses (owner_user_id, zone, occurred_on DESC);

-- Org match AND (shared business row OR my own row). Applies to reads and,
-- as the implicit WITH CHECK, to writes: you can't create a personal row for
-- someone else. Business rows stay owner/admin-only at the API layer.
DROP POLICY accounts_tenant ON accounts;
CREATE POLICY accounts_tenant ON accounts USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (zone = 'professional' OR owner_user_id = current_setting('app.current_user_id', true)::uuid)
);
DROP POLICY expenses_tenant ON expenses;
CREATE POLICY expenses_tenant ON expenses USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (zone = 'professional' OR owner_user_id = current_setting('app.current_user_id', true)::uuid)
);
DROP POLICY recurring_bills_tenant ON recurring_bills;
CREATE POLICY recurring_bills_tenant ON recurring_bills USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND (zone = 'professional' OR owner_user_id = current_setting('app.current_user_id', true)::uuid)
);

-- Inbox triage files expenses into the zone of the Gmail account it read
-- (grant.config.accounts[].zone, default personal) — "$zone" is filled per
-- account by core/automation-schedules.ts. Takes effect on the next toggle or
-- account save for already-created a5.mail schedules.
UPDATE automation_catalog
   SET schedule_template = jsonb_set(schedule_template, '{args,zone}', '"$zone"')
 WHERE id = 'a5.mail';
