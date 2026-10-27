"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { automationsApi, type ScheduleRow } from "@/lib/automations-api";
import { financeApi, type ExpenseSummaryRow } from "@/lib/finance-api";
import { interviewsApi, type UpcomingRound } from "@/lib/interviews-api";
import { notificationsApi, routeLabel, type InAppNotification } from "@/lib/notifications-api";
import { decideWithUndo } from "@/lib/approval-undo";
import { remindersApi, type Reminder } from "@/lib/reminders-api";
import { firstLine } from "@/lib/slack-text";
import { cn } from "@/lib/utils";

// U1 Today — the home screen. Four blocks, each loading on its own so one
// slow or forbidden source never blanks the page:
//   Needs you   pending in-app approvals + automations whose last run failed
//   Coming up   interview rounds + reminders, next 7 days (calendar comes
//               later: Google tokens live in the worker, not CC)
//   This month  expense total; personal/business split arrives with P2 zones
//   Health      every schedule's state from Temporal

type Load<T> = { data: T; error?: undefined } | { data?: undefined; error: string } | null;

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setState({ data }),
      (err) => live && setState({ error: apiErrorMessage(err, "Could not load") }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return [state, () => setTick((t) => t + 1)];
}

const FAILED = new Set(["FAILED", "TIMED_OUT", "TERMINATED"]);
const HEALTH_CAP = 8;
const COMING_UP_CAP = 6;

// Failing first (what needs action), then active, then paused.
function healthOrder(rows: ScheduleRow[]): ScheduleRow[] {
  const rank = (s: ScheduleRow) => (!s.paused && s.lastRunStatus && FAILED.has(s.lastRunStatus) ? 0 : s.paused ? 2 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}
const inr = (paise: number) =>
  `₹ ${Math.round(paise / 100).toLocaleString("en-IN")}`;

// "inboxTriageWorkflow" → "Inbox triage"
function workflowLabel(row: ScheduleRow): string {
  const w = (row.workflowType ?? row.id).replace(/Workflow$/, "");
  const words = w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export default function TodayPage() {
  const [approvals, reloadApprovals] = useLoad(() =>
    notificationsApi.listInApp().then((r) => r.filter((n) => n.is_approval && !n.approval_state)));
  const [schedules] = useLoad(() => automationsApi.list());
  const [rounds] = useLoad(() => interviewsApi.upcomingRounds(7));
  const [reminders] = useLoad(() => remindersApi.list(7));
  // Personal zone only: private to this user, so every role sees their own.
  const [spend] = useLoad(() => financeApi.expenseSummary(2, "personal"));

  const failing = schedules?.data?.filter((s) => !s.paused && s.lastRunStatus && FAILED.has(s.lastRunStatus)) ?? [];
  const pending = approvals?.data ?? [];
  const needsCount = pending.length + failing.length;

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">{today}</h1>
        <p className="text-sm text-muted-foreground">
          {approvals && schedules
            ? needsCount === 0 ? "Nothing needs you right now." : `${needsCount} thing${needsCount === 1 ? "" : "s"} need${needsCount === 1 ? "s" : ""} you.`
            : "Loading…"}
          {" "}<Link href="/inbox" className="font-medium text-primary">Open Inbox</Link>
        </p>
      </div>

      {/* Needs you only takes space when something does; Coming up leads otherwise. */}
      <div className={cn("grid gap-4", (needsCount > 0 || approvals?.error) && "lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]")}>
        {(needsCount > 0 || approvals?.error) && (
        <Panel title="Needs you" hint="oldest first" className="border-warning/50">
          {approvals?.error && <Muted>Approvals: {approvals.error}</Muted>}
          {[...pending].reverse().map((n) => (
            <ApprovalRow key={n.id} n={n} onDone={reloadApprovals} />
          ))}
          {failing.map((s) => (
            <Row key={s.id}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{workflowLabel(s)} failed</div>
                <div className="text-xs text-muted-foreground">Last run {s.lastRunStatus?.toLowerCase().replace("_", " ")} · {s.cadence}</div>
              </div>
              <Link href="/agent-automations" className="text-sm font-medium text-primary">Open</Link>
            </Row>
          ))}
        </Panel>
        )}

        <Panel title="Coming up" hint="next 7 days">
          <ComingUp rounds={rounds} reminders={reminders} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Panel title="This month" hint="personal spending">
          <MonthSpend spend={spend} />
        </Panel>
        <Panel title="Automation health" hint="last run per schedule">
          {!schedules && <Muted>Loading…</Muted>}
          {schedules?.error && <Muted>{schedules.error}</Muted>}
          {schedules?.data?.length === 0 && <Muted>No schedules yet. Run <code className="font-mono text-xs">pnpm schedules:init</code> in the worker.</Muted>}
          {schedules?.data && schedules.data.length > 0 && schedules.data.every((s) => s.paused) ? (
            <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>All {schedules.data.length} schedules are paused. Nothing runs until you resume them.</span>
              <Link href="/agent-automations" className="font-medium text-primary">Resume in Control room</Link>
            </div>
          ) : schedules?.data && healthOrder(schedules.data).slice(0, HEALTH_CAP).map((s) => (
            <Row key={s.id}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{workflowLabel(s)}</div>
                <div className="text-xs text-muted-foreground">
                  {s.cadence}
                  {s.nextRuns[0] && !s.paused && ` · next ${new Date(s.nextRuns[0]).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`}
                </div>
              </div>
              <StatusPill row={s} />
            </Row>
          ))}
          {(schedules?.data?.length ?? 0) > HEALTH_CAP && !schedules!.data!.every((s) => s.paused) && (
            <Link href="/agent-automations" className="pt-2 text-sm font-medium text-primary">
              View all {schedules!.data!.length} in Control room
            </Link>
          )}
        </Panel>
      </div>
    </div>
  );
}

function ApprovalRow({ n, onDone }: { n: InAppNotification; onDone: () => void }) {
  const [held, setHeld] = useState(false); // inside the 5s undo window
  function decide(decision: "approved" | "rejected") {
    decideWithUndo(n, decision, { onHold: () => setHeld(true), onUndone: () => setHeld(false), onSent: onDone });
  }
  if (held) return null;
  return (
    <Row>
      <div className="min-w-0 flex-1">
        <div className="font-medium [overflow-wrap:anywhere]">{firstLine(n.text, "Approval")}</div>
        <div className="text-xs text-muted-foreground">{routeLabel(n.route_key)} · {ago(n.created_at)}</div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => decide("rejected")}>Reject</Button>
        <Button size="sm" onClick={() => decide("approved")}>Approve</Button>
      </div>
    </Row>
  );
}

function ComingUp({ rounds, reminders }: { rounds: Load<UpcomingRound[]>; reminders: Load<Reminder[]> }) {
  if (!rounds || !reminders) return <Muted>Loading…</Muted>;
  const items = [
    ...(rounds.data ?? []).map((r) => ({
      key: `r-${r.id}`, at: new Date(r.scheduledAt),
      when: new Date(r.scheduledAt).toLocaleString("en-IN", { weekday: "short", hour: "2-digit", minute: "2-digit" }),
      title: `${r.company} · ${r.kind.replace("_", " ")}`, sub: r.role, href: "/interviews", overdue: false,
    })),
    ...(reminders.data ?? []).map((r) => {
      const at = new Date(`${r.due_on.slice(0, 10)}T09:00:00`);
      const overdue = at.getTime() < new Date().setHours(0, 0, 0, 0);
      const days = Math.round((new Date().setHours(0, 0, 0, 0) - at.setHours(0, 0, 0, 0)) / 86_400_000);
      return {
        key: `m-${r.id}`, at, overdue,
        when: at.toLocaleDateString("en-IN", !overdue
          ? { weekday: "short", day: "numeric" }
          : at.getFullYear() === new Date().getFullYear()
            ? { day: "numeric", month: "short" }
            : { day: "numeric", month: "short", year: "2-digit" }),
        title: r.title,
        sub: `${r.category.replace("_", " ")}${overdue ? ` · overdue ${days} day${days === 1 ? "" : "s"}` : ""}`,
        href: "/reminders",
      };
    }),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <>
      {rounds.error && <Muted>Interviews: {rounds.error}</Muted>}
      {reminders.error && <Muted>Reminders: {reminders.error}</Muted>}
      {items.length === 0 && !rounds.error && !reminders.error && (
        <Muted>No interviews or reminders in the next 7 days.</Muted>
      )}
      {items.slice(0, COMING_UP_CAP).map((i) => (
        <Row key={i.key}>
          <span className={cn("w-24 shrink-0 whitespace-nowrap font-mono text-xs", i.overdue ? "text-destructive" : "text-muted-foreground")}>{i.when}</span>
          <Link href={i.href} className="min-w-0 flex-1 hover:underline">
            <div className="font-medium [overflow-wrap:anywhere]">{i.title}</div>
            <div className="text-xs text-muted-foreground">{i.sub}</div>
          </Link>
        </Row>
      ))}
      {items.length > COMING_UP_CAP && (
        <Link href="/reminders" className="pt-2 text-sm font-medium text-primary">
          {items.length - COMING_UP_CAP} more
        </Link>
      )}
    </>
  );
}

function MonthSpend({ spend }: { spend: Load<ExpenseSummaryRow[]> }) {
  if (!spend) return <Muted>Loading…</Muted>;
  if (spend.error) return <Muted>{spend.error}</Muted>;
  const rows = spend.data ?? [];
  const now = new Date();
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = key(now);
  const lastMonth = key(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const sum = (m: string) => rows.filter((r) => r.month === m).reduce((t, r) => t + Number(r.total_cents), 0);
  const total = sum(thisMonth);
  const prev = sum(lastMonth);
  const top = rows
    .filter((r) => r.month === thisMonth)
    .sort((a, b) => Number(b.total_cents) - Number(a.total_cents))
    .slice(0, 3);
  return (
    <>
      <div className="font-heading text-3xl font-semibold tabular-nums">{inr(total)}</div>
      <div className="text-xs text-muted-foreground">
        {prev > 0 ? `${inr(prev)} last month` : "No spending recorded last month"}
      </div>
      {top.map((r) => (
        <Row key={r.category}>
          <span className="min-w-0 flex-1 capitalize [overflow-wrap:anywhere]">{r.category}</span>
          <span className="font-mono text-sm tabular-nums">{inr(Number(r.total_cents))}</span>
        </Row>
      ))}
      <Link href="/finance" className="pt-1 text-sm font-medium text-primary">Open Finance</Link>
    </>
  );
}

function StatusPill({ row }: { row: ScheduleRow }) {
  const failed = row.lastRunStatus && FAILED.has(row.lastRunStatus);
  const [label, tone] = row.paused
    ? ["paused", "bg-muted text-muted-foreground"]
    : failed
      ? ["failing", "bg-destructive/10 text-destructive"]
      : row.runningCount > 0
        ? ["running", "bg-primary/10 text-primary"]
        : ["on", "bg-success/10 text-success"];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px]", tone)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

function Panel({ title, hint, className, children }: { title: string; hint?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-xl border bg-card px-4 py-3", className)}>
      <h2 className="flex items-baseline justify-between gap-2 pb-1 text-sm font-semibold">
        {title}
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 border-t py-2 text-sm first:border-t-0">{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}
