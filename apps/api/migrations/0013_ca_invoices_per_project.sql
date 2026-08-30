-- Reverts the 0011 relaxation: ledger entries only ever belong to one
-- project again. Company-wide money (bank interest, owner draws) now lives
-- under a project the org creates for that purpose, same as any client.
-- Any pre-existing NULL-project entries must be reassigned to a real
-- project before this runs, or the NOT NULL below fails loudly.
ALTER TABLE ledger_entries ALTER COLUMN finance_project_id SET NOT NULL;

-- CA invoice generation is now scoped to one project's ledger per call
-- (previously it only ever read the NULL/company-wide bucket, so a single
-- period_month draft was implicitly "the" batch). Recording which project a
-- batch was generated from prevents two different projects' invoices in the
-- same month from being silently merged into one draft.
ALTER TABLE ca_invoice_batches ADD COLUMN finance_project_id uuid REFERENCES finance_projects(id) ON DELETE CASCADE;

UPDATE ca_invoice_batches b SET finance_project_id = (
  SELECT le.finance_project_id
  FROM ca_invoices ci JOIN ledger_entries le ON le.id = ci.ledger_entry_id
  WHERE ci.batch_id = b.id
  LIMIT 1
);

ALTER TABLE ca_invoice_batches ALTER COLUMN finance_project_id SET NOT NULL;
