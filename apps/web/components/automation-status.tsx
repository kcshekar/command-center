import type { CatalogRow, RunRow } from "@/lib/automations-api";
import { cn } from "@/lib/utils";

// Status vocabulary from DESIGN.md: on, paused (here "off"), failing, plus
// "on demand" for automations that run from a page or an event rather than a
// schedule. Always a dot + word, never colour alone.

export type AutomationState = "on" | "off" | "failing" | "on-demand";

const FAILED = new Set(["FAILED", "TIMED_OUT", "TERMINATED"]);
export const isFailedRun = (status: string) => FAILED.has(status);

export function automationState(row: CatalogRow, runs: RunRow[]): AutomationState {
  if (!row.hasSchedule) return "on-demand";
  if (!row.enabled) return "off";
  return runs[0] && isFailedRun(runs[0].status) ? "failing" : "on";
}

const PILL: Record<AutomationState, [string, string]> = {
  on: ["on", "bg-success/10 text-success"],
  off: ["off", "bg-muted text-muted-foreground"],
  failing: ["failing", "bg-destructive/10 text-destructive"],
  "on-demand": ["on demand", "bg-primary/10 text-primary"],
};

export function StatePill({ state }: { state: AutomationState }) {
  const [label, tone] = PILL[state];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px]", tone)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

/** Last `size` runs, oldest → newest, empty slots padded on the left. */
export function RunStrip({ runs, size = 14 }: { runs: RunRow[]; size?: number }) {
  const recent = runs.slice(0, size).reverse();
  const pad = size - recent.length;
  const failed = recent.filter((r) => isFailedRun(r.status)).length;
  return (
    <span
      className="inline-flex gap-[3px]"
      role="img"
      aria-label={recent.length ? `${recent.length} recent runs, ${failed} failed` : "No runs yet"}
    >
      {Array.from({ length: pad }, (_, i) => <i key={`p${i}`} className="h-4 w-1.5 rounded-sm bg-border" />)}
      {recent.map((r) => (
        <i
          key={r.workflowId}
          title={`${new Date(r.startTime).toLocaleString("en-IN")} · ${r.status.toLowerCase().replace("_", " ")}`}
          className={cn(
            "h-4 w-1.5 rounded-sm",
            isFailedRun(r.status) ? "bg-destructive" : r.status === "RUNNING" ? "bg-primary" : r.status === "COMPLETED" ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

/** Runs grouped by automation id (schedule ids start with "<automationId>:"). */
export function runsByAutomation(runs: RunRow[]): Map<string, RunRow[]> {
  const out = new Map<string, RunRow[]>();
  for (const r of runs) {
    const id = r.scheduleId?.split(":")[0];
    if (!id) continue;
    const list = out.get(id) ?? [];
    list.push(r);
    out.set(id, list);
  }
  return out;
}
