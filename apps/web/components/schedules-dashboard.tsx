"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Calendar,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Workflow,
} from "lucide-react";
import { automationsApi, type ScheduleRow } from "@/lib/automations-api";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;

function relative(iso: string | null): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const m = Math.round(abs / 60_000);
  if (m < 1) return past ? "just now" : "in <1m";
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  return past ? `${d}d ago` : `in ${d}d`;
}

export function SchedulesDashboard() {
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hoveredRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const data = await automationsApi.list();
      setRows(data);
      setError(null);
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed to load schedules");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      // Pause auto-poll while the user is interacting with a row
      if (!hoveredRef.current) void refresh(true);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function doAction(
    id: string,
    kind: "pause" | "unpause" | "trigger",
    verb: string
  ) {
    setActing(`${id}:${kind}`);
    try {
      await automationsApi[kind](id);
      toast.success(`${verb} ${id}`);
      await refresh(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, `Failed to ${kind}`));
    } finally {
      setActing(null);
    }
  }

  return (
    <section
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
      className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Workflow className="size-4 text-primary" />
            Scheduled Workflows
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Live from Temporal. Pause, resume, or trigger a run on demand.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={refreshing}
          onClick={() => void refresh()}
          aria-label="Refresh"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </header>

      {rows === null && !error ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading schedules…
        </div>
      ) : error && rows === null ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive">Couldn't reach Temporal</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      ) : rows && rows.length === 0 ? (
        <p className="py-6 text-xs text-muted-foreground">No schedules registered yet. Run <code className="font-mono">pnpm schedules:init</code> on the worker to create them.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows!.map((r) => {
            const next = r.nextRuns[0] ?? null;
            const lastAt = r.recentActions[0]?.actualTime ?? null;
            return (
              <li
                key={r.id}
                className={cn(
                  "group flex flex-col gap-3 rounded-xl border bg-background/60 p-3.5 transition-colors hover:border-primary/30 hover:bg-background sm:flex-row sm:items-center sm:justify-between",
                  r.paused && "opacity-70"
                )}
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-mono text-sm font-medium">{r.id}</h3>
                    {r.paused ? (
                      <Badge variant="outline" className="gap-1 border-amber-400/40 text-amber-600 dark:text-amber-400">
                        <Pause className="size-2.5" /> paused
                      </Badge>
                    ) : (
                      <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-500" /> active
                      </Badge>
                    )}
                    {r.runningCount > 0 && (
                      <Badge variant="outline" className="gap-1 border-blue-400/40 text-blue-600 dark:text-blue-400">
                        <Activity className="size-2.5 animate-pulse" /> running
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    {r.workflowType && (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <Workflow className="size-3" />
                        {r.workflowType}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="size-3" /> {r.cadence}
                    </span>
                    <span className="inline-flex items-center gap-1" title={next ?? undefined}>
                      <Clock className="size-3" /> next {relative(next)}
                    </span>
                    <span className="inline-flex items-center gap-1 opacity-80" title={lastAt ?? undefined}>
                      last {relative(lastAt)}
                    </span>
                    <span className="opacity-80">
                      {r.numActions} runs total
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={acting === `${r.id}:trigger`}
                    onClick={() => doAction(r.id, "trigger", "Triggered")}
                  >
                    {acting === `${r.id}:trigger` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Rocket className="size-3" />
                    )}
                    Run now
                  </Button>
                  {r.paused ? (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={acting === `${r.id}:unpause`}
                      onClick={() => doAction(r.id, "unpause", "Resumed")}
                    >
                      {acting === `${r.id}:unpause` ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Play className="size-3" />
                      )}
                      Resume
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={acting === `${r.id}:pause`}
                      onClick={() => doAction(r.id, "pause", "Paused")}
                    >
                      {acting === `${r.id}:pause` ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Pause className="size-3" />
                      )}
                      Pause
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
