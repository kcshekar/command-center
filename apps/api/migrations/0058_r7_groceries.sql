-- R7: a shared-by-nobody running grocery list (private to the owner).
CREATE TABLE grocery_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  done          boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE INDEX grocery_items_owner_open_idx ON grocery_items (owner_user_id) WHERE NOT done;
ALTER TABLE grocery_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY grocery_items_owner ON grocery_items USING (
  org_id = current_setting('app.current_org_id', true)::uuid
  AND owner_user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON grocery_items TO command_center_app;

-- Saturday 08:00: the open list, so it's in Slack when you head out.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, ui_route, ui_label, icon, schedule_template) VALUES
  ('r7.groceries', 'Grocery list',
   'Add items from your phone through the week; every Saturday at 08:00 the open list is posted so it''s handy at the shop.',
   '{life:read,slack:send}', 'cron:0 8 * * 6', 'life', '/groceries', 'Groceries', 'shopping-cart',
   '{"workflowType":"groceryListWorkflow","cron":"0 8 * * 6","args":{"userId":"$userId","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
