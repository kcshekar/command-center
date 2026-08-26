-- Zone B: server-readable, standard at-rest encryption (disk-level via
-- Postgres/volume encryption), not client-side ZK — needed for aggregation
-- and charts. All money as integer cents (bigint) — never floating point.

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('bank','credit_card','loan','investment','cash'))
);

CREATE TABLE recurring_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  currency      char(3) NOT NULL DEFAULT 'INR',
  cadence       text NOT NULL CHECK (cadence IN ('monthly','yearly','weekly')),
  due_day       int,               -- day-of-month/week; feeds the reminder engine later
  category      text NOT NULL,     -- 'subscription'|'insurance'|'loan'|'utility'
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  account_id    uuid REFERENCES accounts(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      char(3) NOT NULL DEFAULT 'INR',
  category      text NOT NULL,
  occurred_on   date NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Distinct from the zero-knowledge `projects` table (secrets module) —
-- optionally linked so "CUVA" the finance ledger can point at "CUVA" the
-- secrets project, but the two are independent resources with independent
-- RBAC (a contractor could be granted one without the other).
CREATE TABLE finance_projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  owner_id            uuid NOT NULL REFERENCES users(id),
  secrets_project_id  uuid REFERENCES projects(id),
  name                text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  finance_project_id  uuid NOT NULL REFERENCES finance_projects(id),
  direction           text NOT NULL CHECK (direction IN ('inward','outward')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  counterparty        text NOT NULL,
  occurred_on         date NOT NULL,
  note                text,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  user_id           uuid REFERENCES users(id),
  name              text NOT NULL,
  employment_type   text NOT NULL DEFAULT 'part_time',
  hourly_rate_cents bigint,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ca_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  purpose       text,
  paid_on       date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tax_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  tax_year      int NOT NULL,
  category      text NOT NULL,      -- 'gst'|'income_tax'|'advance_tax'
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  paid_on       date,
  ca_payment_id uuid REFERENCES ca_payments(id)
);

-- gross/tax/net enforced consistent by CHECK, not just app code — a bad write
-- from any client is rejected by the database itself.
CREATE TABLE payroll_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  employee_id         uuid NOT NULL REFERENCES employees(id),
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  gross_cents         bigint NOT NULL CHECK (gross_cents >= 0),
  tax_withheld_cents  bigint NOT NULL DEFAULT 0 CHECK (tax_withheld_cents >= 0),
  net_cents           bigint NOT NULL,
  paid_at             timestamptz,
  ledger_entry_id     uuid REFERENCES ledger_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (net_cents = gross_cents - tax_withheld_cents)
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant ON accounts USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE recurring_bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY recurring_bills_tenant ON recurring_bills USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_tenant ON expenses USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE finance_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_projects_tenant ON finance_projects USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_entries_tenant ON ledger_entries USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY employees_tenant ON employees USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE ca_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ca_payments_tenant ON ca_payments USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE tax_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tax_records_tenant ON tax_records USING (org_id = current_setting('app.current_org_id', true)::uuid);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_tenant ON payroll_runs USING (org_id = current_setting('app.current_org_id', true)::uuid);
