import type { BankParser, EmailInput, ParsedExpense } from "./types.js";
import { hdfcCreditParser } from "./hdfc-credit.js";

// Registry order matters only in the vanishingly rare case where two parsers
// both match a single email — bank-specific senders keep that unlikely.
// Add new banks: create a file, import + push here.
const PARSERS: BankParser[] = [hdfcCreditParser];

export function parseExpenseEmail(email: EmailInput): { parser: string; expense: ParsedExpense } | null {
  for (const p of PARSERS) {
    if (!p.matches(email)) continue;
    const expense = p.parse(email);
    if (expense) return { parser: p.name, expense };
  }
  return null;
}

export type { EmailInput, ParsedExpense, BankParser };
