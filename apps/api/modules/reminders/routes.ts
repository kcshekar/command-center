import type { SQL } from "bun";
import { sql } from "../../core/db";
import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { HttpError } from "../../core/auth";
import { sendSlackMessage } from "../../core/slack";

// Advances due_on past every occurrence up to and including today, so
// acknowledging a reminder that's weeks overdue jumps straight to the next
// future date instead of landing on a still-past one.
// dueOn may arrive as a Date (Bun.sql parses Postgres `date` columns into
// Date objects) or a "YYYY-MM-DD" string (from request bodies) — new Date()
// handles both correctly; string-concatenating "T00:00:00Z" onto a Date
// object does not (it stringifies to garbage first).
function advanceDueDate(dueOn: string | Date, recurrence: "weekly" | "monthly" | "yearly"): string {
  const d = new Date(dueOn);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  do {
    if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCFullYear(d.getUTCFullYear() + 1);
  } while (d <= today);
  return d.toISOString().slice(0, 10);
}

// Notifies once per calendar day per reminder while it's due/overdue and
// unacknowledged (nags daily until acknowledged, not just once ever). Shared
// by the manual trigger endpoint (current org via ctx.tx) and the global
// interval sweep (all orgs, below) so both run identical logic.
async function sweepDueReminders(tx: SQL): Promise<number> {
  const due = await tx`
    SELECT id, title, due_on FROM reminders
    WHERE due_on <= CURRENT_DATE AND (notified_at IS NULL OR notified_at::date < CURRENT_DATE)
  `;
  for (const r of due) {
    await sendSlackMessage(`:bell: Reminder due: *${r.title}* (due ${r.due_on})`);
    await tx`UPDATE reminders SET notified_at = now() WHERE id = ${r.id}`;
  }
  return due.length;
}

// ponytail: in-process setInterval, not a real job scheduler — misses checks
// if the process is down. Fine for a single-instance personal tool; upgrade
// to a proper cron/queue if this ever needs to run across multiple instances
// or guarantee delivery through restarts.
export function startReminderSweepInterval(intervalMs = 60 * 60 * 1000) {
  return setInterval(async () => {
    const orgs = await sql`SELECT id FROM organizations`;
    for (const org of orgs) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_org_id', ${org.id}, true)`;
        await sweepDueReminders(tx);
      });
    }
  }, intervalMs);
}

export const reminderRoutes = {
  "/api/reminders": {
    GET: tenantRoute(async (req, ctx) => {
      const days = Number(new URL(req.url).searchParams.get("days") ?? 30);
      return Response.json(await ctx.tx`
        SELECT id, title, category, due_on, recurrence, notified_at
        FROM reminders
        WHERE due_on <= (CURRENT_DATE + (${days}::int * INTERVAL '1 day'))
        ORDER BY due_on
      `);
    }),
    POST: tenantRoute(async (req, ctx) => {
      const { title, category, dueOn, recurrence, resourceType, resourceId } = await req.json();
      if (!title || !category || !dueOn) throw new HttpError(400, "title, category, dueOn required");
      const [row] = await ctx.tx`
        INSERT INTO reminders (org_id, title, category, resource_type, resource_id, due_on, recurrence, created_by)
        VALUES (${ctx.orgId}, ${title}, ${category}, ${resourceType ?? null}, ${resourceId ?? null}, ${dueOn}, ${recurrence ?? null}, ${ctx.userId})
        RETURNING id, title, category, due_on, recurrence
      `;
      return Response.json(row, { status: 201 });
    }),
  },

  "/api/reminders/:reminderId": {
    PUT: tenantRoute(async (req, ctx) => {
      const { reminderId } = req.params;
      const { title, category, dueOn, recurrence } = await req.json();
      if (!title || !category || !dueOn) throw new HttpError(400, "title, category, dueOn required");
      const [row] = await ctx.tx`
        UPDATE reminders SET title = ${title}, category = ${category}, due_on = ${dueOn}, recurrence = ${recurrence ?? null}
        WHERE id = ${reminderId} RETURNING id
      `;
      if (!row) throw new HttpError(404, "not found");
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { reminderId } = req.params;
      const [row] = await ctx.tx`DELETE FROM reminders WHERE id = ${reminderId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      return new Response(null, { status: 204 });
    }),
  },

  "/api/reminders/:reminderId/acknowledge": {
    POST: tenantRoute(async (req, ctx) => {
      const { reminderId } = req.params;
      const [reminder] = await ctx.tx`SELECT due_on, recurrence FROM reminders WHERE id = ${reminderId}`;
      if (!reminder) throw new HttpError(404, "not found");
      if (reminder.recurrence) {
        const nextDueOn = advanceDueDate(reminder.due_on, reminder.recurrence);
        await ctx.tx`UPDATE reminders SET due_on = ${nextDueOn}, notified_at = NULL WHERE id = ${reminderId}`;
        return Response.json({ ok: true, nextDueOn });
      }
      await ctx.tx`UPDATE reminders SET notified_at = now() WHERE id = ${reminderId}`;
      return Response.json({ ok: true, nextDueOn: null });
    }),
  },

  // Manual/testable trigger for the same sweep the background interval runs,
  // scoped to the caller's own org.
  "/api/reminders/notify-due": {
    POST: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const notified = await sweepDueReminders(ctx.tx);
      return Response.json({ notified });
    }),
  },
};
