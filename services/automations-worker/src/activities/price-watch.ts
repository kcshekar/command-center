import { cc } from "../cc-client.js";
import { fetchKeepaProduct, keepaDomainFromUrl } from "../keepa.js";

// A6 Phase 2.4 — initial-fetch activity.
//
// Lookup is scoped to one watch: user's Keepa key → Keepa /product → CC
// writeback. We DO NOT touch the DB directly; CC owns the write (RLS + audit +
// verdict). If anything is missing (no key, non-Amazon, Keepa says no data),
// the activity returns a status string and the workflow records that in logs.
//
// Verdict is computed CC-side so the daily-poll workflow (2.6) can share one
// formula.

export interface InitialFetchInput {
  watchId: string;
  userId: string;
  source: string;              // 'amazon' | 'flipkart' | 'generic'
  externalId: string | null;   // ASIN for amazon
  url: string;
}

export type InitialFetchStatus =
  | "ok"
  | "no_credential"
  | "unsupported_source"
  | "no_asin"
  | "unknown_domain"
  | "no_price";

export async function fetchInitialPriceSnapshot(input: InitialFetchInput): Promise<{
  status: InitialFetchStatus;
  price?: number;
}> {
  if (input.source !== "amazon") return { status: "unsupported_source" };
  if (!input.externalId) return { status: "no_asin" };

  const dom = keepaDomainFromUrl(input.url);
  if (!dom) return { status: "unknown_domain" };

  const cred = await cc.getUserCredential(input.userId, "keepa");
  if (!cred) return { status: "no_credential" };

  const snap = await fetchKeepaProduct(cred.key, dom.domain, input.externalId);
  if (!snap) return { status: "no_price" };

  console.log("[price-watch] posting snapshot", {
    watchId: input.watchId,
    price: snap.price,
    title: snap.title,
    imageUrl: snap.imageUrl,
  });

  await cc.postPriceSnapshot(input.watchId, {
    userId: input.userId,
    price: snap.price,
    currency: snap.currency,
    title: snap.title,
    imageUrl: snap.imageUrl,
    sourceMeta: {
      via: "keepa",
      domain: snap.domain,
      rawCurrentCents: snap.rawCurrentCents,
      credentialLabel: cred.label,
      sentTitle: snap.title,
      sentImageUrl: snap.imageUrl,
    },
  });

  return { status: "ok", price: snap.price };
}

// 2.6 daily-poll fan-out input shape (same as initial fetch but renamed for
// clarity in the workflow).
export interface DueWatch {
  watchId: string;
  userId: string;
  source: string;
  externalId: string | null;
  url: string;
}

export async function listDuePriceWatches(minHoursSince = 20): Promise<DueWatch[]> {
  return cc.dueWatches(minHoursSince);
}
