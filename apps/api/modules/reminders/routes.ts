import type { SQL } from "bun";
import { sql } from "../../core/db";
import { tenantRoute } from "../../core/router";
import { requireRole } from "../../core/rbac";
import { writeAudit } from "../../core/audit";
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

// Fixed namespace for this lock's classid — any int works, it just has to
// not collide with another advisory-lock use elsewhere in the app (there
// isn't one today). objid is hashtext(org_id), so each org gets its own
// lock instead of one org blocking every other org's sweep.
const REMINDER_SWEEP_LOCK_CLASS = 726352;

// Notifies once per calendar day per reminder while it's due/overdue and
// unacknowledged (nags daily until acknowledged, not just once ever). Shared
// by the manual trigger endpoint (current org via ctx.tx) and the global
// interval sweep (all orgs, below) so both run identical logic.
//
// Guarded by a transaction-scoped advisory lock, per org: without it, the
// interval sweep on a second app instance (or the manual trigger racing the
// interval in the same instance) could SELECT the same due reminders before
// either UPDATEs notified_at, sending the same Slack notification twice.
// pg_try_advisory_xact_lock auto-releases when `tx` commits or rolls back —
// no unlock bookkeeping, and no risk of a leaked lock from a connection-pool
// mismatch, since it lives and dies with this exact transaction.
async function sweepDueReminders(tx: SQL, orgId: string): Promise<number> {
  const [{ locked }] = await tx`SELECT pg_try_advisory_xact_lock(${REMINDER_SWEEP_LOCK_CLASS}, hashtext(${orgId})) AS locked`;
  if (!locked) return 0; // another sweep for this org is already in flight

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
// or guarantee delivery through restarts. Multiple instances running this
// interval concurrently is now safe either way, via the advisory lock above.
export function startReminderSweepInterval(intervalMs = 60 * 60 * 1000) {
  return setInterval(async () => {
    const orgs = await sql`SELECT id FROM organizations`;
    for (const org of orgs) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_org_id', ${org.id}, true)`;
        await sweepDueReminders(tx, org.id);
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
      await writeAudit(ctx.tx, ctx, { action: "reminder:create", resourceType: "reminder", resourceId: row.id });
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
      await writeAudit(ctx.tx, ctx, { action: "reminder:update", resourceType: "reminder", resourceId: reminderId });
      return Response.json({ ok: true });
    }),
    DELETE: tenantRoute(async (req, ctx) => {
      const { reminderId } = req.params;
      const [row] = await ctx.tx`DELETE FROM reminders WHERE id = ${reminderId} RETURNING id`;
      if (!row) throw new HttpError(404, "not found");
      await writeAudit(ctx.tx, ctx, { action: "reminder:delete", resourceType: "reminder", resourceId: reminderId });
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
        await writeAudit(ctx.tx, ctx, { action: "reminder:acknowledge", resourceType: "reminder", resourceId: reminderId, metadata: { nextDueOn } });
        return Response.json({ ok: true, nextDueOn });
      }
      await ctx.tx`UPDATE reminders SET notified_at = now() WHERE id = ${reminderId}`;
      await writeAudit(ctx.tx, ctx, { action: "reminder:acknowledge", resourceType: "reminder", resourceId: reminderId, metadata: { nextDueOn: null } });
      return Response.json({ ok: true, nextDueOn: null });
    }),
  },

  // Manual/testable trigger for the same sweep the background interval runs,
  // scoped to the caller's own org.
  "/api/reminders/notify-due": {
    POST: tenantRoute(async (_req, ctx) => {
      requireRole(ctx, ["owner", "admin"]);
      const notified = await sweepDueReminders(ctx.tx, ctx.orgId);
      await writeAudit(ctx.tx, ctx, { action: "reminder:notify_due", resourceType: "reminder", metadata: { notified } });
      return Response.json({ notified });
    }),
  },
};
