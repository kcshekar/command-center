// Lets amount fields accept a simple arithmetic expression ("1200+350-40")
// instead of requiring the user to pre-compute it. The character whitelist
// runs before Function() ever sees the string, so only +-*/(). digits and
// whitespace can reach it — no arbitrary JS can execute through this.
export function evalAmountExpression(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed || !/^[0-9+\-*/().\s]+$/.test(trimmed)) return null;
  try {
    const result = Function(`"use strict"; return (${trimmed});`)();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

// Called on blur of an amount field: resolves an expression down to a plain
// number string, or returns the input unchanged if it isn't a valid one
// (e.g. still mid-typing, or already a plain number).
export function resolveAmountInput(raw: string): string {
  const value = evalAmountExpression(raw);
  return value === null ? raw : String(Math.round(value * 100) / 100);
}
