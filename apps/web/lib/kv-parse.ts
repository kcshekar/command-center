// Direct parse attempt for the secrets import dialog — JSON first, then
// .env syntax. Returns null when neither matches, so the caller knows to
// fall back to Ollama for messier pasted text instead of silently
// importing zero secrets.
export function parseKeyValueText(text: string): Record<string, string> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const json = JSON.parse(trimmed);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const entries = Object.entries(json).filter(([, v]) => typeof v !== "object");
      if (entries.length > 0) return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
    }
  } catch {
    // not JSON — fall through to .env parsing
  }

  const pairs: Record<string, string> = {};
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const match = l.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    pairs[match[1]] = value;
  }
  return Object.keys(pairs).length > 0 ? pairs : null;
}
