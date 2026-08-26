import { redis } from "./redis";
import { sql, type AuthCtx } from "./db";

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

export async function createSession(ctx: AuthCtx): Promise<string> {
  const token = newToken();
  await redis.set(`session:${token}`, JSON.stringify(ctx), "EX", SESSION_TTL_SECONDS);
  return token;
}

export async function destroySession(token: string) {
  await redis.del(`session:${token}`);
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
