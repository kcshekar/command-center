// R1 — read a bank UPI / card debit SMS. Deterministic first (the common
// HDFC / SBI / ICICI / Axis / Kotak shapes); the caller falls back to the
// local model only when this returns null. Credits and OTPs are not expenses.

export interface UpiDebit {
  amountPaise: number;
  merchant: string | null;
  account: string | null;   // last digits, e.g. "1234"
  ref: string | null;       // 12-digit UPI reference, the idempotency key
}

const DEBIT = /\b(debited|sent|paid|spent|withdrawn|purchase)\b/i;
const NOT_EXPENSE = /\b(otp|one[- ]time password|will be debited|due on|request(ed)? (money|payment)|received)\b/i;

const AMOUNT = [
  /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  /debited (?:by|for)\s*([\d,]+(?:\.\d{1,2})?)/i, // SBI: "debited by 450.0"
];
const REF = /(?:upi\s*ref(?:erence)?(?:\s*no)?|ref(?:\s*no)?|refno|upi)[\s.:/-]*(\d{12})\b/i;
const MERCHANT = [
  /upi\/p2[am]\/\d+\/([^/\s]+)/i,                                   // Axis: UPI/P2M/1234…/SWIGGY
  /trf to\s+(.+?)\s+ref/i,                                          // SBI: "trf to SWIGGY Refno"
  /;\s*(.+?)\s+credited/i,                                          // ICICI: "; SWIGGY credited"
  /\bto\s+(?:vpa\s+)?([a-z0-9@._& -]{2,40}?)\s+(?:on|ref|via|upi|\(|\.)/i, // HDFC / Kotak: "To SWIGGY On…"
  /\bat\s+([a-z0-9@._& -]{2,40}?)\s+(?:on|ref|via|\.)/i,            // card spends: "at AMAZON on"
];
const ACCOUNT = /(?:a\/c|ac|acct|account|card)\s*(?:no\.?\s*)?(?:ending\s*)?[x*]*(\d{3,4})\b/i;

export function parseUpiDebit(text: string): UpiDebit | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!DEBIT.test(t) || NOT_EXPENSE.test(t)) return null;
  const amountMatch = AMOUNT.map((re) => t.match(re)).find(Boolean);
  if (!amountMatch) return null;
  const amountPaise = Math.round(parseFloat(amountMatch[1].replace(/,/g, "")) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return null;
  const merchantRaw = MERCHANT.map((re) => t.match(re)?.[1]).find(Boolean) ?? null;
  return {
    amountPaise,
    merchant: merchantRaw ? merchantRaw.trim().replace(/\s+/g, " ") : null,
    account: t.match(ACCOUNT)?.[1] ?? null,
    ref: t.match(REF)?.[1] ?? t.match(/\b(\d{12})\b/)?.[1] ?? null,
  };
}

// Small, obvious merchant → category map; anything else is "other" and can
// be re-categorised in Finance. Keys match anywhere in the merchant / VPA.
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/swiggy|zomato|eatsure|domino|mcdonald|kfc|starbucks|cafe|restaurant/i, "food"],
  [/bigbasket|blinkit|zepto|dmart|grocer|instamart|jiomart/i, "groceries"],
  [/uber|ola|rapido|irctc|redbus|metro|makemytrip|indigo|airline/i, "travel"],
  [/amazon|flipkart|myntra|ajio|meesho|nykaa/i, "shopping"],
  [/petrol|fuel|hpcl|iocl|bpcl|indianoil|shell/i, "fuel"],
  [/airtel|jio|vodafone|\bvi\b|bescom|electricity|broadband|act fibernet|gas/i, "utilities"],
  [/netflix|hotstar|spotify|prime ?video|youtube|bookmyshow|pvr/i, "entertainment"],
];
export function categoryFor(merchant: string | null): string {
  if (!merchant) return "other";
  return CATEGORY_HINTS.find(([re]) => re.test(merchant))?.[1] ?? "other";
}
