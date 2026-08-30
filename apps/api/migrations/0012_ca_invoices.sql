-- CA export invoices: generated on the fly from a fixed HTML/CSS template
-- (see modules/finance/ca-invoice-template.html) — no PDF bytes are stored,
-- only the fields needed to regenerate an identical PDF deterministically
-- and to keep the invoice-number sequence stable across re-downloads.

ALTER TABLE ledger_entries ADD COLUMN currency char(3) NOT NULL DEFAULT 'INR';
-- Manually entered actual bank-credited INR value for foreign-currency inward
-- entries — the FX conversion rate never matches what actually lands in the
-- account, so this is tracked separately rather than computed.
ALTER TABLE ledger_entries ADD COLUMN amount_inr_cents bigint;

CREATE TABLE ca_invoice_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  period_month    date NOT NULL,      -- first-of-month being reported
  recipient_email text NOT NULL,
  draft_subject   text NOT NULL,
  draft_body      text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  sent_at         timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ca_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES ledger_entries(id),
  invoice_number  text NOT NULL UNIQUE,
  invoice_date    date NOT NULL,
  currency        char(3) NOT NULL,
  amount_cents    bigint NOT NULL,
  batch_id        uuid REFERENCES ca_invoice_batches(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ca_invoice_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY ca_invoice_batches_tenant ON ca_invoice_batches USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE ca_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY ca_invoices_tenant ON ca_invoices USING (org_id = current_setting('app.current_org_id', true)::uuid);
