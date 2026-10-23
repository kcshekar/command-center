import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import { temporalClient } from "../../core/temporal";
import { log } from "../../core/log";

const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";

// Fire-and-forget: the user's POST should not fail because Temporal is down
// or slow. If we can't start the workflow we log and move on; the watch
// still exists and the daily-poll workflow (2.6) will pick it up.
async function startInitialFetch(input: {
  watchId: string;
  userId: string;
  source: string;
  externalId: string | null;
  url: string;
}): Promise<void> {
  try {
    const client = await temporalClient();
    await client.workflow.start("priceWatchInitialFetchWorkflow", {
      taskQueue: TEMPORAL_TASK_QUEUE,
      workflowId: `price-watch-initial-fetch-${input.watchId}`,
      args: [input],
    });
  } catch (err) {
    log.warn("price-watch initial fetch workflow start failed", {
      watchId: input.watchId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// A6 Price Watcher — user-facing CRUD for price_watches + a nested history
// view. The worker populates current_price / title / image_url / history
// asynchronously (2.4); until then a watch sits in the DB with
// current_price = NULL and the UI shows "fetching…".
//
// Site detection is intentionally dumb: Amazon ASIN via URL regex,
// Flipkart `pid` from the query string, everything else labelled 'generic'.
// The worker owns the actual fetch and will store richer metadata when it
// reports back.

function detectSource(raw: string): { source: string; externalId: string | null } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "url must be a valid http(s) URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new HttpError(400, "url must be http(s)");
  }
  const host = u.hostname.toLowerCase();
  if (host.includes("amazon.")) {
    const m = u.pathname.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/);
    return { source: "amazon", externalId: m?.[1] ?? null };
  }
  if (host.includes("flipkart.")) {
    return { source: "flipkart", externalId: u.searchParams.get("pid") };
  }
  return { source: "generic", externalId: null };
}

function parseTargetPrice(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, "target_price must be a positive number");
  }
  return Math.round(n * 100) / 100;
}

export const priceWatchRoutes = {
  "/api/price-watches": {
    GET: tenantRoute(async (_req, ctx) => {
      const rows = await ctx.tx`
        SELECT id,
               url,
               source,
               external_id      AS "externalId",
               title,
               image_url        AS "imageUrl",
               currency,
               target_price     AS "targetPrice",
               current_price    AS "currentPrice",
               current_verdict  AS "currentVerdict",
               last_checked_at  AS "lastCheckedAt",
               paused,
               note,
               created_at       AS "createdAt",
               updated_at       AS "updatedAt"
        FROM price_watches
        ORDER BY created_at DESC
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as {
        url?: unknown;
        target_price?: unknown;
        currency?: unknown;
        note?: unknown;
      };

      if (typeof body.url !== "string" || !body.url.trim()) {
        throw new HttpError(400, "url is required");
      }
      const url = body.url.trim();
      const { source, externalId } = detectSource(url);
      const targetPrice = parseTargetPrice(body.target_price);
      const currency =
        typeof body.currency === "string" && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : "INR";
      const note =
        typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

      let row: Record<string, unknown>;
      try {
        [row] = await ctx.tx`
          INSERT INTO price_watches
            (org_id, user_id, url, source, external_id, currency, target_price, note)
          VALUES
            (${ctx.orgId}::uuid, ${ctx.userId}::uuid, ${url}, ${source},
             ${externalId}, ${currency}, ${targetPrice}, ${note})
          RETURNING id,
                    url,
                    source,
                    external_id     AS "externalId",
                    title,
                    image_url       AS "imageUrl",
                    currency,
                    target_price    AS "targetPrice",
                    current_price   AS "currentPrice",
                    current_verdict AS "currentVerdict",
                    last_checked_at AS "lastCheckedAt",
                    paused,
                    note,
                    created_at      AS "createdAt",
                    updated_at      AS "updatedAt"
        `;
      } catch (err) {
        // UNIQUE (user_id, url) collision → 409
        if (
          err instanceof Error &&
          /duplicate key value|price_watches_user_id_url_key/i.test(err.message)
        ) {
          throw new HttpError(409, "you already have a watch for this URL");
        }
        throw err;
      }

      await writeAudit(ctx.tx, ctx, {
        action: "price_watch:create",
        resourceType: "price_watch",
        resourceId: String(row.id),
        metadata: { source, url },
      });

      // Kick off the one-shot initial-fetch workflow. Not awaited — the
      // workflow runs on the worker and writes back via
      // /api/integrations/price-watches/:id/snapshot.
      void startInitialFetch({
        watchId: String(row.id),
        userId: ctx.userId,
        source,
        externalId,
        url,
      });

      return Response.json(row, { status: 201 });
    }),
  },

  "/api/price-watches/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const [row] = await ctx.tx`
        SELECT id,
               url,
               source,
               external_id     AS "externalId",
               title,
               image_url       AS "imageUrl",
               currency,
               target_price    AS "targetPrice",
               current_price   AS "currentPrice",
               current_verdict AS "currentVerdict",
               last_checked_at AS "lastCheckedAt",
               paused,
               note,
               created_at      AS "createdAt",
               updated_at      AS "updatedAt"
        FROM price_watches
        WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "watch not found");

      const history = await ctx.tx`
        SELECT id, checked_at AS "checkedAt", price, source_meta AS "sourceMeta"
        FROM price_history
        WHERE watch_id = ${id}::uuid
        ORDER BY checked_at DESC
        LIMIT 180
      `;
      return Response.json({ ...row, history });
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const body = (await req.json().catch(() => ({}))) as {
        target_price?: unknown;
        note?: unknown;
        paused?: unknown;
      };

      // Build the SET fragments without stringifying any value — Bun.SQL
      // parameterises each ${} it sees, which keeps us injection-safe but
      // means dynamic SET building needs one UPDATE per column that changed.
      let changed = 0;

      if (body.target_price !== undefined) {
        const target = parseTargetPrice(body.target_price);
        await ctx.tx`UPDATE price_watches SET target_price = ${target}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (typeof body.note === "string" || body.note === null) {
        const note = typeof body.note === "string" ? body.note.trim() || null : null;
        await ctx.tx`UPDATE price_watches SET note = ${note}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (typeof body.paused === "boolean") {
        await ctx.tx`UPDATE price_watches SET paused = ${body.paused}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) {
        throw new HttpError(400, "no updatable fields: target_price | note | paused");
      }

      const [row] = await ctx.tx`
        SELECT id,
               target_price    AS "targetPrice",
               note,
               paused,
               updated_at      AS "updatedAt"
        FROM price_watches
        WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "watch not found");

      await writeAudit(ctx.tx, ctx, {
        action: "price_watch:update",
        resourceType: "price_watch",
        resourceId: id,
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const deleted = await ctx.tx`
        DELETE FROM price_watches WHERE id = ${id}::uuid RETURNING id
      `;
      if (deleted.length === 0) throw new HttpError(404, "watch not found");

      await writeAudit(ctx.tx, ctx, {
        action: "price_watch:delete",
        resourceType: "price_watch",
        resourceId: id,
      });

      return new Response(null, { status: 204 });
    }),
  },
};
