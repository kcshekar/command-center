import { tenantRoute } from "../../core/router";
import { HttpError } from "../../core/auth";
import { writeAudit } from "../../core/audit";
import { textArrayLiteral } from "../../core/pg-array";

// A10.2 — CRUD for ttd_windows.
//
// darshan_date comes in as 'YYYY-MM-DD'; release_at as ISO-8601. If release_at
// isn't given on POST we default it to darshan_date - 60 days at 10:00 IST,
// which matches TTD's usual quota release.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SLOT_TYPES = ["ssd", "vip_break", "suprabhatam", "archana", "kalyanam", "other"] as const;
export const STATUSES   = ["planned", "booked", "missed", "cancelled"] as const;

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}
function asUuidArray(v: unknown): string[] {
  const out = asStringArray(v).filter((x) => UUID_RE.test(x));
  if (Array.isArray(v) && v.length > 0 && out.length === 0) {
    throw new HttpError(400, "pilgrimIds must be an array of uuids");
  }
  return out;
}
function asMetadata(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

// darshan_date (YYYY-MM-DD) → ISO timestamp at 10:00 IST, 60 days earlier.
// Uses ms arithmetic + Intl so the result doesn't drift with the process TZ.
function defaultReleaseAt(darshanDate: string): string {
  const anchor = new Date(`${darshanDate}T00:00:00+05:30`);
  const sixtyBefore = new Date(anchor.getTime() - 60 * 86400 * 1000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(sixtyBefore);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}T10:00:00+05:30`;
}

export const ttdWindowRoutes = {
  "/api/ttd-windows": {
    GET: tenantRoute(async (req, ctx) => {
      const url = new URL(req.url);
      const status = url.searchParams.get("status");
      const rows = await ctx.tx`
        SELECT id,
               darshan_date      AS "darshanDate",
               slot_type         AS "slotType",
               release_at        AS "releaseAt",
               status,
               booking_ref       AS "bookingRef",
               to_jsonb(pilgrim_ids) AS "pilgrimIds",
               note,
               metadata,
               last_notified_at  AS "lastNotifiedAt",
               created_at        AS "createdAt",
               updated_at        AS "updatedAt"
        FROM ttd_windows
        WHERE (${status}::text IS NULL OR status = ${status})
        ORDER BY darshan_date ASC, release_at ASC NULLS LAST
      `;
      return Response.json(rows);
    }),

    POST: tenantRoute(async (req, ctx) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

      const darshanDate = asString(body.darshanDate ?? body.darshan_date);
      if (!darshanDate || !DATE_RE.test(darshanDate)) {
        throw new HttpError(400, "darshanDate (YYYY-MM-DD) is required");
      }
      const slotType = asString(body.slotType ?? body.slot_type) ?? "ssd";
      if (!(SLOT_TYPES as readonly string[]).includes(slotType)) {
        throw new HttpError(400, `slotType must be one of: ${SLOT_TYPES.join(", ")}`);
      }
      const explicitRelease = asString(body.releaseAt ?? body.release_at);
      let releaseAt: string | null;
      if (explicitRelease) {
        const d = new Date(explicitRelease);
        if (Number.isNaN(d.getTime())) throw new HttpError(400, "releaseAt must be a valid ISO timestamp");
        releaseAt = d.toISOString();
      } else {
        releaseAt = defaultReleaseAt(darshanDate);
      }
      const pilgrimIds = asUuidArray(body.pilgrimIds ?? body.pilgrim_ids);
      const note = asString(body.note);
      const metadata = asMetadata(body.metadata);

      const [row] = await ctx.tx`
        INSERT INTO ttd_windows
          (org_id, user_id, darshan_date, slot_type, release_at, pilgrim_ids, note, metadata)
        VALUES
          (${ctx.orgId}::uuid, ${ctx.userId}::uuid,
           ${darshanDate}::date, ${slotType},
           ${releaseAt}::timestamptz,
           ${textArrayLiteral(pilgrimIds)}::uuid[],
           ${note}, ${JSON.stringify(metadata)}::text::jsonb)
        RETURNING id,
                  darshan_date      AS "darshanDate",
                  slot_type         AS "slotType",
                  release_at        AS "releaseAt",
                  status,
                  booking_ref       AS "bookingRef",
                  to_jsonb(pilgrim_ids) AS "pilgrimIds",
                  note,
                  metadata,
                  last_notified_at  AS "lastNotifiedAt",
                  created_at        AS "createdAt",
                  updated_at        AS "updatedAt"
      `;

      await writeAudit(ctx.tx, ctx, {
        action: "ttd_window:create",
        resourceType: "ttd_window",
        resourceId: String(row.id),
        metadata: { darshanDate, slotType, pilgrims: pilgrimIds.length },
      });

      return Response.json(row, { status: 201 });
    }),
  },

  "/api/ttd-windows/:id": {
    GET: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const [row] = await ctx.tx`
        SELECT id,
               darshan_date      AS "darshanDate",
               slot_type         AS "slotType",
               release_at        AS "releaseAt",
               status,
               booking_ref       AS "bookingRef",
               to_jsonb(pilgrim_ids) AS "pilgrimIds",
               note,
               metadata,
               last_notified_at  AS "lastNotifiedAt",
               created_at        AS "createdAt",
               updated_at        AS "updatedAt"
        FROM ttd_windows WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "ttd window not found");
      return Response.json(row);
    }),

    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const hasKey = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

      let changed = 0;

      if (hasKey("darshanDate") || hasKey("darshan_date")) {
        const next = asString(body.darshanDate ?? body.darshan_date);
        if (!next || !DATE_RE.test(next)) throw new HttpError(400, "darshanDate (YYYY-MM-DD) required");
        await ctx.tx`UPDATE ttd_windows SET darshan_date = ${next}::date, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("slotType") || hasKey("slot_type")) {
        const next = asString(body.slotType ?? body.slot_type) ?? "ssd";
        if (!(SLOT_TYPES as readonly string[]).includes(next)) {
          throw new HttpError(400, `slotType must be one of: ${SLOT_TYPES.join(", ")}`);
        }
        await ctx.tx`UPDATE ttd_windows SET slot_type = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("releaseAt") || hasKey("release_at")) {
        const raw = asString(body.releaseAt ?? body.release_at);
        const next = raw ? new Date(raw) : null;
        if (raw && Number.isNaN((next as Date).getTime())) {
          throw new HttpError(400, "releaseAt must be a valid ISO timestamp");
        }
        await ctx.tx`UPDATE ttd_windows SET release_at = ${next ? next.toISOString() : null}::timestamptz, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("status")) {
        const next = asString(body.status);
        if (!next || !(STATUSES as readonly string[]).includes(next)) {
          throw new HttpError(400, `status must be one of: ${STATUSES.join(", ")}`);
        }
        await ctx.tx`UPDATE ttd_windows SET status = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("bookingRef") || hasKey("booking_ref")) {
        const next = asString(body.bookingRef ?? body.booking_ref) ?? null;
        await ctx.tx`UPDATE ttd_windows SET booking_ref = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("pilgrimIds") || hasKey("pilgrim_ids")) {
        const next = asUuidArray(body.pilgrimIds ?? body.pilgrim_ids);
        await ctx.tx`UPDATE ttd_windows SET pilgrim_ids = ${textArrayLiteral(next)}::uuid[], updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("note")) {
        const next = asString(body.note) ?? null;
        await ctx.tx`UPDATE ttd_windows SET note = ${next}, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (hasKey("metadata")) {
        const next = asMetadata(body.metadata);
        await ctx.tx`UPDATE ttd_windows SET metadata = ${JSON.stringify(next)}::text::jsonb, updated_at = now() WHERE id = ${id}::uuid`;
        changed++;
      }
      if (changed === 0) {
        throw new HttpError(
          400,
          "no updatable fields: darshanDate | slotType | releaseAt | status | bookingRef | pilgrimIds | note | metadata"
        );
      }

      const [row] = await ctx.tx`
        SELECT id,
               darshan_date      AS "darshanDate",
               slot_type         AS "slotType",
               release_at        AS "releaseAt",
               status,
               booking_ref       AS "bookingRef",
               to_jsonb(pilgrim_ids) AS "pilgrimIds",
               note,
               metadata,
               last_notified_at  AS "lastNotifiedAt",
               created_at        AS "createdAt",
               updated_at        AS "updatedAt"
        FROM ttd_windows WHERE id = ${id}::uuid
      `;
      if (!row) throw new HttpError(404, "ttd window not found");

      await writeAudit(ctx.tx, ctx, {
        action: "ttd_window:update",
        resourceType: "ttd_window",
        resourceId: id,
      });

      return Response.json(row);
    }),

    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) throw new HttpError(400, "id must be a uuid");
      const deleted = await ctx.tx`DELETE FROM ttd_windows WHERE id = ${id}::uuid RETURNING id`;
      if (deleted.length === 0) throw new HttpError(404, "ttd window not found");

      await writeAudit(ctx.tx, ctx, {
        action: "ttd_window:delete",
        resourceType: "ttd_window",
        resourceId: id,
      });
      return new Response(null, { status: 204 });
    }),
  },
};
