import { tenantRoute, safe } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { withTenantTx } from "../../core/db";
import {
  authenticateWorkerClient,
  generateClientCredentials,
  mintScopedToken,
  requireAllowedScopes,
} from "../../core/worker-client";
import { textArrayLiteral } from "../../core/pg-array";

const ALLOWED_SCOPES = new Set(["expenses:write", "reminders:write", "reminders:read", "slack:send", "prices:write", "prices:read", "credentials:read", "prompts:read"]);

export const workerClientRoutes = {
  // ─── Mint ─────────────────────────────────────────────────────────────────
  // Worker-only, Basic-auth'd. Issues a short-lived service_token scoped to
  // the worker's home org/user. Request:
  //   { scopes: string[], purpose?: string, ttl_seconds?: number }
  "/api/service-tokens/mint": {
    POST: safe(async (req) => {
      const client = await authenticateWorkerClient(req);
      const body = await req.json().catch(() => ({}));
      const scopes: unknown = body.scopes;
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new HttpError(400, "scopes (non-empty string array) is required");
      }
      const sc = scopes.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
      if (sc.length !== scopes.length) throw new HttpError(400, "scopes must be strings");
      const bad = sc.filter((s) => !ALLOWED_SCOPES.has(s));
      if (bad.length) throw new HttpError(400, `unknown scope(s): ${bad.join(", ")}`);
      requireAllowedScopes(client, sc);

      const ttlSeconds = Math.min(
        3600,
        Math.max(60, typeof body.ttl_seconds === "number" ? body.ttl_seconds : client.defaultTtlSeconds)
      );
      const purpose = typeof body.purpose === "string" && body.purpose.trim() ? body.purpose.trim().slice(0, 60) : null;

      // Mint inside a tenant tx scoped to the client's home org so RLS/
      // audit rows attribute cleanly. The acting-user context matches the
      // row we're about to insert.
      const auditCtx = { userId: client.homeUserId, orgId: client.homeOrgId, role: "owner" as const };
      const result = await withTenantTx(auditCtx, async (tx) => {
        const minted = await mintScopedToken(tx, client, { scopes: sc, purpose, ttlSeconds });
        await writeAudit(tx, auditCtx, {
          action: "service_token:mint",
          resourceType: "service_token",
          resourceId: minted.tokenId,
          metadata: { clientId: client.id, scopes: sc, purpose, ttlSeconds },
        });
        return minted;
      });

      return Response.json({
        token: result.token,
        expires_at: result.expiresAt.toISOString(),
      });
    }),
  },

  // ─── Admin: list / create / rotate / delete worker clients ───────────────
  "/api/worker-clients": {
    GET: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const rows = await ctx.tx`
        SELECT
          w.id, w.name, w.client_id, w.client_secret_prefix, w.allowed_scopes,
          w.home_user_id, w.default_ttl_seconds, w.is_active,
          w.created_at, w.rotated_at, w.last_mint_at,
          (SELECT count(*)::int FROM service_tokens st
             WHERE st.minted_by_client_id = w.id
               AND (st.expires_at IS NULL OR st.expires_at > now())
          ) AS live_minted_count
        FROM worker_clients w
        WHERE w.home_org_id = ${ctx.orgId}
        ORDER BY w.created_at ASC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { name, allowedScopes, homeUserId, defaultTtlSeconds } = await req.json();
      if (!name?.trim()) throw new HttpError(400, "name is required");
      if (!Array.isArray(allowedScopes) || allowedScopes.length === 0) {
        throw new HttpError(400, "allowedScopes (non-empty) is required");
      }
      const bad = allowedScopes.filter((s: string) => !ALLOWED_SCOPES.has(s));
      if (bad.length) throw new HttpError(400, `unknown scope(s): ${bad.join(", ")}`);
      const actingUser = homeUserId?.trim() || ctx.userId;

      const creds = generateClientCredentials();
      const [row] = await ctx.tx`
        INSERT INTO worker_clients (
          name, client_id, client_secret_hash, client_secret_prefix, allowed_scopes,
          home_org_id, home_user_id, default_ttl_seconds, created_by
        ) VALUES (
          ${name.trim()}, ${creds.clientId}, ${creds.secretHash}, ${creds.secretPrefix},
          ${textArrayLiteral(allowedScopes)}::text[],
          ${ctx.orgId}, ${actingUser},
          ${Math.min(3600, Math.max(60, Number(defaultTtlSeconds ?? 3600)))},
          ${ctx.userId}
        )
        RETURNING id, name, client_id, client_secret_prefix, allowed_scopes, default_ttl_seconds, created_at
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "worker_client:create",
        resourceType: "worker_client",
        resourceId: row.id,
      });
      // Raw secret shown once — same contract as service_tokens creation.
      return Response.json({ ...row, client_secret: creds.rawSecret }, { status: 201 });
    }),
  },

  "/api/worker-clients/:workerId/rotate": {
    POST: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { workerId } = req.params;

      // Fetch the existing client_id — rotate changes the secret, not the id.
      const [existing] = await ctx.tx`
        SELECT client_id FROM worker_clients
        WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}
      `;
      if (!existing) throw new HttpError(404, "worker client not found");

      const creds = generateClientCredentials();

      // Push to the worker FIRST. If this fails nothing has changed in CC
      // either, so the operator can retry safely. Worker's /admin/worker-identity
      // is bearer-authed by WORKER_CALLBACK_TOKEN (same env the Slack
      // approval callback uses) and only reachable on localhost in prod.
      const workerUrl = process.env.WORKER_CALLBACK_URL;
      const workerToken = process.env.WORKER_CALLBACK_TOKEN;
      if (!workerUrl || !workerToken) {
        throw new HttpError(500, "WORKER_CALLBACK_URL / WORKER_CALLBACK_TOKEN not set — can't push rotation to worker");
      }
      const pushRes = await fetch(`${workerUrl}/admin/worker-identity`, {
        method: "POST",
        headers: { Authorization: `Bearer ${workerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: existing.client_id, client_secret: creds.rawSecret }),
      }).catch((err) => ({ ok: false, status: 0, text: async () => String(err) } as Response));
      if (!pushRes.ok) {
        const body = await pushRes.text().catch(() => "");
        throw new HttpError(502, `worker rotation push failed ${pushRes.status}: ${body.slice(0, 200)}`);
      }

      // Only now flip CC's hash. Window of out-of-sync is ms (worker has new,
      // CC still has old) between push ack and this UPDATE committing.
      const [row] = await ctx.tx`
        UPDATE worker_clients
        SET client_secret_hash = ${creds.secretHash},
            client_secret_prefix = ${creds.secretPrefix},
            rotated_at = now()
        WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}
        RETURNING id, client_id, client_secret_prefix, rotated_at
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "worker_client:rotate",
        resourceType: "worker_client",
        resourceId: workerId,
      });
      // Secret still shown for the operator's records / password manager,
      // but the worker is already updated — no manual action required.
      return Response.json({ ...row, client_secret: creds.rawSecret, synced_to_worker: true });
    }),
  },

  "/api/worker-clients/:workerId": {
    DELETE: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { workerId } = req.params;
      const [deleted] = await ctx.tx`
        DELETE FROM worker_clients WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}
        RETURNING id
      `;
      if (!deleted) throw new HttpError(404, "worker client not found");
      await writeAudit(ctx.tx, ctx, {
        action: "worker_client:delete",
        resourceType: "worker_client",
        resourceId: workerId,
      });
      return new Response(null, { status: 204 });
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const { workerId } = req.params;
      const { isActive, allowedScopes, defaultTtlSeconds, name } = await req.json();
      if (Array.isArray(allowedScopes)) {
        const bad = allowedScopes.filter((s: string) => !ALLOWED_SCOPES.has(s));
        if (bad.length) throw new HttpError(400, `unknown scope(s): ${bad.join(", ")}`);
      }
      if (typeof isActive === "boolean") {
        await ctx.tx`UPDATE worker_clients SET is_active = ${isActive} WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}`;
      }
      if (typeof name === "string" && name.trim()) {
        await ctx.tx`UPDATE worker_clients SET name = ${name.trim()} WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}`;
      }
      if (Array.isArray(allowedScopes)) {
        await ctx.tx`UPDATE worker_clients SET allowed_scopes = ${textArrayLiteral(allowedScopes)}::text[] WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}`;
      }
      if (typeof defaultTtlSeconds === "number") {
        const ttl = Math.min(3600, Math.max(60, defaultTtlSeconds));
        await ctx.tx`UPDATE worker_clients SET default_ttl_seconds = ${ttl} WHERE id = ${workerId} AND home_org_id = ${ctx.orgId}`;
      }
      await writeAudit(ctx.tx, ctx, {
        action: "worker_client:update",
        resourceType: "worker_client",
        resourceId: workerId,
      });
      return Response.json({ ok: true });
    }),
  },
};
