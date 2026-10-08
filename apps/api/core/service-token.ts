import { createHash, randomBytes } from "crypto";
import type { SQL } from "bun";
import { sql, type AuthCtx } from "./db";
import { HttpError } from "./auth";

const PREFIX = "cc_st_";

// Raw token = "cc_st_" + 32 hex bytes. Shown once at creation; only the hash lives in DB.
export function generateServiceToken(): { raw: string; hash: string; prefix: string } {
  const raw = PREFIX + randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 12) };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface ServiceTokenCtx extends AuthCtx {
  tokenId: string;
  scopes: string[];
  viaServiceToken: true;
}

// Reads Bearer token, resolves via SECURITY DEFINER function (pre-tenant),
// then hands back an AuthCtx-shaped context the normal withTenantTx accepts.
export async function authenticateServiceToken(req: Request): Promise<ServiceTokenCtx> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/);
  if (!match || !match[1].startsWith(PREFIX)) throw new HttpError(401, "missing or malformed bearer token");

  const [row] = await sql`SELECT * FROM resolve_service_token(${hashToken(match[1])})`;
  if (!row) throw new HttpError(401, "invalid or expired service token");

  return {
    userId: row.acting_user_id,
    orgId: row.org_id,
    role: row.role,
    tokenId: row.token_id,
    scopes: row.scopes ?? [],
    viaServiceToken: true,
  };
}

export function requireScope(ctx: ServiceTokenCtx, scope: string) {
  if (!ctx.scopes.includes(scope)) throw new HttpError(403, `service token missing required scope: ${scope}`);
}

export { HttpError };
