import { apiFetch } from "./api";

export const GENDERS = ["male", "female", "other"] as const;
export const ID_TYPES = ["aadhaar", "passport", "voter_id", "driving_license"] as const;
export const RELATIONSHIPS = ["self", "spouse", "parent", "child", "other"] as const;

export interface PilgrimPii {
  dob?: string;
  idNumber?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface Pilgrim {
  id: string;
  fullName: string;
  gender: string | null;
  idType: string | null;
  relationship: string;
  note: string | null;
  metadata: Record<string, unknown>;
  pii: PilgrimPii;
  createdAt: string;
  updatedAt: string;
}

export interface PilgrimInput {
  fullName: string;
  gender?: string | null;
  idType?: string | null;
  relationship?: string;
  note?: string | null;
  pii?: PilgrimPii;
}

export const pilgrimsApi = {
  list: () => apiFetch<Pilgrim[]>("/pilgrim-identities"),
  create: (input: PilgrimInput) =>
    apiFetch<Pilgrim>("/pilgrim-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  update: (id: string, input: Partial<PilgrimInput>) =>
    apiFetch<Pilgrim>(`/pilgrim-identities/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    apiFetch(`/pilgrim-identities/${id}`, { method: "DELETE" }),
};

export const SLOT_TYPES = ["ssd", "vip_break", "suprabhatam", "archana", "kalyanam", "other"] as const;
export const TTD_STATUSES = ["planned", "booked", "missed", "cancelled"] as const;

export interface TtdWindow {
  id: string;
  darshanDate: string;
  slotType: string;
  releaseAt: string | null;
  status: string;
  bookingRef: string | null;
  pilgrimIds: string[];
  note: string | null;
  metadata: Record<string, unknown>;
  lastNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TtdWindowInput {
  darshanDate: string;
  slotType?: string;
  releaseAt?: string;
  pilgrimIds?: string[];
  note?: string | null;
  status?: string;
  bookingRef?: string | null;
}

export const ttdWindowsApi = {
  list: () => apiFetch<TtdWindow[]>("/ttd-windows"),
  create: (input: TtdWindowInput) =>
    apiFetch<TtdWindow>("/ttd-windows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  update: (id: string, input: Partial<TtdWindowInput>) =>
    apiFetch<TtdWindow>(`/ttd-windows/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    apiFetch(`/ttd-windows/${id}`, { method: "DELETE" }),
};
