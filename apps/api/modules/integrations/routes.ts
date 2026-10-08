import { serviceTokenRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";
import { requireScope } from "../../core/service-token";
import { sendSlackMessage } from "../../core/slack";
import { postBlockKit, updateMessage } from "../../core/slack-post";

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

  // Worker never holds Slack tokens (D5). To post, it names a route key and
  // CC resolves it through the same registry the reminder sweeper uses.
  "/api/integrations/slack-send": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "slack:send");
      const { routeKey, text } = await req.json();
      if (!routeKey?.trim() || !text?.trim()) throw new HttpError(400, "routeKey and text are required");
      await sendSlackMessage(text, { routeKey: routeKey.trim(), tx: ctx.tx, orgId: ctx.orgId });
      await writeAudit(ctx.tx, ctx, {
        action: "slack:send_via_integration",
        resourceType: "slack_route",
        metadata: { routeKey, tokenId: ctx.tokenId },
      });
      return Response.json({ ok: true });
    }),
  },

  // Posts an interactive Block Kit card. Returns the (channel, ts) pair so
  // the workflow can hand it back on chat.update after the decision lands.
  "/api/integrations/slack-approval": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "slack:send");
      const { routeKey, text, blocks } = await req.json();
      if (!routeKey?.trim() || !text?.trim() || !Array.isArray(blocks)) {
        throw new HttpError(400, "routeKey, text, blocks are required");
      }
      const posted = await postBlockKit(ctx.tx, ctx.orgId, routeKey.trim(), { text, blocks });
      await writeAudit(ctx.tx, ctx, {
        action: "slack:approval_posted",
        resourceType: "slack_route",
        metadata: { routeKey, tokenId: ctx.tokenId, ts: posted.ts },
      });
      return Response.json(posted);
    }),
  },

  // Rare: worker rewriting its own posted card if the flow ended before a
  // button was clicked (24h timeout etc.). Socket-mode's handler updates the
  // message on click by itself, so this is only for the "no click" paths.
  "/api/integrations/slack-update": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "slack:send");
      const { routeKey, channel, ts, text, blocks } = await req.json();
      if (!routeKey?.trim() || !channel || !ts || !text?.trim()) {
        throw new HttpError(400, "routeKey, channel, ts, text are required");
      }
      await updateMessage(ctx.tx, ctx.orgId, routeKey.trim(), { channel, ts, text, blocks });
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
};
