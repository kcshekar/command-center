import type { BankParser, EmailInput, ParsedExpense } from "./types.js";

// HDFC Bank credit-card transaction alerts. Public alert format:
//   "Rs. 1,499.00 spent on HDFC Bank Card XX1234 at NETFLIX on 2026-09-25"
// Regex is intentionally loose on merchant name (any run of chars until "on ")
// and strict on numeric fields. Fixture-tested — see hdfc-credit.test.ts.

const ALERT_RE =
  /Rs\.\s*([\d,]+(?:\.\d{2})?)\s+spent\s+on\s+HDFC\s+Bank\s+Card\s+([A-Z0-9*x]+)\s+at\s+(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})/i;

function amountToCents(rupees: string): number {
  // "1,499.00" → 149900. Never floating: split on "." and multiply the whole
  // side by 100, then add zero-padded paise.
  const clean = rupees.replace(/,/g, "");
  const [whole, paise = "00"] = clean.split(".");
  const paisePadded = (paise + "00").slice(0, 2);
  return parseInt(whole, 10) * 100 + parseInt(paisePadded, 10);
}

// ponytail: crude keyword→category mapping — 5 buckets cover the common
// case. If the merchant doesn't hit any, category defaults to 'uncategorized'
// and the user can fix in CC.
function categoryFor(merchant: string): string {
  const m = merchant.toLowerCase();
  if (/netflix|prime|spotify|hotstar|youtube/.test(m)) return "subscription";
  if (/swiggy|zomato|uber\s*eats/.test(m)) return "food";
  if (/uber|ola|rapido|indigo|makemytrip/.test(m)) return "travel";
  if (/amazon|flipkart|myntra/.test(m)) return "shopping";
  return "uncategorized";
}

export const hdfcCreditParser: BankParser = {
  name: "hdfc-credit",

  matches(email: EmailInput): boolean {
    return /@hdfcbank\.net|alerts@hdfcbank/i.test(email.from) && /HDFC\s+Bank\s+Card/i.test(email.subject + " " + email.snippet);
  },

  parse(email: EmailInput): ParsedExpense | null {
    const text = `${email.subject}\n${email.snippet}\n${email.body ?? ""}`;
    const m = text.match(ALERT_RE);
    if (!m) return null;
    const [, amount, cardLast4, merchant, date] = m;
    return {
      amountCents: amountToCents(amount),
      currency: "INR",
      accountName: `HDFC Credit Card ${cardLast4}`,
      category: categoryFor(merchant),
      occurredOn: date,
    };
  },
};
