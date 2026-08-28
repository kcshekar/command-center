import { redis } from "./redis";
import { sql, type AuthCtx } from "./db";
export type { AuthCtx };

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const COOKIE_NAME = "cc_session";

export function hashPassword(password: string) {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash);
}

function newToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

interface SessionRecord extends AuthCtx {
  createdAt: number;
}

// `user-sessions:<userId>` is a Redis SET indexing every token issued to
// that user — it's an index only, never the source of truth. A session is
// valid iff `session:<token>` itself exists; the set can carry stale
// references after a token's own TTL expires, cleaned up lazily on read
// (listUserSessions) rather than needing a second TTL to track.
function userSessionSetKey(userId: string) {
  return `user-sessions:${userId}`;
}

export async function createSession(ctx: AuthCtx): Promise<string> {
  const token = newToken();
  const record: SessionRecord = { ...ctx, createdAt: Date.now() };
  await redis.set(`session:${token}`, JSON.stringify(record), "EX", SESSION_TTL_SECONDS);
  await redis.sadd(userSessionSetKey(ctx.userId), token);
  return token;
}

export async function destroySession(token: string) {
  const raw = await redis.get(`session:${token}`);
  await redis.del(`session:${token}`);
  if (raw) {
    const record = JSON.parse(raw) as SessionRecord;
    await redis.srem(userSessionSetKey(record.userId), token);
  }
}

export interface SessionSummary {
  token: string;
  createdAt: number;
  isCurrent: boolean;
}

export async function listUserSessions(userId: string, currentToken: string): Promise<SessionSummary[]> {
  const tokens = await redis.smembers(userSessionSetKey(userId));
  const summaries: SessionSummary[] = [];
  for (const token of tokens) {
    const raw = await redis.get(`session:${token}`);
    if (!raw) {
      // Expired via its own TTL — the set reference is stale, clean it up.
      await redis.srem(userSessionSetKey(userId), token);
      continue;
    }
    const record = JSON.parse(raw) as SessionRecord;
    summaries.push({ token: token.slice(0, 8), createdAt: record.createdAt, isCurrent: token === currentToken });
  }
  return summaries.sort((a, b) => b.createdAt - a.createdAt);
}

// "Log out everywhere else" — keeps the caller's own current session alive.
export async function revokeOtherSessions(userId: string, currentToken: string): Promise<number> {
  const tokens = await redis.smembers(userSessionSetKey(userId));
  let revoked = 0;
  for (const token of tokens) {
    if (token === currentToken) continue;
    await redis.del(`session:${token}`);
    await redis.srem(userSessionSetKey(userId), token);
    revoked++;
  }
  return revoked;
}

// Used after a login-password reset: the old password is dead, so every
// session established under it should be too. No exception token — the
// user isn't logged in yet at that point.
export async function revokeAllSessions(userId: string): Promise<void> {
  const tokens = await redis.smembers(userSessionSetKey(userId));
  for (const token of tokens) {
    await redis.del(`session:${token}`);
  }
  await redis.del(userSessionSetKey(userId));
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function sessionCookieHeader(token: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// Thrown by route handlers on auth/authz failure; the router (Phase 1 next
// step) turns this into the right HTTP status without every handler
// duplicating error-response boilerplate.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function authenticate(req: Request): Promise<AuthCtx> {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) throw new HttpError(401, "not authenticated");
  const raw = await redis.get(`session:${token}`);
  if (!raw) throw new HttpError(401, "session expired");
  return JSON.parse(raw) as AuthCtx;
}

export async function login(email: string, password: string): Promise<{ token: string; ctx: AuthCtx }> {
  const rows = await sql`
    SELECT id, org_id, role, password_hash FROM users WHERE email = ${email}
  `;
  const user = rows[0];
  if (!user) throw new HttpError(401, "invalid credentials");
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw new HttpError(401, "invalid credentials");
  const ctx: AuthCtx = { userId: user.id, orgId: user.org_id, role: user.role };
  const token = await createSession(ctx);
  return { token, ctx };
}
