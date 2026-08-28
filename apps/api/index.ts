import { authenticate, login, destroySession, listUserSessions, revokeOtherSessions, sessionCookieHeader, clearCookieHeader, readCookie, HttpError, COOKIE_NAME } from "./core/auth";
import { requestPasswordReset, resetPassword } from "./core/password-reset";
import { safe } from "./core/router";
import { checkRateLimit } from "./core/rate-limit";
import { secretsRoutes } from "./modules/secrets/routes";
import { workspaceRoutes } from "./modules/secrets/workspaces";
import { vaultRoutes } from "./modules/vault/routes";
import { knowledgeRoutes } from "./modules/knowledge/routes";
import { attachmentRoutes } from "./modules/knowledge/attachments";
import { financeRoutes } from "./modules/finance/routes";
import { reminderRoutes, startReminderSweepInterval } from "./modules/reminders/routes";
import { recommendRoutes } from "./modules/finance/recommend";

const port = Number(process.env.API_PORT ?? 3001);

Bun.serve({
  port,
  routes: {
    "/health": () => Response.json({ ok: true }),

    "/api/auth/login": {
      POST: safe(async (req) => {
        const { email, password } = await req.json();
        if (typeof email !== "string" || typeof password !== "string") {
          throw new HttpError(400, "email and password required");
        }
        // Keyed by email, not IP: stops credential-stuffing against one
        // account regardless of source, without needing IP plumbing through
        // Bun.serve. Counts every attempt (success or fail) — simplest to
        // reason about, and legitimate logins are infrequent enough here
        // that this never bites a real user.
        const rl = await checkRateLimit({ key: `login:${email.toLowerCase()}`, limit: 5, windowSeconds: 900 });
        if (!rl.allowed) {
          throw new HttpError(429, `Too many login attempts. Try again in ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s).`);
        }
        const { token, ctx } = await login(email, password);
        return new Response(JSON.stringify({ userId: ctx.userId, role: ctx.role }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token) },
        });
      }),
    },

    "/api/auth/logout": {
      POST: safe(async (req) => {
        const token = readCookie(req, COOKIE_NAME);
        if (token) await destroySession(token);
        return new Response(null, { status: 204, headers: { "Set-Cookie": clearCookieHeader() } });
      }),
    },

    "/api/auth/me": {
      GET: safe(async (req) => {
        const ctx = await authenticate(req);
        return Response.json(ctx);
      }),
    },

    "/api/auth/sessions": {
      GET: safe(async (req) => {
        const ctx = await authenticate(req);
        const token = readCookie(req, COOKIE_NAME)!;
        return Response.json(await listUserSessions(ctx.userId, token));
      }),
    },

    "/api/auth/sessions/revoke-others": {
      POST: safe(async (req) => {
        const ctx = await authenticate(req);
        const token = readCookie(req, COOKIE_NAME)!;
        const revoked = await revokeOtherSessions(ctx.userId, token);
        return Response.json({ revoked });
      }),
    },

    "/api/auth/forgot-password": {
      POST: safe(async (req) => {
        const { email } = await req.json();
        if (typeof email !== "string") throw new HttpError(400, "email required");
        // Limits email-sending cost/spam, not an auth bypass concern — still
        // keyed by email so it can't be used to spam one inbox.
        const rl = await checkRateLimit({ key: `forgot-password:${email.toLowerCase()}`, limit: 3, windowSeconds: 3600 });
        if (rl.allowed) await requestPasswordReset(email);
        // Same response whether or not the email has an account, and whether
        // or not it was rate-limited — the caller can't distinguish any of
        // these cases, by design.
        return Response.json({ ok: true });
      }),
    },

    "/api/auth/reset-password": {
      POST: safe(async (req) => {
        const { token, newPassword } = await req.json();
        if (typeof token !== "string" || typeof newPassword !== "string") {
          throw new HttpError(400, "token and newPassword required");
        }
        if (newPassword.length < 8) throw new HttpError(400, "password must be at least 8 characters");
        const result = await resetPassword(token, newPassword);
        if (!result.ok) throw new HttpError(400, result.error ?? "Failed to reset password");
        return Response.json({ ok: true });
      }),
    },

    ...workspaceRoutes,
    ...secretsRoutes,
    ...vaultRoutes,
    ...knowledgeRoutes,
    ...attachmentRoutes,
    ...financeRoutes,
    ...reminderRoutes,
    ...recommendRoutes,
  },
});

startReminderSweepInterval();

console.log(`api listening on :${port}`);
