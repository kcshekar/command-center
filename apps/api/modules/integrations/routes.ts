import { serviceTokenRoute, tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { requireScope } from "../../core/service-token";
import { notify, postApproval, updateNotification } from "../../core/notify";
import { textArrayLiteral } from "../../core/pg-array";
import { withTenantTx, sql } from "../../core/db";
import { getUserCredentialsDek } from "../../core/user-credentials";
import { log } from "../../core/log";

type Verdict = "target" | "buy" | "fair" | "wait";

// A6 Phase 2.6 verdict:
//   target set:           price <= target → 'target' else 'wait'
//   no target, n >= 7:    percentile over the last 90 days — <= p25 → 'buy',
//                         <= p75 → 'fair', else 'wait'
//   no target, n < 7:     'fair' (not enough history yet)
function computeVerdict(
  price: number,
  target: number | null,
  stats: { p25: number | null; p75: number | null; n: number }
): Verdict {
  if (target != null) return price <= target ? "target" : "wait";
  if (stats.n >= 7 && stats.p25 != null && stats.p75 != null) {
    if (price <= stats.p25) return "buy";
    if (price <= stats.p75) return "fair";
    return "wait";
  }
  return "fair";
}

const PRICE_ALERT_ROUTE = process.env.PRICE_ALERT_ROUTE_KEY ?? "automations.digest";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REMINDER_CATEGORIES = new Set(["bill", "insurance", "loan", "credit_card", "vehicle", "other"]);

export const integrationRoutes = {
  // Bank-alert parsers post here. Idempotent on (source, external_id) — a
  // replay of the same Gmail message updates the same row instead of
  // duplicating it. accountName is resolved-or-created under the current org.
  "/api/integrations/expenses": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "expenses:write");
      const { accountName, amountCents, currency, category, occurredOn, note, source, externalId } = await req.json();
      if (amountCents == null || !category || !occurredOn || !source || !externalId) {
        throw new HttpError(400, "amountCents, category, occurredOn, source, externalId are required");
      }
      const amount = typeof amountCents === "string" ? BigInt(amountCents) : BigInt(amountCents);
      if (amount <= 0n) throw new HttpError(400, "amountCents must be positive");

      let accountId: string | null = null;
      if (accountName?.trim()) {
        const [existing] = await ctx.tx`
          SELECT id FROM accounts WHERE org_id = ${ctx.orgId} AND name = ${accountName.trim()}
        `;
        if (existing) accountId = existing.id;
        else {
          const [created] = await ctx.tx`
            INSERT INTO accounts (org_id, name, kind) VALUES (${ctx.orgId}, ${accountName.trim()}, 'bank')
            RETURNING id
          `;
          accountId = created.id;
        }
      }

      const [row] = await ctx.tx`
        INSERT INTO expenses (org_id, account_id, amount_cents, currency, category, occurred_on, note, source, external_id)
        VALUES (${ctx.orgId}, ${accountId}, ${amount.toString()}, ${currency ?? "INR"}, ${category},
                ${occurredOn}, ${note ?? null}, ${source}, ${externalId})
        ON CONFLICT (org_id, source, external_id) WHERE source IS NOT NULL AND external_id IS NOT NULL
        DO UPDATE SET
          account_id = EXCLUDED.account_id, amount_cents = EXCLUDED.amount_cents,
          currency = EXCLUDED.currency, category = EXCLUDED.category,
          occurred_on = EXCLUDED.occurred_on, note = EXCLUDED.note
        RETURNING id, amount_cents
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "expense:create_via_integration",
        resourceType: "expense",
        resourceId: row.id,
        metadata: { source, externalId, tokenId: ctx.tokenId },
      });
      return Response.json({ id: row.id, amountCents: row.amount_cents.toString() }, { status: 201 });
    }),
  },

  "/api/integrations/reminders": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "reminders:write");
      const { title, category, dueOn, recurrence, source, externalId, resourceType, resourceId } = await req.json();
      if (!title?.trim() || !category || !dueOn || !source || !externalId) {
        throw new HttpError(400, "title, category, dueOn, source, externalId are required");
      }
      if (!REMINDER_CATEGORIES.has(category)) throw new HttpError(400, "invalid category");

      const [row] = await ctx.tx`
        INSERT INTO reminders (org_id, title, category, resource_type, resource_id, due_on, recurrence, created_by, source, external_id)
        VALUES (${ctx.orgId}, ${title.trim()}, ${category}, ${resourceType ?? null}, ${resourceId ?? null},
                ${dueOn}, ${recurrence ?? null}, ${ctx.userId}, ${source}, ${externalId})
        ON CONFLICT (org_id, source, external_id) WHERE source IS NOT NULL AND external_id IS NOT NULL
        DO UPDATE SET
          title = EXCLUDED.title, category = EXCLUDED.category,
          due_on = EXCLUDED.due_on, recurrence = EXCLUDED.recurrence
        RETURNING id, title, due_on
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "reminder:create_via_integration",
        resourceType: "reminder",
        resourceId: row.id,
        metadata: { source, externalId, tokenId: ctx.tokenId },
      });
      return Response.json({ id: row.id, title: row.title, dueOn: row.due_on }, { status: 201 });
    }),
  },

  // Worker never holds channel tokens. To post, it names a route key; CC
  // resolves it to a channel_type and dispatches (slack | in_app | …).
  "/api/integrations/notify": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "slack:send"); // scope name predates B1; still gates delivery
      const { routeKey, text } = await req.json();
      if (!routeKey?.trim() || !text?.trim()) throw new HttpError(400, "routeKey and text are required");
      await notify(ctx.tx, ctx.orgId, routeKey.trim(), { text });
      await writeAudit(ctx.tx, ctx, {
        action: "notify:send",
        resourceType: "notification_route",
        metadata: { routeKey, tokenId: ctx.tokenId },
      });
      return Response.json({ ok: true });
    }),
  },

  // Posts an interactive approval across every channel the route fans out to.
  // Returns the list of refs; workflow stores them and hands them back to
  // notify-update so each posting gets settled.
  "/api/integrations/notify-approval": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "slack:send");
      const { routeKey, text, blocks, workflowId, actionId } = await req.json();
      if (!routeKey?.trim() || !text?.trim() || !Array.isArray(blocks)) {
        throw new HttpError(400, "routeKey, text, blocks are required");
      }
      if (!workflowId?.trim() || !actionId?.trim()) {
        throw new HttpError(400, "workflowId and actionId are required for approvals");
      }
      const refs = await postApproval(ctx.tx, ctx.orgId, routeKey.trim(), {
        text, blocks, workflowId: workflowId.trim(), actionId: actionId.trim(),
      });
      await writeAudit(ctx.tx, ctx, {
        action: "notify:approval_posted",
        resourceType: "notification_route",
        metadata: { routeKey, tokenId: ctx.tokenId, refs },
      });
      return Response.json({ refs });
    }),
  },

  // "No click" paths — workflow rewrites its own card on timeout, or stamps
  // the final result after acting. Takes the full refs[] from notify-approval
  // so every channel's posting (slack + in_app) is updated together.
  "/api/integrations/notify-update": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "slack:send");
      const { routeKey, refs, text, blocks } = await req.json();
      if (!routeKey?.trim() || !text?.trim() || !Array.isArray(refs) || refs.length === 0) {
        throw new HttpError(400, "routeKey, refs[], text are required");
      }
      for (const r of refs) {
        if (!r || typeof r.channel !== "string" || typeof r.ts !== "string") {
          throw new HttpError(400, "each ref must be {channel, ts}");
        }
      }
      await updateNotification(ctx.tx, ctx.orgId, routeKey.trim(), refs, { text, blocks });
      return Response.json({ ok: true });
    }),
  },

  "/api/integrations/reminders/due": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "reminders:read");
      const days = Math.max(1, Math.min(60, Number(new URL(req.url).searchParams.get("days") ?? 7)));
      const rows = await ctx.tx`
        SELECT id, title, category, due_on, recurrence, notified_at, resource_type, resource_id
        FROM reminders
        WHERE org_id = ${ctx.orgId}
          AND due_on <= (CURRENT_DATE + (${days}::int * INTERVAL '1 day'))
        ORDER BY due_on ASC
      `;
      return Response.json(rows);
    }),
  },

  // Metadata mirror of the worker's external_credentials (metadata only, no
  // tokens). Worker upserts on every auth + refresh so the UI can list
  // connected accounts without reaching the worker's HTTP server.
  "/api/integrations/external-accounts": {
    GET: tenantRoute(async (_req, ctx) => {
      const rows = await ctx.tx`
        SELECT service, user_id, label, scopes, status, last_refreshed_at, metadata, created_at, updated_at
        FROM external_accounts
        WHERE org_id = ${ctx.orgId}
        ORDER BY service ASC, user_id ASC, label ASC
      `;
      return Response.json(rows);
    }),
    POST: serviceTokenRoute(async (req, ctx) => {
      const { service, userId, label, scopes, status, lastRefreshedAt, metadata } = await req.json();
      if (!service || typeof service !== "string" || !service.trim()) {
        throw new HttpError(400, "service is required");
      }
      if (!userId || typeof userId !== "string" || !userId.trim()) {
        throw new HttpError(400, "userId is required");
      }
      const labelVal = (typeof label === "string" && label.trim()) || "primary";
      const scopesArr: string[] = Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string") : [];
      const metadataVal = metadata && typeof metadata === "object" ? metadata : {};
      const [row] = await ctx.tx`
        INSERT INTO external_accounts (org_id, service, user_id, label, scopes, status, last_refreshed_at, metadata)
        VALUES (
          ${ctx.orgId}, ${service.trim()}, ${userId.trim()}, ${labelVal},
          ${textArrayLiteral(scopesArr)}::text[],
          ${status || "active"},
          ${lastRefreshedAt ? new Date(lastRefreshedAt) : null},
          ${JSON.stringify(metadataVal)}::jsonb
        )
        ON CONFLICT (org_id, service, user_id, label) DO UPDATE SET
          scopes = EXCLUDED.scopes,
          status = EXCLUDED.status,
          last_refreshed_at = COALESCE(EXCLUDED.last_refreshed_at, external_accounts.last_refreshed_at),
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING service, user_id, label, scopes, status, last_refreshed_at, metadata
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "external_account:upsert",
        resourceType: "external_account",
        metadata: { service, userId, label: labelVal, tokenId: ctx.tokenId },
      });
      return Response.json(row);
    }),
  },

  // A6 Phase 2.4 — the worker calls this to decrypt the user's own BYOK key
  // for a known service. The target user is in the URL (not derived from
  // the service token's acting user, which is the worker's home_user). The
  // `credentials:read` scope is the gate; CC re-enters the tenant tx scoped
  // to the target user so RLS enforces normally.
  "/api/integrations/user-credentials/:userId/:service": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "credentials:read");
      const { userId, service } = req.params;
      if (!UUID_RE.test(userId)) throw new HttpError(400, "userId must be a uuid");

      const dek = getUserCredentialsDek();
      const found = await withTenantTx(
        { orgId: ctx.orgId, userId, role: ctx.role },
        async (tx) => {
          // Prefer label='primary', fall back to the most-recent one.
          const rows = await tx`
            SELECT label,
                   pgp_sym_decrypt(key_enc, ${dek})::text AS key
            FROM user_credentials
            WHERE service = ${service}
            ORDER BY (label = 'primary') DESC, updated_at DESC
            LIMIT 1
          `;
          return rows[0] ?? null;
        }
      );
      if (!found) throw new HttpError(404, "no credential for service");

      // Audit on the SERVICE-TOKEN tx so there's a record even if the tenant
      // tx above committed cleanly. Metadata only — no key material.
      await writeAudit(ctx.tx, ctx, {
        action: "user_credential:read_via_integration",
        resourceType: "user_credential",
        metadata: { targetUserId: userId, service, tokenId: ctx.tokenId },
      });

      return Response.json({ label: found.label, key: found.key });
    }),
  },

  // A6 Phase 2.4 — one price snapshot from the worker. Inserts a
  // price_history row and mirrors (price, title, image_url, verdict,
  // last_checked_at) back onto the parent watch. Target user is in the body
  // (same reasoning as credentials-get). verdict is CC-computed so the
  // daily-poll workflow in 2.6 reuses the same formula.
  "/api/integrations/price-watches/:watchId/snapshot": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "prices:write");
      const { watchId } = req.params;
      if (!UUID_RE.test(watchId)) throw new HttpError(400, "watchId must be a uuid");

      const body = (await req.json().catch(() => ({}))) as {
        userId?: unknown;
        price?: unknown;
        currency?: unknown;
        title?: unknown;
        imageUrl?: unknown;
        sourceMeta?: unknown;
      };
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId must be a uuid");
      }
      const priceNum = typeof body.price === "number" ? body.price : parseFloat(String(body.price));
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        throw new HttpError(400, "price must be a positive number");
      }
      const price = Math.round(priceNum * 100) / 100;
      const currency = typeof body.currency === "string" && body.currency.trim()
        ? body.currency.trim().toUpperCase() : null;
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
      const imageUrl = typeof body.imageUrl === "string" && body.imageUrl.trim() ? body.imageUrl.trim() : null;
      const sourceMeta = body.sourceMeta && typeof body.sourceMeta === "object" && !Array.isArray(body.sourceMeta)
        ? body.sourceMeta as Record<string, unknown> : {};

      const result = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          const [watch] = await tx`
            SELECT id, url, target_price, title, image_url, current_verdict
            FROM price_watches
            WHERE id = ${watchId}::uuid
          `;
          if (!watch) return null;

          await tx`
            INSERT INTO price_history (watch_id, price, source_meta)
            VALUES (${watchId}::uuid, ${price}, ${JSON.stringify(sourceMeta)}::jsonb)
          `;

          // Percentile over the last 90 days — the just-inserted sample is
          // included, so n is always >= 1 after the first fetch.
          const [stats] = await tx`
            SELECT
              percentile_cont(0.25) WITHIN GROUP (ORDER BY price)::numeric AS p25,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY price)::numeric AS p75,
              count(*)::int AS n
            FROM price_history
            WHERE watch_id = ${watchId}::uuid
              AND checked_at > now() - interval '90 days'
          `;

          const target = watch.target_price != null ? Number(watch.target_price) : null;
          const newVerdict = computeVerdict(price, target, {
            p25: stats?.p25 != null ? Number(stats.p25) : null,
            p75: stats?.p75 != null ? Number(stats.p75) : null,
            n: stats?.n ?? 0,
          });

          const [row] = await tx`
            UPDATE price_watches
            SET current_price   = ${price},
                current_verdict = ${newVerdict},
                last_checked_at = now(),
                currency        = COALESCE(${currency}, currency),
                title           = COALESCE(title, ${title}),
                image_url       = COALESCE(image_url, ${imageUrl}),
                updated_at      = now()
            WHERE id = ${watchId}::uuid
            RETURNING id,
                      url,
                      currency,
                      target_price    AS "targetPrice",
                      current_price   AS "currentPrice",
                      current_verdict AS "currentVerdict",
                      last_checked_at AS "lastCheckedAt",
                      title,
                      image_url       AS "imageUrl"
          `;

          // Ping only on transitions INTO 'target' or 'buy', so a watch that
          // sits at target doesn't notify every daily poll.
          const prev = watch.current_verdict as Verdict | null;
          const transitioned = newVerdict !== prev && (newVerdict === "target" || newVerdict === "buy");

          return { row, prev, newVerdict, transitioned, title: row.title ?? watch.title ?? row.url };
        }
      );
      if (!result) throw new HttpError(404, "watch not found");

      if (result.transitioned) {
        // Separate tx (ctx.tx is the service-token's own; notify prefers to run
        // through the current one). Keep this best-effort: a Slack outage must
        // not fail the snapshot that already committed.
        const emoji = result.newVerdict === "target" ? "🎯" : "📉";
        const label = result.newVerdict === "target" ? "Target hit" : "Price drop";
        const priceStr = `${result.row.currency} ${Number(result.row.currentPrice).toFixed(2)}`;
        const targetStr = result.row.targetPrice != null ? ` (target ${result.row.currency} ${Number(result.row.targetPrice).toFixed(2)})` : "";
        const text = `${emoji} ${label}: ${result.title} — now ${priceStr}${targetStr}. ${result.row.url}`;
        try {
          await notify(ctx.tx, ctx.orgId, PRICE_ALERT_ROUTE, { text });
        } catch (err) {
          log.warn("price-watch slack notify failed", { watchId, err: err instanceof Error ? err.message : String(err) });
        }
      }

      await writeAudit(ctx.tx, ctx, {
        action: "price_watch:snapshot_via_integration",
        resourceType: "price_watch",
        resourceId: watchId,
        metadata: {
          targetUserId: body.userId,
          price,
          prevVerdict: result.prev,
          verdict: result.newVerdict,
          notified: result.transitioned,
          tokenId: ctx.tokenId,
        },
      });

      return Response.json(result.row);
    }),
  },

  // Phase 1.6 — resolve the effective prompt (default + user override merged)
  // for a target user. The worker uses this per-run so A1/A3/A5/A8 call sites
  // never embed prompt text. Target user is in the URL (worker passes the
  // owning user it's running on behalf of); scope is the gate.
  "/api/integrations/prompts/:name": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "prompts:read");
      const { name } = req.params;
      const url = new URL(req.url);
      const targetUserId = url.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }

      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => {
          const [r] = await tx`
            SELECT p.name,
                   p.description,
                   p.variables,
                   COALESCE(o.body, p.body)                                 AS body,
                   COALESCE(o.default_model, p.default_model)               AS model,
                   COALESCE(o.default_temperature, p.default_temperature)   AS temperature,
                   (o.id IS NOT NULL)                                       AS "hasOverride"
            FROM prompts p
            LEFT JOIN user_prompt_overrides o ON o.prompt_name = p.name
            WHERE p.name = ${name}
          `;
          return r ?? null;
        }
      );
      if (!row) throw new HttpError(404, "prompt not found");

      await writeAudit(ctx.tx, ctx, {
        action: "prompt:resolve_via_integration",
        resourceType: "prompt",
        metadata: { name, targetUserId, hasOverride: row.hasOverride, tokenId: ctx.tokenId },
      });

      return Response.json(row);
    }),
  },

  // A6 Phase 2.6 — list of watches ready for a daily poll. Bypasses per-user
  // RLS via a SECURITY DEFINER helper so one service-token call can enumerate
  // every user's active watches in the token's org.
  "/api/integrations/price-watches/due": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "prices:read");
      const minHoursSince = Math.max(1, Math.min(48, Number(new URL(req.url).searchParams.get("minHours") ?? 20)));
      const cutoff = new Date(Date.now() - minHoursSince * 3600 * 1000);
      const rows = await sql`
        SELECT watch_id AS "watchId",
               user_id  AS "userId",
               source,
               external_id AS "externalId",
               url
        FROM list_due_price_watches(${ctx.orgId}::uuid, ${cutoff})
      `;
      return Response.json(rows);
    }),
  },
};
