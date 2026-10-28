// Local Ollama drafts the CA monthly-invoice cover email. Same "raw fetch,
// no SDK" approach as slack.ts — Ollama's HTTP API is small enough that a
// client library isn't worth the dependency.
export async function draftText(prompt: string): Promise<string> {
  const host = process.env.OLLAMA_HOST;
  const model = process.env.OLLAMA_MODEL;
  if (!host || !model) throw new Error("Ollama not configured (OLLAMA_HOST/OLLAMA_MODEL)");

  const res = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  return data.response.trim();
}

// Fallback for pasted config that isn't clean JSON or .env (e.g. copied out
// of a Slack message or a README) — used only when a direct parse already
// failed. `format: "json"` puts the model in JSON-constrained decoding mode
// so the response is reliably parseable instead of prose-wrapped.
export async function extractKeyValuePairs(text: string): Promise<Record<string, string>> {
  const host = process.env.OLLAMA_HOST;
  const model = process.env.OLLAMA_MODEL;
  if (!host || !model) throw new Error("Ollama not configured (OLLAMA_HOST/OLLAMA_MODEL)");

  const prompt = `Extract every configuration key and its value from the text below into a single flat JSON object mapping each key name (as it appears, e.g. DATABASE_URL) to its value as a string. Do not invent, guess, or rename keys. Respond with only the JSON object, no commentary.\n\nText:\n${text}`;

  const res = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, format: "json", stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.response);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Ollama did not return a flat key-value object");
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}

// R1 fallback: read a bank SMS the deterministic parser (core/upi-sms.ts)
// couldn't. JSON-constrained, then validated hard — a wrong amount is worse
// than no expense, so anything doubtful returns null.
export async function extractSmsDebit(text: string): Promise<{ amountPaise: number; merchant: string | null; category: string } | null> {
  const host = process.env.OLLAMA_HOST;
  const model = process.env.OLLAMA_MODEL;
  if (!host || !model) throw new Error("Ollama not configured (OLLAMA_HOST/OLLAMA_MODEL)");

  const prompt = `This is an SMS from a bank. Decide if it reports money that ALREADY LEFT the account (a debit / payment / purchase). Credits, OTPs, reminders and future or scheduled debits are NOT debits.
Respond with only JSON: {"isDebit": boolean, "amountRupees": number, "merchant": string or null, "category": one of "food","groceries","travel","shopping","fuel","utilities","entertainment","other"}.

SMS:
${text}`;
  const res = await fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, format: "json", stream: false, options: { temperature: 0 } }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const out = JSON.parse((await res.json()).response);
  if (out?.isDebit !== true) return null;
  const amount = Number(out.amountRupees);
  // The amount must literally appear in the SMS — guards against invented numbers.
  const digits = text.replace(/,/g, "");
  if (!Number.isFinite(amount) || amount <= 0 || !digits.includes(String(Math.trunc(amount)))) return null;
  const categories = ["food", "groceries", "travel", "shopping", "fuel", "utilities", "entertainment", "other"];
  return {
    amountPaise: Math.round(amount * 100),
    merchant: typeof out.merchant === "string" && out.merchant.trim() ? out.merchant.trim().slice(0, 80) : null,
    category: categories.includes(out.category) ? out.category : "other",
  };
}

// P2.0 — query side of hybrid knowledge search (nomic-embed-text, 768-dim,
// "search_query: " task prefix). null when Ollama is unset, down or slow, and
// search falls back to full-text only.
export const EMBED_DIM = 768;
export async function embedQuery(q: string): Promise<number[] | null> {
  const host = process.env.OLLAMA_HOST;
  if (!host) return null;
  try {
    const res = await fetch(`${host}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.EMBED_MODEL ?? "nomic-embed-text", input: `search_query: ${q}`, truncate: true }),
      signal: AbortSignal.timeout(5000), // a cold model load on CPU takes ~2s
    });
    if (!res.ok) return null;
    const v = ((await res.json()) as { embeddings?: number[][] }).embeddings?.[0];
    return Array.isArray(v) && v.length === EMBED_DIM ? v : null;
  } catch {
    return null;
  }
}
