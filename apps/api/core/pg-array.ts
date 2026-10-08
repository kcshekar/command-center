// Build a Postgres array literal from a JS array of strings. Needed because
// Bun.sql serializes a plain JS array as CSV, which Postgres can't parse
// as a text[] value (fails on any char it treats specially, e.g. ':' in
// Slack scopes). Pair with ::text[] in the SQL so Postgres parses the
// literal unambiguously.
//   textArrayLiteral(["chat:write", "a,b"])  =>  '{"chat:write","a,b"}'
export function textArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
