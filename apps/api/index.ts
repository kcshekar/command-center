import "./core/config";
import { authenticate, login, completeMfaLogin, verifyPassword, destroySession, listUserSessions, revokeOtherSessions, sessionCookieHeader, clearCookieHeader, readCookie, HttpError, COOKIE_NAME } from "./core/auth";
import { requestPasswordReset, resetPassword } from "./core/password-reset";
import { signup } from "./core/signup";
import { generateTotpSecret, base32Encode, otpauthUrl, verifyTotp, generateBackupCodes, hashBackupCode, findMatchingBackupCode } from "./core/mfa";
import { writeAudit } from "./core/audit";
import { sql } from "./core/db";
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
import { auditRoutes } from "./modules/audit/routes";

const port = Number(process.env.API_PORT ?? 3001);

Bun.serve({
  port,
  // Default 10s is too short for the CA-invoice PDF route, which launches a
  // headless Chrome instance per request.
  idleTimeout: 30,
  routes: {
    "/health": () => Response.json({ ok: true }),

    "/api/auth/signup": {
      POST: safe(async (req) => {
        const { orgName, email, password } = await req.json();
        if (typeof orgName !== "string" || !orgName.trim()) throw new HttpError(400, "organization name required");
        if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new HttpError(400, "valid email required");
        }
        if (typeof password !== "string" || password.length < 8) {
          throw new HttpError(400, "password must be at least 8 characters");
        }
        // Global, not per-identity — there's no existing account to key on
        // yet. Just enough to blunt scripted mass account creation.
        const rl = await checkRateLimit({ key: "signup:global", limit: 50, windowSeconds: 3600 });
        if (!rl.allowed) throw new HttpError(429, "Too many signups right now, please try again later.");

        const { token, ctx } = await signup(orgName.trim(), email.toLowerCase(), password);
        return new Response(JSON.stringify({ userId: ctx.userId, role: ctx.role }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token) },
        });
      }),
    },

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
        const result = await login(email, password);
        if (result.status === "mfa_required") {
          return Response.json({ mfaRequired: true, mfaToken: result.mfaToken });
        }
        return new Response(JSON.stringify({ userId: result.ctx.userId, role: result.ctx.role }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(result.token) },
        });
      }),
    },

    "/api/auth/login/mfa": {
      POST: safe(async (req) => {
        const { mfaToken, code } = await req.json();
        if (typeof mfaToken !== "string" || typeof code !== "string") {
          throw new HttpError(400, "mfaToken and code required");
        }
        const rl = await checkRateLimit({ key: `mfa-login:${mfaToken}`, limit: 10, windowSeconds: 300 });
        if (!rl.allowed) throw new HttpError(429, "Too many attempts, please log in again");

        const { token, ctx } = await completeMfaLogin(mfaToken, async (loginCtx) => {
          const [user] = await sql`SELECT mfa_secret FROM users WHERE id = ${loginCtx.userId}`;
          if (user?.mfa_secret && (await verifyTotp(new Uint8Array(user.mfa_secret), code))) return true;

          // Not a valid TOTP code — try it as a one-time backup code.
          const backupRows = await sql`
            SELECT id, code_hash FROM mfa_backup_codes WHERE user_id = ${loginCtx.userId} AND used_at IS NULL
          `;
          const matchId = await findMatchingBackupCode(code, backupRows as any);
          if (!matchId) return false;
          await sql`UPDATE mfa_backup_codes SET used_at = now() WHERE id = ${matchId}`;
          await writeAudit(sql, loginCtx, { action: "mfa_backup_code:use", resourceType: "mfa_backup_code", resourceId: matchId });
          return true;
        });
        return new Response(JSON.stringify({ userId: ctx.userId, role: ctx.role }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token) },
        });
      }),
    },

    // Generates a fresh secret and stores it un-enabled — /mfa/enable must
    // confirm possession of it with a real code before mfa_enabled flips on,
    // so a page reload mid-setup never leaves an account silently protected
    // by a secret the user never actually saw.
    "/api/auth/mfa/setup": {
      POST: safe(async (req) => {
        const ctx = await authenticate(req);
        const secret = generateTotpSecret();
        await sql`UPDATE users SET mfa_secret = ${Buffer.from(secret)}, mfa_enabled = false WHERE id = ${ctx.userId}`;
        const [user] = await sql`SELECT email FROM users WHERE id = ${ctx.userId}`;
        return Response.json({ secret: base32Encode(secret), otpauthUrl: otpauthUrl(user.email, secret) });
      }),
    },

    "/api/auth/mfa/enable": {
      POST: safe(async (req) => {
        const ctx = await authenticate(req);
        const { token } = await req.json();
        if (typeof token !== "string") throw new HttpError(400, "token required");
        const [user] = await sql`SELECT mfa_secret FROM users WHERE id = ${ctx.userId}`;
        if (!user?.mfa_secret || !(await verifyTotp(new Uint8Array(user.mfa_secret), token))) {
          throw new HttpError(400, "Invalid code");
        }
        await sql`UPDATE users SET mfa_enabled = true WHERE id = ${ctx.userId}`;
        const codes = generateBackupCodes();
        for (const code of codes) {
          const codeHash = await hashBackupCode(code);
          await sql`INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES (${ctx.userId}, ${codeHash})`;
        }
        await writeAudit(sql, ctx, { action: "mfa:enable", resourceType: "user", resourceId: ctx.userId });
        // Shown once — only the hashes persist.
        return Response.json({ backupCodes: codes });
      }),
    },

    "/api/auth/mfa/disable": {
      POST: safe(async (req) => {
        const ctx = await authenticate(req);
        const { password } = await req.json();
        if (typeof password !== "string") throw new HttpError(400, "password required");
        const [user] = await sql`SELECT password_hash FROM users WHERE id = ${ctx.userId}`;
        if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, "Incorrect password");
        await sql`UPDATE users SET mfa_secret = NULL, mfa_enabled = false WHERE id = ${ctx.userId}`;
        await sql`DELETE FROM mfa_backup_codes WHERE user_id = ${ctx.userId}`;
        await writeAudit(sql, ctx, { action: "mfa:disable", resourceType: "user", resourceId: ctx.userId });
        return Response.json({ ok: true });
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
        // Queried fresh, not read off the session ctx: mfa_enabled can
        // change mid-session (enable/disable) and the cached session
        // shouldn't go stale on that.
        const [user] = await sql`SELECT mfa_enabled FROM users WHERE id = ${ctx.userId}`;
        return Response.json({ ...ctx, mfaEnabled: user?.mfa_enabled ?? false });
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
        await writeAudit(sql, ctx, { action: "session:revoke_others", resourceType: "session", metadata: { revoked } });
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
    ...auditRoutes,
  },
});

startReminderSweepInterval();

console.log(`api listening on :${port}`);
