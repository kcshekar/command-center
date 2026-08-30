-- Single-invoice sends (email, no batch involved) need their own sent
-- tracking — sent_at previously only existed on ca_invoice_batches, which
-- doesn't apply to an invoice sent standalone outside any batch.
ALTER TABLE ca_invoices ADD COLUMN sent_at timestamptz;
ALTER TABLE ca_invoices ADD COLUMN recipient_email text;
