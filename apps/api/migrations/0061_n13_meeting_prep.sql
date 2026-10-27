-- N13: meeting prep, local context only (decision 2026-10-27). Every 30
-- minutes per pinned Google account; meetings starting 30–60 minutes out get
-- one prep note (each meeting falls in exactly one window). Solo blocks with
-- no other attendees are skipped.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, schedule_template) VALUES
  ('n13.meetings', 'Meeting prep',
   'About 30 minutes before each meeting with other people: who''s attending, the joining link, your related notes, and any interview session for that company. Nothing leaves your machine.',
   '{knowledge:read,interviews:read,slack:send}', 'cron:*/30 * * * *', 'career',
   '{"workflowType":"meetingPrepWorkflow","cron":"*/30 * * * *","perAccount":true,"args":{"userId":"$userId","userEmail":"$email","routeKey":"$digest"}}')
ON CONFLICT (id) DO NOTHING;
