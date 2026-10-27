// N12 — pure helpers shared by the CA invoices activity and workflow. No
// imports on purpose: workflow code may only load deterministic, I/O-free
// modules (Temporal sandbox).

export interface PreparedBatch {
  batchId: string;
  project: string;
  periodMonth: string;    // YYYY-MM
  invoiceCount: number;
  totals: string;         // "4200.00 USD, 300.00 EUR"
  recipientEmail: string; // "" when no batch was ever sent for the project
  subject: string;
  body: string;
}

/** YYYY-MM of the month before `today`. */
export function previousMonth(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const BODY_PREVIEW = 600;

/** Pure: the approval card for one batch (text + Slack blocks; buttons added by the workflow). */
export function caBatchCard(b: PreparedBatch): { text: string; summary: string } {
  const month = new Date(`${b.periodMonth}-01T12:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  const body = b.body.length > BODY_PREVIEW ? `${b.body.slice(0, BODY_PREVIEW)}…` : b.body;
  const summary = [
    `*${b.project} — ${month}*: ${b.invoiceCount} invoice${b.invoiceCount === 1 ? "" : "s"}, ${b.totals}`,
    `To: ${b.recipientEmail}`,
    `Subject: ${b.subject}`,
    "",
    body,
  ].join("\n");
  return { text: `CA invoices for ${month}: ${b.project} (${b.invoiceCount})`, summary };
}
