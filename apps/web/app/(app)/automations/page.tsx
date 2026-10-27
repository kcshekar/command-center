"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Settings2 } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";
import { automationsApi, type CatalogRow, type RunRow } from "@/lib/automations-api";
import { AREA_LABEL } from "@/lib/nav-items";
import { automationState, RunStrip, runsByAutomation, StatePill } from "@/components/automation-status";
import { cn } from "@/lib/utils";

// U5 — every automation in one scannable list, built from automation_catalog
// (a new catalog row shows up with no code change). Each row opens its detail
// page (/automations/<id>: Overview · Runs · Settings).

const AREA_NAME: Record<CatalogRow["area"], string> = { ...AREA_LABEL, mail: "Mail", platform: "Platform" };
const AREA_SEQ: CatalogRow["area"][] = ["mail", "money", "career", "knowledge", "life", "platform"];

type Filter = "all" | "failing" | CatalogRow["area"];

export default function AutomationsPage() {
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    automationsApi.catalog().then(setRows, (err) => { setError(apiErrorMessage(err, "Could not load automations")); setRows([]); });
    // Runs are decoration for the list; Temporal being down must not blank it.
    automationsApi.runs(undefined, 300).then(setRuns, () => {});
  }, []);

  const byAuto = useMemo(() => runsByAutomation(runs), [runs]);
  const states = useMemo(
    () => new Map((rows ?? []).map((r) => [r.id, automationState(r, byAuto.get(r.id) ?? [])])),
    [rows, byAuto],
  );

  const sorted = useMemo(
    () => [...(rows ?? [])].sort((a, b) => AREA_SEQ.indexOf(a.area) - AREA_SEQ.indexOf(b.area) || a.name.localeCompare(b.name)),
    [rows],
  );
  const visible = sorted.filter((r) => filter === "all" || (filter === "failing" ? states.get(r.id) === "failing" : r.area === filter));
  const failingCount = [...states.values()].filter((s) => s === "failing").length;
  const onCount = [...states.values()].filter((s) => s === "on" || s === "failing").length;
  const areas = AREA_SEQ.filter((a) => sorted.some((r) => r.area === a));

  const chips: Array<{ id: Filter; label: string }> = [
    { id: "all", label: `All ${sorted.length}` },
    ...(failingCount ? [{ id: "failing" as Filter, label: `Failing · ${failingCount}` }] : []),
    ...areas.map((a) => ({ id: a as Filter, label: AREA_NAME[a] })),
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Automations</h1>
          <p className="text-sm text-muted-foreground">
            {rows === null ? "Loading…" : `${onCount} on · ${sorted.length - onCount} off or on demand. Open one to see its runs and settings.`}
          </p>
        </div>
        <Link href="/agent-automations" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
          <Settings2 className="size-4" /> Control room
        </Link>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter automations">
        {chips.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={filter === c.id}
            onClick={() => setFilter(c.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === c.id ? "border-primary bg-primary/10 text-primary" : "bg-card hover:border-primary/40",
              c.id === "failing" && filter !== c.id && "text-destructive",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_auto_auto] gap-4 border-b bg-background px-4 py-2 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground md:grid">
          <span>Automation</span><span>Runs · accounts</span><span>Last 14 runs</span><span className="w-20">Status</span>
        </div>
        {rows !== null && visible.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {filter === "failing" ? "Nothing is failing." : "No automations in the catalog yet."}
          </p>
        )}
        <ul>
          {visible.map((r) => {
            const accounts = r.config.accounts ?? [];
            return (
              <li key={r.id} className="border-t first:border-t-0">
                <Link
                  href={`/automations/${encodeURIComponent(r.id)}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_auto_auto]"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                      {r.name}
                      <code className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-normal text-muted-foreground sm:inline">{r.id}</code>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground" title={r.description}>{r.description}</span>
                  </span>
                  <span className="col-span-2 row-start-2 min-w-0 text-xs text-muted-foreground md:col-span-1 md:row-start-auto">
                    {r.cadence}
                    {r.perAccount && (
                      <span className="block truncate" title={accounts.map((a) => a.email).join(", ")}>
                        {accounts.length ? `${accounts.length} Google account${accounts.length === 1 ? "" : "s"}` : "No account pinned"}
                      </span>
                    )}
                  </span>
                  <span className="hidden md:inline-flex">
                    {r.hasSchedule ? <RunStrip runs={byAuto.get(r.id) ?? []} /> : <span className="text-xs text-muted-foreground">runs from its page</span>}
                  </span>
                  <span className="flex w-20 items-center justify-end gap-1 md:justify-start">
                    <StatePill state={states.get(r.id) ?? "off"} />
                    <ChevronRight className="size-4 text-muted-foreground md:hidden" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
