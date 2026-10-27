// Renders a described Temporal schedule spec back to a human string.
// describe() normalises cron strings into calendar ranges, e.g.
//   "*/15 * * * *" → minute {0..59 step 15}, hour {0..23}
//   "0 9 * * 1,4"  → minute {0}, hour {9}, dayOfWeek [MONDAY, THURSDAY]
// Covers every shape init-schedules.ts creates; anything else → "custom".

type Range<T = number> = { start: T; end: T; step?: number };
interface Calendar {
  minute?: Range[];
  hour?: Range[];
  dayOfMonth?: Range[];
  dayOfWeek?: Range<string>[];
}
export interface CadenceSpec {
  intervals?: Array<{ every: number }>;
  calendars?: Calendar[];
}

const single = (r?: Range[]) => (r && r.length === 1 && r[0].start === r[0].end ? r[0].start : null);
const full = (r: Range[] | undefined, lo: number, hi: number) =>
  !r || r.length === 0 || (r.length === 1 && r[0].start === lo && r[0].end === hi && (r[0].step ?? 1) === 1);
const stepOver = (r: Range[] | undefined, lo: number, hi: number) =>
  r && r.length === 1 && r[0].start === lo && r[0].end === hi && (r[0].step ?? 1) > 1 ? r[0].step! : null;
const pad = (n: number) => String(n).padStart(2, "0");

export function formatCadence(spec: CadenceSpec): string {
  if (spec.intervals && spec.intervals.length > 0) {
    const secs = Math.round(spec.intervals[0].every / 1000);
    if (secs % 3600 === 0) return `Every ${secs / 3600}h`;
    if (secs % 60 === 0) return `Every ${secs / 60} min`;
    return `Every ${secs}s`;
  }
  const cal = spec.calendars?.length === 1 ? spec.calendars[0] : undefined;
  if (!cal) return "custom";

  const allDays = full(cal.dayOfMonth, 1, 31);
  const dow = cal.dayOfWeek ?? [];
  const allWeek = dow.length === 0 || (dow.length === 1 && dow[0].start === "SUNDAY" && dow[0].end === "SATURDAY");
  if (!allDays && !allWeek) return "custom";

  const m = single(cal.minute);
  const h = single(cal.hour);
  const minuteStep = stepOver(cal.minute, 0, 59);
  const hourStep = stepOver(cal.hour, 0, 23);

  let when: string | null = null;
  if (minuteStep && full(cal.hour, 0, 23)) when = `Every ${minuteStep} min`;
  else if (m !== null && full(cal.hour, 0, 23)) when = m === 0 ? "Hourly" : `Hourly at :${pad(m)}`;
  else if (m !== null && hourStep) when = `Every ${hourStep}h`;
  else if (m !== null && h !== null) when = `${pad(h)}:${pad(m)}`;
  else if (m !== null && cal.hour && cal.hour.every((r) => r.start === r.end)) {
    when = cal.hour.map((r) => `${pad(r.start)}:${pad(m)}`).join(" & ");
  }
  if (!when) return "custom";
  const clock = /^\d/.test(when);

  if (!allDays) {
    const d = single(cal.dayOfMonth);
    return d === null ? "custom" : `Monthly on day ${d}${clock ? ` at ${when}` : `, ${when.toLowerCase()}`}`;
  }
  if (!allWeek) {
    if (!dow.every((r) => r.start === r.end)) return "custom";
    const days = dow.map((r) => r.start.slice(0, 1) + r.start.slice(1, 3).toLowerCase()).join(", ");
    return `${days}${clock ? ` at ${when}` : `, ${when.toLowerCase()}`}`;
  }
  return clock ? `Daily at ${when}` : when;
}

const DOW = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

function parseField(f: string, lo: number, hi: number): Range[] | null {
  if (f === "*") return [{ start: lo, end: hi, step: 1 }];
  const step = f.match(/^\*\/(\d+)$/);
  if (step) return [{ start: lo, end: hi, step: Number(step[1]) }];
  const out: Range[] = [];
  for (const part of f.split(",")) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    out.push({ start: Number(m[1]), end: Number(m[2] ?? m[1]), step: 1 });
  }
  return out;
}

/**
 * Human cadence for a 5-field cron string or a catalog cadence_default
 * ("cron:…" | "event" | "manual"), via the same formatter as live schedules.
 */
export function cronCadence(expr: string | null | undefined): string {
  if (!expr) return "—";
  if (expr === "event") return "On event";
  if (expr === "manual") return "On demand";
  const fields = expr.replace(/^cron:/, "").trim().split(/\s+/);
  if (fields.length !== 5) return "custom";
  const [mi, h, dom, , dow] = fields;
  const minute = parseField(mi, 0, 59);
  const hour = parseField(h, 0, 23);
  const dayOfMonth = parseField(dom, 1, 31);
  const days = parseField(dow, 0, 6);
  if (!minute || !hour || !dayOfMonth || !days) return "custom";
  const dayOfWeek = dow === "*"
    ? [{ start: "SUNDAY", end: "SATURDAY", step: 1 }]
    : days.map((r) => ({ start: DOW[r.start % 7], end: DOW[r.end % 7], step: 1 }));
  return formatCadence({ calendars: [{ minute, hour, dayOfMonth, dayOfWeek }] });
}
