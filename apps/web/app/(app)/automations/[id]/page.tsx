"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Play, Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/breadcrumb";
import { Button } from "@/components/ui/button";
import { automationState, isFailedRun, RunStrip, StatePill } from "@/components/automation-status";
import { apiErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { automationsApi, type CatalogRow, type RunRow, type ScheduleRow } from "@/lib/automations-api";
import { cn } from "@/lib/utils";

// U6 — one automation: Overview · Runs · Settings. Settings is where Gmail
// accounts are pinned (P3: each pinned account gets its own schedule). The
// on/off switch and pins save through PATCH /catalog/:id/grant, which
// reconciles the user's Temporal schedules server-side.

type Tab = "overview" | "runs" | "settings";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
];

const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const accountOf = (scheduleId: string | null) => scheduleId?.split(":")[2] ?? null;
function duration(r: RunRow): string {
  if (!r.closeTime) return "—";
  const s = Math.round((new Date(r.closeTime).getTime() - new Date(r.startTime).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function AutomationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const automationId = decodeURIComponent(id);
  const { user } = useAuth();
  const [row, setRow] = useState<CatalogRow | null | undefined>(undefined); // undefined = loading, null = not found
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [cat, r, s] = await Promise.allSettled([
      automationsApi.catalog(),
      automationsApi.runs(automationId, 50),
      automationsApi.list(),
    ]);
    setRow(cat.status === "fulfilled" ? cat.value.find((c) => c.id === automationId) ?? null : null);
    setRuns(r.status === "fulfilled" ? r.value : []);
    if (s.status === "fulfilled") setSchedules(s.value);
  }, [automationId]);

  useEffect(() => { void load(); }, [load]);

  // Deep links: /automations/a5.mail#settings
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      setTab(TABS.some((t) => t.id === h) ? (h as Tab) : "overview");
    };
    fromHash();
    window.addEventListener("hashchange", fromHash); // same-page #settings links
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  function openTab(t: Tab) {
    setTab(t);
    history.replaceState(null, "", t === "overview" ? window.location.pathname : `#${t}`);
  }

  const mine = useMemo(() => {
    const prefix = `${automationId}:${user?.userId}`;
    return schedules.filter((s) => s.id === prefix || s.id.startsWith(`${prefix}:`));
  }, [schedules, automationId, user?.userId]);
  const nextRun = mine.filter((s) => !s.paused).flatMap((s) => s.nextRuns).sort()[0] ?? null;

  if (row === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (row === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">No automation called <code className="font-mono">{automationId}</code>.</p>
        <Link href="/automations" className="text-sm font-medium text-primary">Back to Automations</Link>
      </div>
    );
  }

  const state = automationState(row, runs ?? []);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    try {
      const res = await automationsApi.setGrant(automationId, { enabled });
      const n = res.scheduleIds.length;
      toast.success(enabled ? `Turned on${n ? ` · ${n} schedule${n === 1 ? "" : "s"}` : ""}` : "Turned off · schedules paused");
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, `Could not turn ${enabled ? "on" : "off"}`));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      await Promise.all(mine.map((s) => automationsApi.trigger(s.id)));
      toast.success(`Started ${mine.length} run${mine.length === 1 ? "" : "s"}`);
      setTimeout(() => void load(), 2500); // let Temporal index the new run
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not start a run"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb items={[{ label: "Automations", href: "/automations" }, { label: row.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-heading font-semibold tracking-tight">{row.name}</h1>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{row.id}</code>
            <StatePill state={state} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {row.cadence}
            {nextRun && ` · next run ${fmt(nextRun)}`}
            {runs?.[0] && ` · last run ${fmt(runs[0].startTime)}, ${runs[0].status.toLowerCase().replace("_", " ")}`}
          </p>
        </div>
        {row.hasSchedule && (
          <div className="flex flex-wrap gap-2">
            {mine.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void runNow()}>
                <Play className="size-3.5" /> Run now
              </Button>
            )}
            {row.enabled ? (
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void setEnabled(false)}>
                <PowerOff className="size-3.5" /> Turn off
              </Button>
            ) : (
              <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => void setEnabled(true)}>
                <Power className="size-3.5" /> Turn on
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-5 border-b text-sm" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => openTab(t.id)}
            className={cn(
              "-mb-px border-b-2 pb-2 transition-colors",
              tab === t.id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.id === "runs" && runs && runs.length > 0 && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{runs.length}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview row={row} runs={runs ?? []} />}
      {tab === "runs" && <Runs row={row} runs={runs} perAccount={row.perAccount} />}
      {tab === "settings" && <Settings row={row} onSaved={load} />}
    </div>
  );
}

function Overview({ row, runs }: { row: CatalogRow; runs: RunRow[] }) {
  const accounts = row.config.accounts ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">What it does</h2>
        <p className="text-sm leading-relaxed">{row.description}</p>
        {row.uiRoute && (
          <Link href={row.uiRoute} className="w-fit text-sm font-medium text-primary">Open {row.uiLabel ?? "its page"}</Link>
        )}
        {row.chainsTo.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Hands off to{" "}
            {row.chainsTo.map((c, i) => (
              <span key={c}>{i > 0 && ", "}<Link href={`/automations/${encodeURIComponent(c)}`} className="font-mono text-xs text-primary">{c}</Link></span>
            ))}
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
        <h2 className="text-sm font-semibold">At a glance</h2>
        <Fact label="Runs">{row.cadence}</Fact>
        {row.perAccount && (
          <Fact label="Google accounts">
            {accounts.length ? accounts.map((a) => <span key={a.email} className="block [overflow-wrap:anywhere]">{a.email}</span>) : "None pinned"}
          </Fact>
        )}
        {row.hasSchedule && <Fact label="Last 14 runs"><RunStrip runs={runs} /></Fact>}
        <Fact label="Needs access to">
          <span className="font-mono text-xs">{row.requiredScopes.join(", ") || "—"}</span>
        </Fact>
      </section>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-t pt-2 first-of-type:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function Runs({ row, runs, perAccount }: { row: CatalogRow; runs: RunRow[] | null; perAccount: boolean }) {
  if (runs === null) return <p className="text-sm text-muted-foreground">Loading runs…</p>;
  if (!row.hasSchedule) {
    return <p className="text-sm text-muted-foreground">This automation runs from its page or from another automation, so it has no scheduled runs to list.</p>;
  }
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet. {row.enabled ? "The first one starts at the next scheduled time, or use Run now." : "Turn it on to start running on schedule."}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-background font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-normal">Started</th>
            {perAccount && <th className="px-4 py-2 text-left font-normal">Account</th>}
            <th className="px-4 py-2 text-left font-normal">Result</th>
            <th className="px-4 py-2 text-right font-normal">Took</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.workflowId} className="border-t">
              <td className="whitespace-nowrap px-4 py-2 tabular-nums">{fmt(r.startTime)}</td>
              {perAccount && <td className="px-4 py-2 text-muted-foreground [overflow-wrap:anywhere]">{accountOf(r.scheduleId) ?? "—"}</td>}
              <td className={cn("px-4 py-2", isFailedRun(r.status) ? "text-destructive" : r.status === "RUNNING" ? "text-primary" : "text-foreground")}>
                {r.status.toLowerCase().replace("_", " ")}
              </td>
              <td className="px-4 py-2 text-right font-mono text-xs tabular-nums">{duration(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">Last {runs.length} runs kept by Temporal. Older history ages out.</p>
    </div>
  );
}

function Settings({ row, onSaved }: { row: CatalogRow; onSaved: () => Promise<void> }) {
  const [pinnable, setPinnable] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set((row.config.accounts ?? []).map((a) => a.email)));
  // Per-account zone (P2): where money found in that inbox is filed.
  const [zones, setZones] = useState<Record<string, "personal" | "professional">>(
    Object.fromEntries((row.config.accounts ?? []).map((a) => [a.email, a.zone ?? "personal"])),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (row.perAccount) automationsApi.googleAccounts().then(setPinnable, () => setPinnable([]));
  }, [row.perAccount]);

  if (!row.hasSchedule) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to set up here. It runs on demand: from a button on another page{row.cadence === "On event" ? " or when another automation hands it work" : ""}
        {row.uiRoute && <> from <Link href={row.uiRoute} className="font-medium text-primary">{row.uiLabel}</Link></>}.
      </p>
    );
  }
  if (!row.perAccount) {
    return (
      <p className="text-sm text-muted-foreground">
        Runs once for you, {row.cadence.toLowerCase()}. Use Turn on / Turn off above. Per-automation timing and delivery settings come later.
      </p>
    );
  }

  const saved = new Set((row.config.accounts ?? []).map((a) => a.email));
  const savedZone = (email: string) => row.config.accounts?.find((a) => a.email === email)?.zone ?? "personal";
  const dirty = picked.size !== saved.size || [...picked].some((e) => !saved.has(e))
    || (row.usesZone && [...picked].some((e) => (zones[e] ?? "personal") !== savedZone(e)));

  async function save() {
    setSaving(true);
    try {
      const res = await automationsApi.setGrant(row.id, {
        accounts: [...picked].map((email) => (row.usesZone ? { email, zone: zones[email] ?? "personal" } : { email })),
      });
      toast.success(`Saved · ${res.scheduleIds.length} account schedule${res.scheduleIds.length === 1 ? "" : "s"}`);
      await onSaved();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not save accounts"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex max-w-xl flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">Google accounts</h2>
        <p className="text-xs text-muted-foreground">
          This automation reads only the checked accounts. Each one runs on its own schedule.
          {row.usesZone && " Pick where expenses found in each inbox are filed in Finance."}
        </p>
      </div>
      {pinnable === null && <p className="text-sm text-muted-foreground">Loading accounts…</p>}
      {pinnable?.length === 0 && (
        <p className="text-sm">
          No Google account connected yet. <Link href="/agent-automations" className="font-medium text-primary">Connect one in the Control room</Link>.
        </p>
      )}
      {pinnable?.map((email) => (
        <label key={email} htmlFor={`acct-${email}`} className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm hover:bg-muted/40">
          <input
            id={`acct-${email}`}
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={picked.has(email)}
            onChange={(e) => setPicked((prev) => {
              const next = new Set(prev);
              if (e.target.checked) next.add(email); else next.delete(email);
              return next;
            })}
          />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{email}</span>
          {row.usesZone && picked.has(email) && (
            <select
              aria-label={`Finance zone for ${email}`}
              value={zones[email] ?? "personal"}
              onClick={(e) => e.preventDefault()}
              onChange={(e) => setZones((z) => ({ ...z, [email]: e.target.value as "personal" | "professional" }))}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="personal">Personal</option>
              <option value="professional">Business</option>
            </select>
          )}
        </label>
      ))}
      {pinnable && pinnable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={!dirty || saving || (row.enabled && picked.size === 0)} onClick={() => void save()}>
            Save accounts
          </Button>
          {row.enabled && picked.size === 0 && <span className="text-xs text-destructive">Keep at least one while it's on, or turn it off first.</span>}
          {!row.enabled && <span className="text-xs text-muted-foreground">Saved accounts apply when you turn it on.</span>}
        </div>
      )}
    </section>
  );
}
