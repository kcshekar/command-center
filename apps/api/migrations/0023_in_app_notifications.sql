-- B1: in-app notification queue. One row per delivered notification.
-- For simple one-way messages: just text + blocks + read_at.
-- For approvals: adds approval_* fields so the UI can render buttons and we
-- can round-trip the decision back to the worker's /callback/approval.

CREATE TABLE notifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_key          text NOT NULL,
  text               text NOT NULL,
  blocks             jsonb,                        -- optional Block Kit-like payload (reused for in-app rendering)

  -- Approval fields (null when the notification is one-way)
  is_approval        boolean NOT NULL DEFAULT false,
  approval_state     text,                         -- NULL | 'approved' | 'rejected' | 'expired'
  approval_action_id text,                         -- opaque identifier the worker uses to correlate the callback
  approval_workflow_id text,                       -- Temporal workflow id to update when approved/rejected
  approved_by        uuid REFERENCES users(id),
  approval_decided_at timestamptz,

  read_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_recipient_unread_idx
  ON notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX notifications_pending_approvals_idx
  ON notifications (recipient_user_id, created_at DESC)
  WHERE is_approval = true AND approval_state IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant ON notifications
  USING (
    org_id = current_setting('app.current_org_id', true)::uuid
    AND recipient_user_id = current_setting('app.current_user_id', true)::uuid
  );
