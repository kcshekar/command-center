import { apiFetch } from "./api";

export interface PriceWatch {
  id: string;
  url: string;
  source: string;              // 'amazon' | 'flipkart' | 'generic'
  externalId: string | null;
  title: string | null;
  imageUrl: string | null;
  currency: string;
  targetPrice: number | null;
  currentPrice: number | null;
  currentVerdict: "target" | "wait" | "fair" | null;
  lastCheckedAt: string | null;
  paused: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PriceHistoryPoint {
  id: number;
  checkedAt: string;
  price: number;
  sourceMeta: Record<string, unknown>;
}

export interface PriceWatchDetail extends PriceWatch {
  history: PriceHistoryPoint[];
}

export const priceWatchesApi = {
  list: () => apiFetch<PriceWatch[]>("/price-watches"),
  get: (id: string) => apiFetch<PriceWatchDetail>(`/price-watches/${id}`),
  create: (input: { url: string; target_price?: number; note?: string }) =>
    apiFetch<PriceWatch>("/price-watches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  update: (id: string, input: { target_price?: number | null; note?: string | null; paused?: boolean }) =>
    apiFetch<Partial<PriceWatch>>(`/price-watches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    apiFetch(`/price-watches/${id}`, { method: "DELETE" }),
};
