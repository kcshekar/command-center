import { pool } from "./db.js";

// Mints short-lived service tokens from CC on demand and caches them in
// memory until they're near expiry. Reads the worker's own credentials from
// the worker_identity row (seeded by the install script, replaced on
// rotation via CC's UI).
//
// Falls back to CC_SERVICE_TOKEN from env if no worker_identity row exists —
// zero-downtime migration path for existing installs.

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
}

interface WorkerIdentity {
  clientId: string;
  clientSecret: string;
  ccBaseUrl: string;
}

const REFRESH_LEEWAY_MS = 60_000; // refresh 60s before actual expiry
const DEFAULT_PURPOSE = "default";

let identityCache: WorkerIdentity | null | undefined; // undefined = not loaded, null = none in DB
const tokenCache = new Map<string, CachedToken>();

function cacheKey(scopes: string[], purpose: string): string {
  return [...scopes].sort().join(",") + "|" + purpose;
}

async function loadIdentity(): Promise<WorkerIdentity | null> {
  if (identityCache !== undefined) return identityCache;
  try {
    const res = await pool.query(
      `SELECT client_id, client_secret, cc_base_url FROM worker_identity WHERE id = 1`
    );
    if (res.rows.length === 0) {
      identityCache = null;
      return null;
    }
    const row = res.rows[0];
    identityCache = {
      clientId: row.client_id,
      clientSecret: row.client_secret,
      ccBaseUrl: row.cc_base_url,
    };
    return identityCache;
  } catch (err) {
    // Table may not exist yet on a fresh install — treat as "no identity".
    const msg = err instanceof Error ? err.message : String(err);
    if (/relation .*worker_identity.* does not exist/i.test(msg)) {
      identityCache = null;
      return null;
    }
    throw err;
  }
}

// Force a reload of the identity row — call after rotation so the worker
// picks up the new secret without a restart.
export function evictIdentityCache(): void {
  identityCache = undefined;
}

export function evictTokenCache(): void {
  tokenCache.clear();
}

async function mintToken(
  identity: WorkerIdentity,
  scopes: string[],
  purpose: string
): Promise<CachedToken> {
  const basic = Buffer.from(`${identity.clientId}:${identity.clientSecret}`).toString("base64");
  const res = await fetch(`${identity.ccBaseUrl}/api/service-tokens/mint`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scopes, purpose }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CC mint failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
  return { token, expiresAt: new Date(expires_at).getTime() };
}

// Returns a service token with the requested scopes. Uses the cache when
// fresh; mints a new one via CC when missing or near expiry. On 401 from CC
// the caller should evict both this token and the identity, then retry once.
export async function getToken(scopes: string[], purpose: string = DEFAULT_PURPOSE): Promise<string> {
  const identity = await loadIdentity();
  if (!identity) {
    const fallback = process.env.CC_SERVICE_TOKEN;
    if (!fallback) throw new Error("no worker_identity row and no CC_SERVICE_TOKEN fallback — run `pnpm tokens:init`");
    return fallback;
  }

  const key = cacheKey(scopes, purpose);
  const cached = tokenCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt - REFRESH_LEEWAY_MS > now) {
    return cached.token;
  }

  const minted = await mintToken(identity, scopes, purpose);
  tokenCache.set(key, minted);
  return minted.token;
}

// Returns the base URL for CC calls — identity row trumps CC_BASE_URL env
// (one place to configure the pair), falls back to env otherwise.
export async function ccBaseUrl(): Promise<string> {
  const identity = await loadIdentity();
  return identity?.ccBaseUrl ?? process.env.CC_BASE_URL ?? "http://localhost:3011";
}
