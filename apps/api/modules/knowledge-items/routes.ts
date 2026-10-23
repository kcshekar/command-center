import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import { textArrayLiteral } from "../../core/pg-array";

// Phase 1.5 — CRUD + text search for knowledge_items.
//
// Scopes:
//   list   — own + org-shared (RLS filters); `scope=own|shared|all` narrows
//   create — own
//   get    — own or shared (RLS filters)
//   update — own only (RLS UPDATE policy enforces)
//   delete — own only
//   search — tsvector + rank over the same visibility set as list
//
// Embeddings are a column, not a code path yet — A1 News / A8 Learning fill
// them async. Keyword search works today via the generated tsvector + GIN.

const KNOWN_TYPES = new Set([
  "note", "journal", "brief", "news", "profile",
  "job", "job_lead", "prep", "lesson", "snippet",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

function asUuidArray(v: unknown): string[] {
  return asStringArray(v).filter((x) => UUID_RE.test(x));
}

function asBool(v: unknown, dflt = false): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function asMetadata(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

export const knowledgeItemRoutes = {
  "/api/knowledge-items": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const type = url.searchParams.get("type");
      const tag = url.searchParams.get("tag");
      const scope = url.searchParams.get("scope") ?? "all"; // own | shared | all
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50)));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

      const rows = await ctx.tx`
        SELECT id,
               user_id          AS "userId",
               type, title, body, tags, source,
               source_id        AS "sourceId",
               related,
               shared_with_org  AS "sharedWithOrg",
               metadata,
               created_at       AS "createdAt",
               updated_at       AS "updatedAt"
        FROM knowledge_items
        WHERE (${type}::text IS NULL OR type = ${type})
          AND (${tag}::text  IS NULL OR ${tag} = ANY(tags))
          AND (
            ${scope} = 'all'
            OR (${scope} = 'own'    AND user_id = ${ctx.userId}::uuid)
            OR (${scope} = 'shared' AND shared_with_org = true)
          )
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const title = asString(body.title);
      if (!title) throw new HttpError(400, "title is required");
      const type = asString(body.type) ?? "note";
      if (!KNOWN_TYPES.has(type)) {
        throw new HttpError(400, `unknown type: ${type} (allowed: ${[...KNOWN_TYPES].join(", ")})`);
      }
      const bodyText = asString(body.body);
      const tags = asStringArray(body.tags);
      const source = asString(body.source) ?? "user";
      const sourceId = asString(body.sourceId ?? body.source_id);
      const related = asUuidArray(body.related);
      const shared = asBool(body.sharedWithOrg ?? body.shared_with_org, false);
      const metadata = asMetadata(body.metadata);

      let row: Record<string, unknown>;
      try {
        [row] = await ctx.tx`
          INSERT INTO knowledge_items
            (org_id, user_id, type, title, body, tags, source, source_id, related, shared_with_org, metadata)
          VALUES
            (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
             ${type}, ${title}, ${bodyText},
             ${textArrayLiteral(tags)}::text[],
             ${source}, ${sourceId},
             ${textArrayLiteral(related)}::uuid[],
             ${shared},
             ${JSON.stringify(metadata)}::jsonb)
          RETURNING id,
                    user_id          AS "userId",
                    type, title, body, tags, source,
                    source_id        AS "sourceId",
                    related,
                    shared_with_org  AS "sharedWithOrg",
                    metadata,
                    created_at       AS "createdAt",
                    updated_at       AS "updatedAt"
        `;
      } catch (err) {
        if (err instanceof Error && /knowledge_items_source_dedup/i.test(err.message)) {
          throw new HttpError(409, `already have an item with source=${source} and sourceId=${sourceId}`);
        }
        throw err;
      }

      await writeAudit(ctx.tx, ctx, {
        action: "knowledge_item:create",
        resourceType: "knowledge_item",
        resourceId: String(row.id),
        metadata: { type, source, sourceId, shared },
      });

      return Response.json(row, { status: 201 });
    }),
  },

  "/api/knowledge-items/search": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) throw new HttpError(400, "q is required");
      const type = url.searchParams.get("type");
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 20)));

      // plainto_tsquery handles multi-word queries safely without us parsing
      // operators. Switch to websearch_to_tsquery later if we want quoted phrases.
      const rows = await ctx.tx`
        SELECT id,
               user_id          AS "userId",
               type, title, body, tags, source,
               source_id        AS "sourceId",
               related,
               shared_with_org  AS "sharedWithOrg",
               metadata,
               created_at       AS "createdAt",
               updated_at       AS "updatedAt",
               ts_rank(tsv, plainto_tsquery('english', ${q})) AS rank
        FROM knowledge_items
        WHERE tsv @@ plainto_tsquery('english', ${q})
          AND (${type}::text IS NULL OR type = ${type})
        ORDER BY rank DESC, updated_at DESC
        LIMIT ${limit}
      `;
      return Response.json(rows);
    }),
  },

  "/api/knowledge-items/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT id,
               user_id          AS "userId",
               type, title, body, tags, source,
               source_id        AS "sourceId",
               related,
               shared_with_org  AS "sharedWithOrg",
               metadata,
               created_at       AS "createdAt",
               updated_at       AS "updatedAt"
        FROM knowledge_items WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "knowledge item not found");
      return Response.json(row);
    }),

    // One UPDATE per changed column — Bun.SQL parameterises each ${}, so
    // dynamic SET building needs separate statements to stay injection-safe
    // (same pattern as price-watches PATCH).
    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      let changed = 0;

      if (hasKey("title")) {
        const title = asString(body.title);
        if (!title) throw new HttpError(400, "title cannot be cleared");
        await ctx.tx`UPDATE knowledge_items SET title = ${title}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("type")) {
        const type = asString(body.type);
        if (!type || !KNOWN_TYPES.has(type)) throw new HttpError(400, `unknown type: ${type}`);
        await ctx.tx`UPDATE knowledge_items SET type = ${type}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("body")) {
        const bodyText = asString(body.body) ?? null;
        await ctx.tx`UPDATE knowledge_items SET body = ${bodyText}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("tags")) {
        const tags = asStringArray(body.tags);
        await ctx.tx`UPDATE knowledge_items SET tags = ${textArrayLiteral(tags)}::text[], updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("related")) {
        const related = asUuidArray(body.related);
        await ctx.tx`UPDATE knowledge_items SET related = ${textArrayLiteral(related)}::uuid[], updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("sharedWithOrg") || hasKey("shared_with_org")) {
        const shared = asBool(body.sharedWithOrg ?? body.shared_with_org);
        await ctx.tx`UPDATE knowledge_items SET shared_with_org = ${shared}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("metadata")) {
        const metadata = asMetadata(body.metadata);
        await ctx.tx`UPDATE knowledge_items SET metadata = ${JSON.stringify(metadata)}::jsonb, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) {
        throw new HttpError(400, "no updatable fields: title | type | body | tags | related | sharedWithOrg | metadata");
      }

      const [row] = await ctx.tx`
        SELECT id,
               user_id          AS "userId",
               type, title, body, tags, source,
               source_id        AS "sourceId",
               related,
               shared_with_org  AS "sharedWithOrg",
               metadata,
               created_at       AS "createdAt",
               updated_at       AS "updatedAt"
        FROM knowledge_items WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "knowledge item not found or not owned by you");

      await writeAudit(ctx.tx, ctx, {
        action: "knowledge_item:update",
        resourceType: "knowledge_item",
        resourceId: id,
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM knowledge_items WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "knowledge item not found or not owned by you");

      await writeAudit(ctx.tx, ctx, {
        action: "knowledge_item:delete",
        resourceType: "knowledge_item",
        resourceId: id,
      });

      return new Response(null, { status: 204 });
    }),
  },
};
