import { apiFetch } from "./api";

// R3 — birthdays & anniversaries (owner-only; migration 0054).
export interface Occasion {
  id: string;
  person: string;
  relationship: string | null;
  kind: "birthday" | "anniversary" | "other";
  month: number;
  day: number;
  year: number | null;
  notes: string | null;
}
export type OccasionInput = Omit<Occasion, "id">;

export const occasionsApi = {
  list: () => apiFetch<Occasion[]>("/occasions"),
  create: (o: OccasionInput) => apiFetch<Occasion>("/occasions", { method: "POST", body: JSON.stringify(o) }),
  update: (id: string, o: OccasionInput) => apiFetch<Occasion>(`/occasions/${id}`, { method: "PUT", body: JSON.stringify(o) }),
  remove: (id: string) => apiFetch(`/occasions/${id}`, { method: "DELETE" }),
};
