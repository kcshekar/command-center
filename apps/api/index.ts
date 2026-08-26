import { authenticate, login, destroySession, sessionCookieHeader, clearCookieHeader, readCookie, HttpError, COOKIE_NAME } from "./core/auth";
import { safe } from "./core/router";
import { secretsRoutes } from "./modules/secrets/routes";
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
