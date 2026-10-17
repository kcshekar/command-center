import { serviceTokenRoute, tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { requireScope } from "../../core/service-token";
import { notify, postApproval, updateNotification } from "../../core/notify";
import { textArrayLiteral } from "../../core/pg-array";

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
};
