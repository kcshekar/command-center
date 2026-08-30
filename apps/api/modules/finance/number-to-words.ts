const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ""));
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

// Whole-number-to-words, international grouping (thousand/million/billion) —
// good up to 999,999,999,999. Amounts here are always rounded to whole
// currency units before conversion.
export function numberToWords(n: number): string {
  if (n === 0) return "zero";
  const groups = ["", " thousand", " million", " billion"];
  const chunks: number[] = [];
  let rest = Math.floor(n);
  while (rest > 0) {
    chunks.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  const words = chunks
    .map((chunk, i) => (chunk === 0 ? "" : threeDigitsToWords(chunk) + groups[i]))
    .filter(Boolean)
    .reverse();
  return words.join(" ");
}

const CURRENCY_WORDS: Record<string, string> = {
  USD: "dollars",
  EUR: "euros",
  INR: "rupees",
};

export function amountInWords(amountCents: number, currency: string): string {
  const whole = Math.round(amountCents / 100);
  const words = numberToWords(whole);
  const capitalized = words.charAt(0).toUpperCase() + words.slice(1);
  const currencyWord = CURRENCY_WORDS[currency] ?? currency.toLowerCase();
  return `${capitalized} ${currencyWord} only (${currency})`;
}
