import { tenantRoute } from "../../core/router";
import { writeAudit } from "../../core/audit";
import { HttpError } from "../../core/auth";

// Life trackers logged from phone-friendly pages (decision 2026-10-27):
//   R11 habits (+ daily check-ins)   R7 grocery list   R9 vehicles (+ fuel/service logs)
// All rows are owner-only via RLS (migrations 0057–0059); every role manages
// their own. The worker reads them via /api/integrations/life/* (life:read).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export const lifeRoutes = {
  // --- R11 habits --------------------------------------------------------
  "/api/habits": {
    // Active habits with the dates they were done in the last ?days (default 56).
    GET: tenantRoute(async (req, ctx) => {
      const n = Number(new URL(req.url).searchParams.get("days") ?? 56);
      const days = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 400) : 56;
      return Response.json(await ctx.tx`
        SELECT h.id, h.name, h.active,
               COALESCE(array_agg(to_char(l.logged_on, 'YYYY-MM-DD') ORDER BY l.logged_on)
                        FILTER (WHERE l.logged_on IS NOT NULL), '{}') AS done
        FROM habits h
        LEFT JOIN habit_logs l ON l.habit_id = h.id AND l.logged_on >= CURRENT_DATE - ${days}::int
        GROUP BY h.id
        ORDER BY h.active DESC, h.created_at
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const name = text((await req.json().catch(() => ({}))).name, 80);
      if (!name) throw new HttpError(400, "name is required");
      const [row] = await ctx.tx`
        INSERT INTO habits (org_id, owner_user_id, name) VALUES (${ctx.orgId}, ${ctx.userId}, ${name}) RETURNING id, name, active
      `;
      await writeAudit(ctx.tx, ctx, { action: "habit:create", resourceType: "habit", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/habits/:id": {
    PATCH: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const body = await req.json().catch(() => ({}));
      const name = body.name === undefined ? null : text(body.name, 80);
      if (body.name !== undefined && !name) throw new HttpError(400, "name can't be empty");
      const active = typeof body.active === "boolean" ? body.active : null;
      const [row] = await ctx.tx`
        UPDATE habits SET name = COALESCE(${name}, name), active = COALESCE(${active}, active)
        WHERE id = ${id} RETURNING id, name, active
      `;
      if (!row) throw new HttpError(404, "not found");
      return Response.json(row);
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const [row] = await ctx.tx`DELETE FROM habits WHERE id = ${req.params.id} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "habit:delete", resourceType: "habit", resourceId: req.params.id });
      return new Response(null, { status: 204 });
    }),
  },
  // Mark a day done (done: true) or undo it (done: false).
  "/api/habits/:id/log": {
    PUT: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const { on, done } = await req.json().catch(() => ({}));
      if (typeof on !== "string" || !DATE_RE.test(on)) throw new HttpError(400, "on (YYYY-MM-DD) is required");
      if (typeof done !== "boolean") throw new HttpError(400, "done must be a boolean");
      const [habit] = await ctx.tx`SELECT id FROM habits WHERE id = ${id}`;
      if (!habit) throw new HttpError(404, "not found");
      if (done) {
        await ctx.tx`
          INSERT INTO habit_logs (habit_id, org_id, owner_user_id, logged_on) VALUES (${id}, ${ctx.orgId}, ${ctx.userId}, ${on}::date)
          ON CONFLICT (habit_id, logged_on) DO NOTHING
        `;
      } else {
        await ctx.tx`DELETE FROM habit_logs WHERE habit_id = ${id} AND logged_on = ${on}::date`;
      }
      return Response.json({ ok: true });
    }),
  },

  // --- R7 groceries --------------------------------------------------------
  "/api/groceries": {
    // Open items, plus what was bought in the last 3 days (so a mis-tap can be undone).
    GET: tenantRoute(async (_req, ctx) => Response.json(await ctx.tx`
      SELECT id, name, done, created_at, done_at FROM grocery_items
      WHERE NOT done OR done_at > now() - interval '3 days'
      ORDER BY done, created_at
    `)),
    // { text: "atta 5kg, butter\nmilk" } → one item per comma or line.
    POST: tenantRoute(async (req, ctx) => {
      const raw = (await req.json().catch(() => ({}))).text;
      const names = typeof raw === "string"
        ? [...new Set(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 80)))]
        : [];
      if (names.length === 0) throw new HttpError(400, "text with at least one item is required");
      if (names.length > 50) throw new HttpError(400, "add at most 50 items at once");
      const rows = [];
      for (const name of names) {
        const [row] = await ctx.tx`
          INSERT INTO grocery_items (org_id, owner_user_id, name) VALUES (${ctx.orgId}, ${ctx.userId}, ${name})
          RETURNING id, name, done, created_at, done_at
        `;
        rows.push(row);
      }
      return Response.json(rows, { status: 201 });
    }),
  },
  "/api/groceries/:id": {
    PATCH: tenantRoute(async (req, ctx) => {
      const { done } = await req.json().catch(() => ({}));
      if (typeof done !== "boolean") throw new HttpError(400, "done must be a boolean");
      const [row] = await ctx.tx`
        UPDATE grocery_items SET done = ${done}, done_at = ${done ? new Date() : null}
        WHERE id = ${req.params.id} RETURNING id, name, done, created_at, done_at
      `;
      if (!row) throw new HttpError(404, "not found");
      return Response.json(row);
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const [row] = await ctx.tx`DELETE FROM grocery_items WHERE id = ${req.params.id} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      return new Response(null, { status: 204 });
    }),
  },

  // --- R14 trips ---------------------------------------------------------------
  "/api/travel": {
    // Upcoming bookings plus the last 30 days (so a just-finished trip is still there).
    GET: tenantRoute(async (_req, ctx) => Response.json(await ctx.tx`
      SELECT id, kind, provider, reference, from_place, to_place, depart_at, end_at
      FROM travel_bookings WHERE depart_at > now() - interval '30 days'
      ORDER BY depart_at
    `)),
  },
  "/api/travel/:id": {
    DELETE: tenantRoute(async (req, ctx) => {
      const [row] = await ctx.tx`DELETE FROM travel_bookings WHERE id = ${req.params.id} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      return new Response(null, { status: 204 });
    }),
  },

  // --- R9 vehicles -------------------------------------------------------------
  "/api/vehicles": {
    // Vehicles with their last 30 logs (newest first).
    GET: tenantRoute(async (_req, ctx) => Response.json(await ctx.tx`
      SELECT v.id, v.name, v.service_every_km, v.service_every_months,
             COALESCE((
               SELECT json_agg(l ORDER BY l.logged_on DESC, l.odometer_km DESC)
               FROM (SELECT id, kind, to_char(logged_on, 'YYYY-MM-DD') AS logged_on, odometer_km, litres::float AS litres,
                            amount_cents::float AS amount_cents, full_tank, notes
                     FROM vehicle_logs WHERE vehicle_id = v.id
                     ORDER BY logged_on DESC, odometer_km DESC LIMIT 30) l
             ), '[]'::json) AS logs
      FROM vehicles v ORDER BY v.created_at
    `)),
    POST: tenantRoute(async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const name = text(body.name, 60);
      if (!name) throw new HttpError(400, "name is required");
      const km = body.serviceEveryKm ? Math.trunc(Number(body.serviceEveryKm)) : null;
      const months = body.serviceEveryMonths ? Math.trunc(Number(body.serviceEveryMonths)) : null;
      if ((km !== null && !(km > 0)) || (months !== null && !(months > 0))) throw new HttpError(400, "service intervals must be positive");
      const [row] = await ctx.tx`
        INSERT INTO vehicles (org_id, owner_user_id, name, service_every_km, service_every_months)
        VALUES (${ctx.orgId}, ${ctx.userId}, ${name}, ${km}, ${months}) RETURNING id, name
      `;
      await writeAudit(ctx.tx, ctx, { action: "vehicle:create", resourceType: "vehicle", resourceId: row.id });
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/vehicles/:id": {
    DELETE: tenantRoute(async (req, ctx) => {
      const [row] = await ctx.tx`DELETE FROM vehicles WHERE id = ${req.params.id} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "vehicle:delete", resourceType: "vehicle", resourceId: req.params.id });
      return new Response(null, { status: 204 });
    }),
  },
  "/api/vehicles/:id/logs": {
    POST: tenantRoute(async (req, ctx) => {
      const { id } = req.params;
      const b = await req.json().catch(() => ({}));
      if (b.kind !== "fuel" && b.kind !== "service") throw new HttpError(400, "kind must be fuel | service");
      if (typeof b.on !== "string" || !DATE_RE.test(b.on)) throw new HttpError(400, "on (YYYY-MM-DD) is required");
      const odo = Math.trunc(Number(b.odometerKm));
      if (!Number.isFinite(odo) || odo < 0) throw new HttpError(400, "odometerKm is required");
      const litres = b.litres == null || b.litres === "" ? null : Number(b.litres);
      if (b.kind === "fuel" && !(litres! > 0)) throw new HttpError(400, "litres is required for a fuel log");
      const amount = b.amountCents == null || b.amountCents === "" ? null : Math.round(Number(b.amountCents));
      const [vehicle] = await ctx.tx`SELECT id FROM vehicles WHERE id = ${id}`;
      if (!vehicle) throw new HttpError(404, "not found");
      const [row] = await ctx.tx`
        INSERT INTO vehicle_logs (org_id, owner_user_id, vehicle_id, kind, logged_on, odometer_km, litres, amount_cents, full_tank, notes)
        VALUES (${ctx.orgId}, ${ctx.userId}, ${id}, ${b.kind}, ${b.on}::date, ${odo}, ${b.kind === "fuel" ? litres : null},
                ${amount}, ${b.fullTank !== false}, ${text(b.notes)})
        RETURNING id
      `;
      return Response.json(row, { status: 201 });
    }),
  },
  "/api/vehicle-logs/:id": {
    DELETE: tenantRoute(async (req, ctx) => {
      const [row] = await ctx.tx`DELETE FROM vehicle_logs WHERE id = ${req.params.id} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      return new Response(null, { status: 204 });
    }),
  },
};
