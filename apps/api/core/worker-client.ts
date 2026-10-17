import { createHash, randomBytes } from "crypto";
import type { SQL } from "bun";
import { sql } from "./db";
import { HttpError } from "./auth";
import { textArrayLiteral } from "./pg-array";

// OAuth2-style client credentials for the automations worker. Worker proves
// its identity with Basic auth (client_id:client_secret) and gets back a
// short-lived service_token for the actual API call. Hash algo matches
// service_tokens (SHA-256) so the same table conventions apply.

const CLIENT_ID_PREFIX = "worker_";
const CLIENT_SECRET_PREFIX = "whk_";

export function generateClientCredentials(): {
  clientId: string;
  rawSecret: string;
  secretHash: string;
  secretPrefix: string;
} {
  const clientId = CLIENT_ID_PREFIX + randomBytes(16).toString("hex");
  const rawSecret = CLIENT_SECRET_PREFIX + randomBytes(32).toString("hex");
  return {
    clientId,
    rawSecret,
    secretHash: hashSecret(rawSecret),
    secretPrefix: rawSecret.slice(0, 12),
  };
}

export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface ResolvedWorkerClient {
  id: string;
  homeOrgId: string;
  homeUserId: string;
  allowedScopes: string[];
  defaultTtlSeconds: number;
}

// Parses Authorization: Basic <base64(client_id:client_secret)> and resolves
// via the SECURITY DEFINER function so RLS doesn't filter the row before we
// can see it. Throws 401 on anything malformed/invalid.
export async function authenticateWorkerClient(req: Request): Promise<ResolvedWorkerClient> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Basic\s+(\S+)$/);
  if (!match) throw new HttpError(401, "missing or malformed Basic auth header");

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    throw new HttpError(401, "invalid base64 in Basic auth header");
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) throw new HttpError(401, "malformed Basic auth (expected client_id:client_secret)");

  const clientId = decoded.slice(0, sep);
  const rawSecret = decoded.slice(sep + 1);
  if (!clientId || !rawSecret) throw new HttpError(401, "empty client_id or secret");

  const [row] = await sql`SELECT * FROM resolve_worker_client(${clientId}, ${hashSecret(rawSecret)})`;
  if (!row) throw new HttpError(401, "invalid or inactive worker client");

  return {
    id: row.id,
    homeOrgId: row.home_org_id,
    homeUserId: row.home_user_id,
    allowedScopes: row.allowed_scopes ?? [],
    defaultTtlSeconds: row.default_ttl_seconds,
  };
}

export function requireAllowedScopes(client: ResolvedWorkerClient, requested: string[]) {
  const notAllowed = requested.filter((s) => !client.allowedScopes.includes(s));
  if (notAllowed.length > 0) {
    throw new HttpError(403, `scopes not permitted for this worker: ${notAllowed.join(", ")}`);
  }
}

// Writes a service_tokens row and returns the raw cc_st_... value exactly
// once. Uses the admin sql handle because the mint endpoint runs pre-tenant
// (the resolver already proved the caller is the worker; we don't need
// per-user context for the insert).
export async function mintScopedToken(
  tx: SQL,
  client: ResolvedWorkerClient,
  args: { scopes: string[]; purpose: string | null; ttlSeconds: number }
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  // Reuse the existing service_tokens generator for identical token shape.
  const { generateServiceToken } = await import("./service-token");
  const { raw, hash, prefix } = generateServiceToken();
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000);

  // Short, deterministic label on the service_tokens row so the admin UI
  // doesn't show a wall of unlabelled rows.
  const name = `minted:${args.purpose ?? "default"}`;

  const [row] = await tx`
    INSERT INTO service_tokens (
      org_id, name, token_hash, token_prefix, scopes, acting_user_id,
      expires_at, created_by, minted_by_client_id, purpose
    ) VALUES (
      ${client.homeOrgId}, ${name}, ${hash}, ${prefix},
      ${textArrayLiteral(args.scopes)}::text[], ${client.homeUserId},
      ${expiresAt}, ${client.homeUserId}, ${client.id}, ${args.purpose}
    )
    RETURNING id
  `;
  return { token: raw, tokenId: row.id, expiresAt };
}
