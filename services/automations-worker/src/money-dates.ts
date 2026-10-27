// When does a recurring bill fall due? Shared by N9 (bill forecaster) and
// R13 (subscriptions). Pure date math on "YYYY-MM-DD" strings in UTC so the
// worker's timezone can't shift a day.
//
//   monthly  due_day = day of month (clamped to short months: 31 → 30 Apr, 28/29 Feb)
//   yearly   due_month + due_day
//   weekly   due_day = ISO weekday, 1 = Monday … 7 = Sunday
// Missing fields → null (the bill can't be placed on a calendar).

export interface BillTiming {
  cadence: string;
  dueDay: number | null;
  dueMonth: number | null;
}

const toDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const at = (y: number, m0: number, day: number) => new Date(Date.UTC(y, m0, Math.min(day, daysIn(y, m0))));

/** Today's date (YYYY-MM-DD) in a timezone — schedules run on IST wall-clock. */
export function todayIn(tz = process.env.SCHEDULE_TIMEZONE ?? "Asia/Kolkata"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // en-CA → YYYY-MM-DD
}

export const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export function addDays(ymd: string, n: number): string {
  const d = toDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((toDate(toYmd).getTime() - toDate(fromYmd).getTime()) / 86_400_000);
}

/** First due date on or after `from`, or null when the bill lacks timing. */
export function nextDue(bill: BillTiming, from: string): string | null {
  const f = toDate(from);
  const y = f.getUTCFullYear();
  const m = f.getUTCMonth();
  if (bill.cadence === "monthly") {
    if (!bill.dueDay) return null;
    const c = at(y, m, bill.dueDay);
    return fmt(c >= f ? c : at(y, m + 1, bill.dueDay));
  }
  if (bill.cadence === "yearly") {
    if (!bill.dueDay || !bill.dueMonth) return null;
    const c = at(y, bill.dueMonth - 1, bill.dueDay);
    return fmt(c >= f ? c : at(y + 1, bill.dueMonth - 1, bill.dueDay));
  }
  if (bill.cadence === "weekly") {
    if (!bill.dueDay || bill.dueDay < 1 || bill.dueDay > 7) return null;
    const iso = ((f.getUTCDay() + 6) % 7) + 1; // Mon=1 … Sun=7
    return addDays(from, (bill.dueDay - iso + 7) % 7);
  }
  return null;
}

/** Every due date in [from, from + days]. */
export function dueWithin(bill: BillTiming, from: string, days: number): string[] {
  const end = addDays(from, days);
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < 60; i++) { // guard: weekly over 60 days is ~9
    const d = nextDue(bill, cursor);
    if (!d || d > end) break;
    out.push(d);
    cursor = addDays(d, 1);
  }
  return out;
}
