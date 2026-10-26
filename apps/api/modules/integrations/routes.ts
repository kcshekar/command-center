import { serviceTokenRoute, tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { requireScope } from "../../core/service-token";
import { notify, postApproval, updateNotification } from "../../core/notify";
import { textArrayLiteral } from "../../core/pg-array";
import { withTenantTx, sql } from "../../core/db";
import { getUserCredentialsDek } from "../../core/user-credentials";
import { getPilgrimIdentitiesDek, type PilgrimPii } from "../../core/pilgrim-identities";
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
          ${JSON.stringify(metadataVal)}::text::jsonb
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
                   pgp_sym_decrypt(key_enc, ${dek})::text AS key,
                   metadata
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

      return Response.json({ label: found.label, key: found.key, metadata: found.metadata ?? {} });
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
            VALUES (${watchId}::uuid, ${price}, ${JSON.stringify(sourceMeta)}::text::jsonb)
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

  // A10.3 — TTD prep. Three endpoints the ttdPrepWorkflow uses in sequence:
  //   due            → list imminent windows across every user in the org
  //   pilgrim list   → decrypted pilgrim pack for a target user
  //   notified       → bulk mark windows as pinged so we don't re-ping
  // All three bypass per-user RLS via SECURITY DEFINER helpers / target-user
  // withTenantTx; scope checks are the gate.

  "/api/integrations/ttd-windows/due": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "ttd:read");
      const url = new URL(req.url);
      const withinHours   = Math.max(1,  Math.min(168, Number(url.searchParams.get("withinHours")   ?? 48)));
      const renotifyHours = Math.max(1,  Math.min(168, Number(url.searchParams.get("renotifyHours") ?? 24)));
      const releaseCutoff  = new Date(Date.now() + withinHours   * 3600 * 1000);
      const renotifyCutoff = new Date(Date.now() - renotifyHours * 3600 * 1000);
      // to_jsonb cast → JS array; Bun.SQL otherwise hands back the raw
      // Postgres array literal "{a,b,c}" as a string.
      const rows = await sql`
        SELECT window_id                   AS "windowId",
               user_id                     AS "userId",
               darshan_date                AS "darshanDate",
               slot_type                   AS "slotType",
               release_at                  AS "releaseAt",
               to_jsonb(pilgrim_ids)       AS "pilgrimIds",
               note,
               booking_ref                 AS "bookingRef",
               last_notified_at            AS "lastNotifiedAt"
        FROM list_due_ttd_windows(${ctx.orgId}::uuid, ${releaseCutoff}, ${renotifyCutoff})
      `;
      return Response.json(rows);
    }),
  },

  "/api/integrations/pilgrim-identities": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "pilgrim:read");
      const url = new URL(req.url);
      const targetUserId = url.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }
      const idsParam = url.searchParams.get("ids");
      const idsFilter = idsParam
        ? idsParam.split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s))
        : null;

      const dek = getPilgrimIdentitiesDek();
      const rows = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => {
          const base = await tx`
            SELECT id, full_name AS "fullName", gender,
                   id_type AS "idType", relationship, note, metadata,
                   CASE WHEN pii_enc IS NULL
                        THEN NULL
                        ELSE pgp_sym_decrypt(pii_enc, ${dek})::text
                   END AS "piiJson"
            FROM pilgrim_identities
            ORDER BY (relationship = 'self') DESC, created_at ASC
          `;
          return base;
        }
      );
      const shaped = rows.map((r: Record<string, unknown>) => {
        const { piiJson, ...rest } = r;
        const pii: PilgrimPii = piiJson ? JSON.parse(String(piiJson)) : {};
        return { ...rest, pii };
      });
      const filtered = idsFilter ? shaped.filter((r: { id: string }) => idsFilter.includes(r.id)) : shaped;

      await writeAudit(ctx.tx, ctx, {
        action: "pilgrim_identity:read_via_integration",
        resourceType: "pilgrim_identity",
        metadata: { targetUserId, returned: filtered.length, tokenId: ctx.tokenId },
      });

      return Response.json(filtered);
    }),
  },

  "/api/integrations/ttd-windows/notified": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "ttd:read");
      const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
      if (!Array.isArray(body.ids)) throw new HttpError(400, "ids: uuid[] is required");
      const ids = body.ids
        .filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
      if (ids.length === 0) return Response.json({ updated: 0 });

      const [row] = await sql`
        SELECT mark_ttd_windows_notified(${ctx.orgId}::uuid, ${textArrayLiteral(ids)}::uuid[]) AS "updated"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "ttd_window:notified_via_integration",
        resourceType: "ttd_window",
        metadata: { count: row.updated, tokenId: ctx.tokenId },
      });

      return Response.json({ updated: row.updated });
    }),
  },

  // A2.2 — profile read for the Jobs fetcher. Workers need keywords/location/
  // skills to drive external APIs. scope `profile:read`.
  "/api/integrations/user-profile": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "profile:read");
      const url = new URL(req.url);
      const targetUserId = url.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }
      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => {
          const [r] = await tx`
            SELECT headline,
                   years_exp       AS "yearsExp",
                   location,
                   remote_pref     AS "remotePref",
                   min_salary_lpa  AS "minSalaryLpa",
                   currency,
                   skills, keywords, anti_keywords AS "antiKeywords",
                   bio, metadata
            FROM user_profile WHERE user_id = ${targetUserId}::uuid
          `;
          return r ?? null;
        }
      );
      return Response.json(row);
    }),
  },

  // A2.2 — job_leads upsert. Idempotent on (user, source, source_id) via
  // ON CONFLICT. Classify/score fields (score, score_reason, status) are
  // separate so the fetcher doesn't clobber the classifier's work on re-runs.
  "/api/integrations/job-leads": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "jobs:write");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId (uuid) is required");
      }
      const asStr = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
      const asNum = (v: unknown) => {
        if (v === null || v === undefined || v === "") return null;
        const n = typeof v === "number" ? v : parseFloat(String(v));
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
      };
      const source = asStr(body.source);
      const sourceId = asStr(body.sourceId ?? body.source_id);
      const title = asStr(body.title);
      const url = asStr(body.url);
      if (!source || !sourceId || !title || !url) {
        throw new HttpError(400, "source, sourceId, title, url are required");
      }
      const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown> : {};

      const result = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          const [row] = await tx`
            INSERT INTO job_leads
              (org_id, user_id, source, source_id, title, company, location, url,
               salary_min, salary_max, currency, salary_period, description,
               posted_at, metadata)
            VALUES
              (${ctx.orgId}::uuid, ${body.userId}::uuid,
               ${source}, ${sourceId}, ${title},
               ${asStr(body.company)}, ${asStr(body.location)}, ${url},
               ${asNum(body.salaryMin ?? body.salary_min)},
               ${asNum(body.salaryMax ?? body.salary_max)},
               ${asStr(body.currency)}, ${asStr(body.salaryPeriod ?? body.salary_period)},
               ${asStr(body.description)},
               ${asStr(body.postedAt ?? body.posted_at)},
               ${JSON.stringify(metadata)}::text::jsonb)
            ON CONFLICT (user_id, source, source_id) DO UPDATE SET
              title       = EXCLUDED.title,
              company     = EXCLUDED.company,
              location    = EXCLUDED.location,
              url         = EXCLUDED.url,
              salary_min  = EXCLUDED.salary_min,
              salary_max  = EXCLUDED.salary_max,
              currency    = EXCLUDED.currency,
              salary_period = EXCLUDED.salary_period,
              description = EXCLUDED.description,
              posted_at   = EXCLUDED.posted_at,
              metadata    = job_leads.metadata || EXCLUDED.metadata,
              updated_at  = now()
            RETURNING id, source, source_id AS "sourceId", title,
                      created_at AS "createdAt",
                      (xmax = 0) AS "created"
          `;
          return row;
        }
      );

      await writeAudit(ctx.tx, ctx, {
        action: "job_lead:ingest_via_integration",
        resourceType: "job_lead",
        resourceId: String(result.id),
        metadata: { targetUserId: body.userId, source, sourceId, created: Boolean(result.created), tokenId: ctx.tokenId },
      });

      return Response.json(result, { status: result.created ? 201 : 200 });
    }),
  },

  // A3.prep — worker fetches a single lead to research. Scope: jobs:read.
  // Target user in query; CC re-enters under withTenantTx for RLS.
  "/api/integrations/job-leads/:id": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "jobs:read");
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const url = new URL(req.url);
      const targetUserId = url.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }
      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => {
          const [r] = await tx`
            SELECT id, source, source_id AS "sourceId",
                   title, company, location, url,
                   salary_min AS "salaryMin", salary_max AS "salaryMax",
                   currency, salary_period AS "salaryPeriod",
                   description, posted_at AS "postedAt",
                   score, score_reason AS "scoreReason"
            FROM job_leads WHERE id = ${id}::uuid
          `;
          return r ?? null;
        }
      );
      if (!row) throw new HttpError(404, "job lead not found");
      return Response.json(row);
    }),
  },

  // A4 — upsert a round discovered from Google Calendar. Idempotent per
  // metadata.calendarEventId: a re-sync of the same event updates in place.
  "/api/integrations/interview-rounds/from-calendar": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "interviews:write");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) throw new HttpError(400, "userId uuid required");
      if (typeof body.sessionId !== "string" || !UUID_RE.test(body.sessionId)) throw new HttpError(400, "sessionId uuid required");
      const calendarEventId = typeof body.calendarEventId === "string" && body.calendarEventId.trim() ? body.calendarEventId.trim() : null;
      if (!calendarEventId) throw new HttpError(400, "calendarEventId required");
      const kind = typeof body.kind === "string" ? body.kind : "other";
      const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt : null;
      if (!scheduledAt) throw new HttpError(400, "scheduledAt required");
      const durationMin = typeof body.durationMin === "number" ? Math.max(0, Math.round(body.durationMin)) : null;
      const interviewer = typeof body.interviewer === "string" && body.interviewer.trim() ? body.interviewer.trim() : null;
      const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

      const result = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          const [existing] = await tx`
            SELECT id FROM interview_rounds
            WHERE session_id = ${body.sessionId}::uuid
              AND metadata->>'calendarEventId' = ${calendarEventId}
            LIMIT 1
          `;
          if (existing) {
            const [row] = await tx`
              UPDATE interview_rounds
              SET kind = ${kind},
                  scheduled_at = ${scheduledAt}::timestamptz,
                  duration_min = ${durationMin},
                  interviewer  = COALESCE(${interviewer}, interviewer),
                  notes        = COALESCE(${notes}, notes),
                  updated_at   = now()
              WHERE id = ${existing.id}::uuid
              RETURNING id
            `;
            return { id: row.id, created: false };
          }
          const [row] = await tx`
            INSERT INTO interview_rounds
              (org_id, user_id, session_id, kind, scheduled_at, duration_min,
               interviewer, notes, metadata)
            VALUES
              (${ctx.orgId}::uuid, ${body.userId}::uuid, ${body.sessionId}::uuid,
               ${kind}, ${scheduledAt}::timestamptz, ${durationMin},
               ${interviewer}, ${notes},
               jsonb_build_object('calendarEventId', to_jsonb(${calendarEventId}::text), 'via', 'a4.calendar'))
            RETURNING id
          `;
          return { id: row.id, created: true };
        }
      );

      await writeAudit(ctx.tx, ctx, {
        action: "interview_round:calendar_upsert",
        resourceType: "interview_round",
        resourceId: String(result.id),
        metadata: { calendarEventId, sessionId: body.sessionId, created: result.created, tokenId: ctx.tokenId },
      });

      return Response.json(result, { status: result.created ? 201 : 200 });
    }),
  },

  // A4 — list rounds coming up in the next N hours that haven't been pinged
  // in the renotify window. SECURITY DEFINER on the raw sql so the worker
  // can see every user's rounds in the org from one call.
  "/api/integrations/interview-rounds/due": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "interviews:read");
      const u = new URL(req.url);
      const withinHours = Math.max(1, Math.min(168, Number(u.searchParams.get("withinHours") ?? 24)));
      const renotifyHours = Math.max(1, Math.min(168, Number(u.searchParams.get("renotifyHours") ?? 24)));
      const cutoffUpper = new Date(Date.now() + withinHours * 3600 * 1000);
      const renotifyCutoff = new Date(Date.now() - renotifyHours * 3600 * 1000);
      const rows = await sql`
        SELECT round_id         AS "roundId",
               session_id       AS "sessionId",
               user_id          AS "userId",
               kind,
               scheduled_at     AS "scheduledAt",
               duration_min     AS "durationMin",
               interviewer,
               notes,
               company, role,
               last_notified_at AS "lastNotifiedAt"
        FROM list_due_interview_rounds(${ctx.orgId}::uuid, ${cutoffUpper}, ${renotifyCutoff})
      `;
      return Response.json(rows);
    }),
  },

  // A4 — mark rounds notified in bulk after the worker Slacks them.
  "/api/integrations/interview-rounds/notified": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "interviews:write");
      const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
      if (!Array.isArray(body.ids)) throw new HttpError(400, "ids: uuid[] required");
      const ids = body.ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
      if (ids.length === 0) return Response.json({ updated: 0 });
      const [row] = await sql`
        SELECT mark_interview_rounds_notified(${ctx.orgId}::uuid, ${textArrayLiteral(ids)}::uuid[]) AS updated
      `;
      await writeAudit(ctx.tx, ctx, {
        action: "interview_round:notified_via_integration",
        resourceType: "interview_round",
        metadata: { count: row.updated, tokenId: ctx.tokenId },
      });
      return Response.json({ updated: row.updated });
    }),
  },

  // A3/A4 — the A3.prep worker calls POST to persist an interview_session
  // after researching a job_lead. Idempotent per (user, source_job_lead_id).
  // GET lists active sessions for the A4 calendar matcher.
  "/api/integrations/interview-sessions": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "interviews:read");
      const u = new URL(req.url);
      const targetUserId = u.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }
      const rows = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => tx`
          SELECT id, company, role
          FROM interview_sessions
          WHERE status IN ('researching','applied','interviewing')
          ORDER BY updated_at DESC
          LIMIT 200
        `,
      );
      return Response.json(rows);
    }),

    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "interviews:write");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId (uuid) is required");
      }
      const company = typeof body.company === "string" && body.company.trim() ? body.company.trim() : null;
      const role    = typeof body.role    === "string" && body.role.trim()    ? body.role.trim()    : null;
      if (!company || !role) throw new HttpError(400, "company and role are required");
      const sourceJobLeadId = typeof body.sourceJobLeadId === "string" && UUID_RE.test(body.sourceJobLeadId)
        ? body.sourceJobLeadId : null;
      const notes = typeof body.notes === "string" ? body.notes : null;
      const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown> : {};

      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          // No DB unique on (user_id, source_job_lead_id) — enforce idempotency
          // in TS: if a session already exists for the lead, update it.
          let existingId: string | null = null;
          if (sourceJobLeadId) {
            const [e] = await tx`
              SELECT id FROM interview_sessions
              WHERE source_job_lead_id = ${sourceJobLeadId}::uuid
              LIMIT 1
            `;
            if (e) existingId = String(e.id);
          }

          if (existingId) {
            const [r] = await tx`
              UPDATE interview_sessions
              SET company    = ${company},
                  role       = ${role},
                  notes      = COALESCE(${notes}, notes),
                  metadata   = metadata || ${JSON.stringify(metadata)}::text::jsonb,
                  updated_at = now()
              WHERE id = ${existingId}::uuid
              RETURNING id, company, role,
                        source_job_lead_id AS "sourceJobLeadId",
                        status, created_at AS "createdAt"
            `;
            return { row: r, created: false };
          }
          const [r] = await tx`
            INSERT INTO interview_sessions
              (org_id, user_id, company, role, source_job_lead_id, status, notes, metadata)
            VALUES
              (${ctx.orgId}::uuid, ${body.userId}::uuid,
               ${company}, ${role},
               ${sourceJobLeadId}::uuid,
               'researching',
               ${notes},
               ${JSON.stringify(metadata)}::text::jsonb)
            RETURNING id, company, role,
                      source_job_lead_id AS "sourceJobLeadId",
                      status, created_at AS "createdAt"
          `;
          return { row: r, created: true };
        }
      );

      await writeAudit(ctx.tx, ctx, {
        action: "interview_session:upsert_via_integration",
        resourceType: "interview_session",
        resourceId: String(row.row.id),
        metadata: { targetUserId: body.userId, company, role, sourceJobLeadId, created: row.created, tokenId: ctx.tokenId },
      });

      return Response.json(row.row, { status: row.created ? 201 : 200 });
    }),
  },

  // A8.1 — list a user's enabled learning goals. Worker iterates these and
  // calls the matching source fetcher (GitHub Releases, dev.to tag feed, RSS).
  "/api/integrations/learning-goals": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "learning:read");
      const url = new URL(req.url);
      const targetUserId = url.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }
      const rows = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => tx`
          SELECT id,
                 source_kind AS "sourceKind",
                 target, weight, note, metadata
          FROM learning_goals
          WHERE enabled = true
          ORDER BY weight DESC, created_at ASC
        `
      );
      return Response.json(rows);
    }),
  },

  // A1.1 — knowledge_items create/list for workers. Target user in body/URL;
  // CC re-enters withTenantTx scoped to them so RLS enforces normally. The
  // `knowledge:write` / `knowledge:read` scopes are the gates.
  "/api/integrations/knowledge-items": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "knowledge:write");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId (uuid) is required");
      }
      const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
      if (!title) throw new HttpError(400, "title is required");
      const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : "note";
      const text = typeof body.body === "string" && body.body.trim() ? body.body.trim() : null;
      const tags = Array.isArray(body.tags) ? body.tags.filter((x): x is string => typeof x === "string") : [];
      const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "worker";
      const sourceId = typeof body.sourceId === "string" && body.sourceId.trim() ? body.sourceId.trim() : null;
      const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown> : {};

      // Proper upsert via the partial unique index, so a re-ingest doesn't
      // throw (and poison the transaction). xmax=0 → fresh insert; non-zero
      // → ON CONFLICT path, i.e. existing row reused/updated.
      const result = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          const [row] = await tx`
            INSERT INTO knowledge_items
              (org_id, user_id, type, title, body, tags, source, source_id, metadata)
            VALUES
              (${ctx.orgId}::uuid, ${body.userId}::uuid,
               ${type}, ${title}, ${text},
               ${textArrayLiteral(tags)}::text[],
               ${source}, ${sourceId},
               ${JSON.stringify(metadata)}::text::jsonb)
            ON CONFLICT (user_id, source, source_id) WHERE source_id IS NOT NULL
            DO UPDATE SET
              title      = EXCLUDED.title,
              body       = EXCLUDED.body,
              tags       = EXCLUDED.tags,
              metadata   = knowledge_items.metadata || EXCLUDED.metadata,
              updated_at = now()
            RETURNING id, type, title, source,
                      source_id AS "sourceId",
                      created_at AS "createdAt",
                      (xmax = 0) AS "created"
          `;
          return { row, created: Boolean(row.created) };
        }
      );

      await writeAudit(ctx.tx, ctx, {
        action: "knowledge_item:create_via_integration",
        resourceType: "knowledge_item",
        resourceId: String(result.row.id),
        metadata: { targetUserId: body.userId, type, source, sourceId, created: result.created, tokenId: ctx.tokenId },
      });

      return Response.json(result.row, { status: result.created ? 201 : 200 });
    }),

    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "knowledge:read");
      const url = new URL(req.url);
      const targetUserId = url.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) is required");
      }
      const source = url.searchParams.get("source");
      const type = url.searchParams.get("type");
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 100)));

      const rows = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => tx`
          SELECT id, type, title, source,
                 source_id AS "sourceId",
                 metadata,
                 created_at AS "createdAt"
          FROM knowledge_items
          WHERE (${source}::text IS NULL OR source = ${source})
            AND (${type}::text   IS NULL OR type   = ${type})
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      );
      return Response.json(rows);
    }),
  },

  // A2.3 — classifier writes score + reason onto a job_lead. Separate from
  // the generic PATCH so the fetcher's upsert path can't clobber it, and so
  // the scope split (jobs:write for both; could split further later) stays
  // consistent with the ingest endpoint.
  "/api/integrations/job-leads/:id/score": {
    PATCH: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "jobs:write");
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId (uuid) is required");
      }
      const score = typeof body.score === "number" ? Math.max(1, Math.min(5, Math.round(body.score))) : null;
      if (score == null) throw new HttpError(400, "score (1..5 int) is required");
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          const [r] = await tx`
            UPDATE job_leads
            SET score = ${score},
                score_reason = ${reason},
                classified_at = now(),
                updated_at = now()
            WHERE id = ${id}::uuid
            RETURNING id, score, score_reason AS "scoreReason", classified_at AS "classifiedAt"
          `;
          return r ?? null;
        }
      );
      if (!row) throw new HttpError(404, "job lead not found");

      await writeAudit(ctx.tx, ctx, {
        action: "job_lead:score_via_integration",
        resourceType: "job_lead",
        resourceId: id,
        metadata: { targetUserId: body.userId, score, tokenId: ctx.tokenId },
      });

      return Response.json(row);
    }),
  },

  // A7 — single-item get, body included. userId in query for RLS re-entry.
  "/api/integrations/knowledge-items/:id": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "knowledge:read");
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const u = new URL(req.url);
      const targetUserId = u.searchParams.get("userId");
      if (!targetUserId || !UUID_RE.test(targetUserId)) {
        throw new HttpError(400, "userId query param (uuid) required");
      }
      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: targetUserId, role: ctx.role },
        async (tx) => {
          const [r] = await tx`
            SELECT id, type, title, body, tags, source,
                   source_id AS "sourceId",
                   metadata,
                   created_at AS "createdAt",
                   updated_at AS "updatedAt"
            FROM knowledge_items WHERE id = ${id}::uuid
          `;
          return r ?? null;
        }
      );
      if (!row) throw new HttpError(404, "knowledge item not found");
      return Response.json(row);
    }),
  },

  // Pgvector — list knowledge_items that still need embeddings, cross-user
  // in the token's org. Narrow payload: title + body only (what we feed to
  // the embed model). Scope: knowledge:read.
  "/api/integrations/knowledge-items/unembedded": {
    GET: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "knowledge:read");
      const limit = Math.max(1, Math.min(50, Number(new URL(req.url).searchParams.get("limit") ?? 10)));
      const rows = await sql`
        SELECT id, user_id AS "userId", title, body, type
        FROM list_unembedded_knowledge_items(${ctx.orgId}::uuid, ${limit})
      `;
      return Response.json(rows);
    }),
  },

  // Pgvector — write a 1536-dim embedding to a knowledge_item. userId in
  // body for target-user withTenantTx re-entry. Vector arrives as a
  // number[]; CC formats as a pgvector literal.
  "/api/integrations/knowledge-items/:id/embedding": {
    PATCH: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "knowledge:write");
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId uuid required");
      }
      if (!Array.isArray(body.embedding) || body.embedding.length !== 1536) {
        throw new HttpError(400, "embedding must be a number[1536]");
      }
      for (const n of body.embedding) {
        if (typeof n !== "number" || !Number.isFinite(n)) throw new HttpError(400, "embedding must be finite numbers");
      }
      // pgvector literal: '[v1,v2,...]'. Build once in TS so Bun.SQL binds a
      // simple text parameter — the ::vector cast parses it server-side.
      const vectorLit = `[${(body.embedding as number[]).join(",")}]`;

      const updated = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          const [row] = await tx`
            UPDATE knowledge_items
            SET embedding = ${vectorLit}::vector,
                updated_at = now()
            WHERE id = ${id}::uuid
            RETURNING id
          `;
          return row ?? null;
        }
      );
      if (!updated) throw new HttpError(404, "knowledge item not found");

      await writeAudit(ctx.tx, ctx, {
        action: "knowledge_item:embedded_via_integration",
        resourceType: "knowledge_item",
        resourceId: id,
        metadata: { targetUserId: body.userId, dim: body.embedding.length, tokenId: ctx.tokenId },
      });

      return Response.json({ id, ok: true });
    }),
  },

  // A1.2 — merge new metadata keys into a knowledge_item (classifier output
  // etc). userId in body for the same reason as POST — target-user re-enter
  // under withTenantTx. tags, if provided, replace the array entirely.
  "/api/integrations/knowledge-items/:id/metadata": {
    PATCH: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "knowledge:write");
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId (uuid) is required");
      }
      const patch = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown> : null;
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((x): x is string => typeof x === "string")
        : null;
      if (!patch && !tags) throw new HttpError(400, "metadata or tags is required");

      const row = await withTenantTx(
        { orgId: ctx.orgId, userId: body.userId, role: ctx.role },
        async (tx) => {
          if (patch) {
            await tx`
              UPDATE knowledge_items
              SET metadata = metadata || ${JSON.stringify(patch)}::text::jsonb,
                  updated_at = now()
              WHERE id = ${id}::uuid
            `;
          }
          if (tags) {
            await tx`
              UPDATE knowledge_items
              SET tags = ${textArrayLiteral(tags)}::text[], updated_at = now()
              WHERE id = ${id}::uuid
            `;
          }
          const [r] = await tx`
            SELECT id, title, tags, metadata, updated_at AS "updatedAt"
            FROM knowledge_items WHERE id = ${id}::uuid
          `;
          return r ?? null;
        }
      );
      if (!row) throw new HttpError(404, "knowledge item not found");

      await writeAudit(ctx.tx, ctx, {
        action: "knowledge_item:metadata_merge_via_integration",
        resourceType: "knowledge_item",
        resourceId: id,
        metadata: { targetUserId: body.userId, patchedKeys: patch ? Object.keys(patch) : [], tagsReplaced: Boolean(tags), tokenId: ctx.tokenId },
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
