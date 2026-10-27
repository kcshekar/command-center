import { apiFetch } from "./api";

// Life trackers (R11 habits, R7 groceries, R9 vehicles). Owner-only.

export interface Habit { id: string; name: string; active: boolean; done: string[] } // done = YYYY-MM-DD dates
export interface GroceryItem { id: string; name: string; done: boolean; created_at: string; done_at: string | null }
export interface VehicleLog {
  id: string; kind: "fuel" | "service"; logged_on: string; odometer_km: number;
  litres: number | null; amount_cents: number | null; full_tank: boolean; notes: string | null;
}
export interface Vehicle { id: string; name: string; service_every_km: number | null; service_every_months: number | null; logs: VehicleLog[] }

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const lifeApi = {
  habits: (days = 56) => apiFetch<Habit[]>(`/habits?days=${days}`),
  addHabit: (name: string) => apiFetch<Habit>("/habits", { method: "POST", ...json({ name }) }),
  updateHabit: (id: string, patch: { name?: string; active?: boolean }) => apiFetch(`/habits/${id}`, { method: "PATCH", ...json(patch) }),
  deleteHabit: (id: string) => apiFetch(`/habits/${id}`, { method: "DELETE" }),
  logHabit: (id: string, on: string, done: boolean) => apiFetch(`/habits/${id}/log`, { method: "PUT", ...json({ on, done }) }),

  groceries: () => apiFetch<GroceryItem[]>("/groceries"),
  addGroceries: (text: string) => apiFetch<GroceryItem[]>("/groceries", { method: "POST", ...json({ text }) }),
  setGroceryDone: (id: string, done: boolean) => apiFetch<GroceryItem>(`/groceries/${id}`, { method: "PATCH", ...json({ done }) }),
  deleteGrocery: (id: string) => apiFetch(`/groceries/${id}`, { method: "DELETE" }),

  vehicles: () => apiFetch<Vehicle[]>("/vehicles"),
  addVehicle: (v: { name: string; serviceEveryKm?: number | null; serviceEveryMonths?: number | null }) =>
    apiFetch<{ id: string }>("/vehicles", { method: "POST", ...json(v) }),
  deleteVehicle: (id: string) => apiFetch(`/vehicles/${id}`, { method: "DELETE" }),
  addVehicleLog: (vehicleId: string, log: { kind: "fuel" | "service"; on: string; odometerKm: number; litres?: number | null; amountCents?: number | null; fullTank?: boolean; notes?: string | null }) =>
    apiFetch(`/vehicles/${vehicleId}/logs`, { method: "POST", ...json(log) }),
  deleteVehicleLog: (id: string) => apiFetch(`/vehicle-logs/${id}`, { method: "DELETE" }),
};

/** Local date as YYYY-MM-DD (the user's day, not UTC's). */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
