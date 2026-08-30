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
