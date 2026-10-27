import { tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

// R3: birthdays / anniversaries. Owner-only via RLS (migration 0054); every
// role manages their own. The worker reads them through
// /api/integrations/occasions with the occasions:read scope.

const KINDS = new Set(["birthday", "anniversary", "other"]);

function parse(body: Record<string, unknown>) {
  const person = typeof body.person === "string" ? body.person.trim() : "";
  const month = Number(body.month);
  const day = Number(body.day);
  const year = body.year == null || body.year === "" ? null : Number(body.year);
  const kind = typeof body.kind === "string" ? body.kind : "birthday";
  if (!person) throw new HttpError(400, "person is required");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpError(400, "month must be 1-12");
  // Feb 29 is allowed; the worker treats it as Feb 28 in non-leap years.
  const maxDay = new Date(Date.UTC(2024, month, 0)).getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > maxDay) throw new HttpError(400, `day must be 1-${maxDay} for that month`);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) throw new HttpError(400, "year must be 1900-2100");
  if (!KINDS.has(kind)) throw new HttpError(400, "kind must be birthday | anniversary | other");
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { person, month, day, year, kind, relationship: text(body.relationship), notes: text(body.notes) };
}

export const occasionRoutes = {
  "/api/occasions": {
    GET: tenantRoute(async (_req, ctx) => Response.json(await ctx.tx`
      SELECT id, person, relationship, kind, month, day, year, notes
      FROM occasions ORDER BY month, day, person
    `)),
    POST: tenantRoute(async (req, ctx) => {
      const o = parse(await req.json().catch(() => ({})));
      const [row] = await ctx.tx`
        INSERT INTO occasions (org_id, owner_user_id, person, relationship, kind, month, day, year, notes)
        VALUES (${ctx.orgId}, ${ctx.userId}, ${o.person}, ${o.relationship}, ${o.kind}, ${o.month}, ${o.day}, ${o.year}, ${o.notes})
        RETURNING id, person, relationship, kind, month, day, year, notes
      `;
      await writeAudit(ctx.tx, ctx, { action: "occasion:create", resourceType: "occasion", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/occasions/:id": {
    PUT: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const o = parse(await req.json().catch(() => ({})));
      const [row] = await ctx.tx`
        UPDATE occasions SET person = ${o.person}, relationship = ${o.relationship}, kind = ${o.kind},
          month = ${o.month}, day = ${o.day}, year = ${o.year}, notes = ${o.notes}, updated_at = now()
        WHERE id = ${id}
        RETURNING id, person, relationship, kind, month, day, year, notes
      `;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "occasion:update", resourceType: "occasion", resourceId: id });
      return Response.json(row);
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const [row] = await ctx.tx`DELETE FROM occasions WHERE id = ${id} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "occasion:delete", resourceType: "occasion", resourceId: id });
      return new Response(null, { status: 204 });
    }),
  },
};
