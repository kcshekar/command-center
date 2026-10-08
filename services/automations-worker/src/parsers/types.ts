// Deterministic bank alert email → expense record. Each bank gets its own
// parser file that exports one BankParser. Registry in ./index.ts iterates
// them and stops at the first match; falls back to Ollama-based extraction
// only if none match.

export interface EmailInput {
  from: string;
  subject: string;
  snippet: string;
  body?: string; // if the caller fetched it; parsers may not need it
}

export interface ParsedExpense {
  amountCents: number;
  currency: string;
  accountName: string;
  category: string;
  occurredOn: string; // YYYY-MM-DD
}

export interface BankParser {
  name: string;
  matches(email: EmailInput): boolean;
  parse(email: EmailInput): ParsedExpense | null;
}
