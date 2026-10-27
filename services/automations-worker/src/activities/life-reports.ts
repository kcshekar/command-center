import { cc } from "../cc-client.js";
import { addDays, daysBetween, inr, todayIn } from "../money-dates.js";

// Life tracker reports, logged from phone-friendly pages; Slack only nudges
// and summarises. Arithmetic only. A null formatter result posts nothing.
//
//   R11 habits     21:00 daily: nudge for anything not logged today; Sundays add the week
//   R7  groceries  Saturday 08:00: the open list
//   R9  vehicle    Monday 09:00: service due (km or months); first week of a month adds fuel + km/L

// --- R11 -------------------------------------------------------------------

export interface HabitDays { name: string; done: string[] } // YYYY-MM-DD dates done

/** Consecutive done days ending today — or yesterday, so tonight isn't a "break" yet. */
export function streak(done: string[], today: string): number {
  const set = new Set(done);
  let day = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

export function formatHabits(habits: HabitDays[], today: string, weekly: boolean): string | null {
  if (habits.length === 0) return null;
  const lines: string[] = [];
  const pending = habits.filter((h) => !h.done.includes(today));
  if (pending.length) lines.push(`*Not logged yet today:* ${pending.map((h) => h.name).join(", ")}`);
  if (weekly) {
    const weekStart = addDays(today, -6);
    if (lines.length) lines.push("");
    lines.push("*Your week*");
    for (const h of habits) {
      const n = h.done.filter((d) => d >= weekStart && d <= today).length;
      const s = streak(h.done, today);
      lines.push(`• ${h.name} — ${n}/7${s >= 2 ? ` · ${s}-day streak` : ""}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

// --- R7 --------------------------------------------------------------------

export function formatGroceries(items: Array<{ name: string }>): string | null {
  if (items.length === 0) return null;
  return [`*Grocery list* (${items.length} item${items.length === 1 ? "" : "s"})`, ...items.map((i) => `• ${i.name}`)].join("\n");
}

// --- R9 --------------------------------------------------------------------

export interface VehicleLog { kind: "fuel" | "service"; on: string; odometerKm: number; litres: number | null; amountCents: number | null; fullTank: boolean }
export interface Vehicle { name: string; serviceEveryKm: number | null; serviceEveryMonths: number | null; logs: VehicleLog[] } // logs oldest → newest

export const SERVICE_WARN_KM = 500;
export const SERVICE_WARN_DAYS = 14;

/** km/L over consecutive full-tank fills whose closing fill is in [from, to]. */
export function kmPerLitre(logs: VehicleLog[], from: string, to: string): number | null {
  const fills = logs.filter((l) => l.kind === "fuel");
  let km = 0;
  let litres = 0;
  for (let i = 1; i < fills.length; i++) {
    const a = fills[i - 1];
    const b = fills[i];
    // A partial fill in between means the tank wasn't refilled to the same mark.
    if (!a.fullTank || !b.fullTank || !b.litres || b.on < from || b.on > to) continue;
    const d = b.odometerKm - a.odometerKm;
    if (d <= 0) continue;
    km += d;
    litres += b.litres;
  }
  return litres > 0 ? km / litres : null;
}

export function serviceStatus(v: Vehicle, today: string): string | null {
  const services = v.logs.filter((l) => l.kind === "service");
  const last = services[services.length - 1];
  if (!last || (!v.serviceEveryKm && !v.serviceEveryMonths)) return null;
  const odo = Math.max(...v.logs.map((l) => l.odometerKm));
  const reasons: string[] = [];
  if (v.serviceEveryKm) {
    const left = v.serviceEveryKm - (odo - last.odometerKm);
    if (left <= SERVICE_WARN_KM) reasons.push(left < 0 ? `${(-left).toLocaleString("en-IN")} km overdue` : `in ${left.toLocaleString("en-IN")} km`);
  }
  if (v.serviceEveryMonths) {
    const [y, m, d] = last.on.split("-").map(Number);
    const dueOn = new Date(Date.UTC(y, m - 1 + v.serviceEveryMonths, d)).toISOString().slice(0, 10);
    const left = daysBetween(today, dueOn);
    if (left <= SERVICE_WARN_DAYS) reasons.push(left < 0 ? `${-left} days overdue` : left === 0 ? "today" : `in ${left} days`);
  }
  return reasons.length ? `🔧 *${v.name}* service due — ${reasons.join(" / ")} (last on ${last.on} at ${last.odometerKm.toLocaleString("en-IN")} km)` : null;
}

export function formatVehicles(vehicles: Vehicle[], today: string): string | null {
  const lines = vehicles.map((v) => serviceStatus(v, today)).filter((x): x is string => !!x);
  if (Number(today.slice(8, 10)) <= 7) {
    const [y, m] = today.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const month = new Date(`${from}T12:00:00Z`).toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" });
    for (const v of vehicles) {
      const fuel = v.logs.filter((l) => l.kind === "fuel" && l.on >= from && l.on <= to);
      if (fuel.length === 0) continue;
      const spend = fuel.reduce((t, l) => t + (l.amountCents ?? 0), 0);
      const litres = fuel.reduce((t, l) => t + (l.litres ?? 0), 0);
      const kmpl = kmPerLitre(v.logs, from, to);
      lines.push(`⛽ *${v.name}* in ${month}: ${inr(spend)} on ${litres.toFixed(1)} L${kmpl ? ` · ${kmpl.toFixed(1)} km/L` : ""}`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

// --- activities --------------------------------------------------------------

type Input = { userId: string; routeKey: string; date?: string };

async function post(routeKey: string, text: string | null, tag: string) {
  if (!text) {
    console.log(`[${tag}] nothing to report`);
    return { posted: false };
  }
  await cc.notify(routeKey, text);
  return { posted: true };
}

export async function buildHabitCheckin(input: Input) {
  const today = input.date ?? todayIn();
  const weekly = new Date(`${today}T12:00:00Z`).getUTCDay() === 0; // Sunday
  return post(input.routeKey, formatHabits(await cc.lifeHabits(input.userId), today, weekly), "r11.habits");
}

export async function buildGroceryList(input: Input) {
  return post(input.routeKey, formatGroceries(await cc.lifeGroceries(input.userId)), "r7.groceries");
}

export async function buildVehicleReport(input: Input) {
  const today = input.date ?? todayIn();
  return post(input.routeKey, formatVehicles(await cc.lifeVehicles(input.userId), today), "r9.vehicle");
}
