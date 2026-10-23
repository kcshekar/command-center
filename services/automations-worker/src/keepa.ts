// Minimal Keepa client. One call: /product?asin=&domain=&stats=1.
// Current price (in cents) comes from stats.current[0] (Amazon) with a
// fallback to current[1] (3rd-party new); -1 means no offer. Prices are
// returned in currency minor units (paise for INR), which we convert to
// major units for CC's numeric(12,2) column.
//
// ponytail: Amazon-only, add Flipkart scraper when a user actually asks for
// one; generic URLs just get null until then.

export interface KeepaSnapshot {
  price: number;            // major units (rupees), 2dp
  currency: string;
  title: string | null;
  imageUrl: string | null;
  domain: number;
  rawCurrentCents: number;  // for sourceMeta/debug
}

// Amazon TLD → Keepa domain id. If we see a TLD we don't map, we skip the
// fetch rather than guess.
const DOMAIN_BY_HOST: Record<string, number> = {
  "amazon.com": 1,
  "amazon.co.uk": 2,
  "amazon.de": 3,
  "amazon.co.jp": 5,
  "amazon.ca": 6,
  "amazon.it": 8,
  "amazon.es": 9,
  "amazon.in": 10,
};

const CURRENCY_BY_DOMAIN: Record<number, string> = {
  1: "USD", 2: "GBP", 3: "EUR", 5: "JPY", 6: "CAD",
  8: "EUR", 9: "EUR", 10: "INR",
};

export function keepaDomainFromUrl(url: string): { domain: number; currency: string } | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
  const domain = DOMAIN_BY_HOST[host];
  if (!domain) return null;
  return { domain, currency: CURRENCY_BY_DOMAIN[domain] ?? "USD" };
}

export async function fetchKeepaProduct(
  apiKey: string,
  domain: number,
  asin: string
): Promise<KeepaSnapshot | null> {
  const url = `https://api.keepa.com/product?key=${encodeURIComponent(apiKey)}&domain=${domain}&asin=${encodeURIComponent(asin)}&stats=1&history=0`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`keepa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    products?: Array<{
      asin: string;
      title?: string;
      imagesCSV?: string;
      stats?: { current?: number[] };
    }>;
    tokensLeft?: number;
  };
  const p = body.products?.[0];
  if (!p) {
    console.warn("[keepa] response has no products[]", { asin, bodyKeys: Object.keys(body ?? {}) });
    return null;
  }
  const cur = p.stats?.current ?? [];
  // Try Amazon (0), then New marketplace (1).
  let cents = -1;
  for (const idx of [0, 1]) {
    const v = cur[idx];
    if (typeof v === "number" && v > 0) { cents = v; break; }
  }
  if (cents < 0) {
    console.warn("[keepa] no current price in stats", { asin, current: cur });
    return null;
  }
  // m.media-amazon.com is the public mirror and renders cross-origin without
  // referer games; images-na.ssl-images-amazon.com can get blocked by browsers.
  const firstImage = (p.imagesCSV ?? "").split(",")[0]?.trim();
  const imageUrl = firstImage ? `https://m.media-amazon.com/images/I/${firstImage}` : null;
  const snap: KeepaSnapshot = {
    price: Math.round(cents) / 100,
    currency: CURRENCY_BY_DOMAIN[domain] ?? "USD",
    title: p.title ?? null,
    imageUrl,
    domain,
    rawCurrentCents: cents,
  };
  // One-line diagnostic so a missing title/image shows up in the worker log.
  console.log("[keepa] fetched", {
    asin,
    price: snap.price,
    hasTitle: snap.title != null,
    hasImage: snap.imageUrl != null,
    productKeys: Object.keys(p),
    tokensLeft: body.tokensLeft,
  });
  return snap;
}
