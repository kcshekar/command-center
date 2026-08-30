-- Lets a ledger entry stand alone as a company-wide inward/outward record
-- (e.g. bank interest, owner draws) instead of always belonging to a client
-- project. Existing per-project entries are unaffected — this only widens
-- what's allowed, it doesn't touch existing rows.
ALTER TABLE ledger_entries ALTER COLUMN finance_project_id DROP NOT NULL;
