-- Standalone reminders — not tied to a specific insurance/loan/vehicle table
-- (none exist; the brief only asks to be alerted about these, not to manage
-- them as separate entities). resource_type/resource_id are optional so a
-- reminder CAN point at e.g. a recurring_bill, but doesn't have to.
CREATE TABLE reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  title         text NOT NULL,
  category      text NOT NULL CHECK (category IN ('bill','insurance','loan','credit_card','vehicle','other')),
  resource_type text,
  resource_id   uuid,
  due_on        date NOT NULL,
  recurrence    text CHECK (recurrence IN ('weekly','monthly','yearly')), -- null = one-off
  notified_at   timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON reminders (due_on);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
CREATE POLICY reminders_tenant ON reminders
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
