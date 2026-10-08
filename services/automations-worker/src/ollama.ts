// JSON-schema classification (D6). temperature 0, format:"json" so parsing is
// deterministic. Ollama's cloud doesn't support structured outputs — must
// stay on the local instance.

const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

export type TriageCategory =
  | "promotional"
  | "transactional_bank"
  | "actionable_bill"
  | "personal_important"
  | "spam";

const SCHEMA = {
  type: "object",
  required: ["category", "confidence"],
  properties: {
    category: { type: "string", enum: ["promotional", "transactional_bank", "actionable_bill", "personal_important", "spam"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
} as const;

export interface Classification {
  category: TriageCategory;
  confidence: number;
  reason?: string;
}

export async function classifyEmail(subject: string, snippet: string, from: string): Promise<Classification> {
  const prompt = `Classify this email into EXACTLY ONE of these categories:

- transactional_bank: bank/credit-card alert confirming a transaction ALREADY HAPPENED. Trigger words: "spent", "debited", "credited", "withdrawn", "payment of Rs". Includes a specific amount + account/card number.
- actionable_bill: a bill or invoice DUE on a future date. Trigger words: "due on", "due date", "pay before", "statement for". Utility/telecom/credit-card bills.
- promotional: marketing, offers, discounts, newsletters.
- personal_important: human correspondence, OTPs, calendar invites, delivery updates.
- spam: unsolicited, phishing.

Output a JSON object with keys: category (one of the five strings above), confidence (0..1), reason (short phrase).

From: ${from}
Subject: ${subject}
Snippet: ${snippet}`;
  const parsed = await ollamaJson(prompt, SCHEMA);
  if (!SCHEMA.properties.category.enum.includes(parsed.category)) {
    throw new Error(`Ollama returned invalid category: ${parsed.category}`);
  }
  return parsed as Classification;
}

// Fallback expense extractor — only invoked when no deterministic parser
// matched. Prompt is intentionally strict: caller decides confidence
// threshold. Money always as integer paise.
export interface ExtractedExpense {
  amountCents: number;
  currency: string;
  accountName: string;
  category: string;
  occurredOn: string;
  confidence: number;
}
const EXPENSE_SCHEMA = {
  type: "object",
  required: ["amountCents", "currency", "accountName", "category", "occurredOn", "confidence"],
  properties: {
    amountCents: { type: "integer" },
    currency: { type: "string" },
    accountName: { type: "string" },
    category: { type: "string" },
    occurredOn: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;
export async function extractExpense(subject: string, snippet: string, from: string): Promise<ExtractedExpense | null> {
  const prompt = `Extract expense fields from this bank/credit-card transaction email.

Rules:
- amountCents: the transacted amount, as an INTEGER in paise. "Rs. 1,249.00" => 124900. "Rs. 1249" => 124900.
- currency: ISO code, usually "INR".
- accountName: short label like "HDFC Credit Card XX1234" or "ICICI Savings XX5678".
- category: one of "groceries", "food", "shopping", "travel", "utilities", "entertainment", "fuel", "other".
- occurredOn: transaction date in YYYY-MM-DD. If only time of day is given, use today's date in the email body.
- confidence: 0..1. Set to 0 if this is NOT a transaction alert (e.g. promotional, bill-due, not-you-alert).

From: ${from}
Subject: ${subject}
Body: ${snippet}`;
  const parsed = await ollamaJson(prompt, EXPENSE_SCHEMA);
  if (!parsed?.amountCents || !parsed?.occurredOn || (parsed.confidence ?? 0) < 0.7) return null;
  return parsed as ExtractedExpense;
}

// Bill extractor — pulls due date + total amount from an invoice email.
export interface ExtractedBill {
  title: string;
  dueOn: string;
  amountCents: number | null;
  confidence: number;
}
const BILL_SCHEMA = {
  type: "object",
  required: ["title", "dueOn", "confidence"],
  properties: {
    title: { type: "string" },
    dueOn: { type: "string" },
    amountCents: { type: ["integer", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;
export async function extractBill(subject: string, snippet: string, from: string): Promise<ExtractedBill | null> {
  const prompt = `Extract bill/invoice fields from this email.

Rules:
- title: short label like "BESCOM Electricity Bill" or "Airtel Postpaid Bill".
- dueOn: due date in YYYY-MM-DD.
- amountCents: integer in paise ("Rs. 2,340" => 234000). Use null if not stated.
- confidence: 0..1. Set to 0 if this is NOT a bill with a future due date.

From: ${from}
Subject: ${subject}
Body: ${snippet}`;
  const parsed = await ollamaJson(prompt, BILL_SCHEMA);
  if (!parsed?.dueOn || (parsed.confidence ?? 0) < 0.7) return null;
  return parsed as ExtractedBill;
}

async function ollamaJson(prompt: string, schema?: unknown): Promise<any> {
  const res = await fetch(`${HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt, format: schema ?? "json", options: { temperature: 0 }, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.response);
}
