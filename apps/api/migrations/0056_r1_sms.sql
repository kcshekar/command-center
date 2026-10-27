-- R1: UPI / card SMS logger. Event-driven (the phone posts each bank SMS to
-- POST /api/integrations/sms), so no schedule — the catalog row gives it a
-- place in Automations and a setup page under Money.
INSERT INTO automation_catalog (id, name, description, required_scopes, cadence_default, area, ui_route, ui_label, icon) VALUES
  ('r1.sms', 'Bank SMS logger',
   'Your phone forwards bank SMS; debits become personal expenses (UPI ref prevents duplicates). Read by a fixed parser, with your local model as a fallback. Credits and OTPs are ignored.',
   '{expenses:write}', 'event', 'money', '/sms', 'Bank SMS', 'smartphone')
ON CONFLICT (id) DO NOTHING;
