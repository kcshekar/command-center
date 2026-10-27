"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Calendar,
  ChevronRight,
  Loader2,
  Mail,
  Power,
  PowerOff,
  RefreshCw,
  Shield,
} from "lucide-react";
import { automationsApi, type CatalogRow } from "@/lib/automations-api";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Converts cadence_default back to a human string. Mirrors the dashboard's
// formatCadence shape, but works on raw strings from the catalog seed.
export function CatalogList() {
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const data = await automationsApi.catalog();
      setRows(data);
      setError(null);
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed to load catalog");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Optimistic toggle: flip the row in local state, send the PATCH, roll back
  // if it fails. Avoids a round-trip flicker on every click.
  async function toggle(id: string, next: boolean) {
    setActing(id);
    const before = rows;
    setRows((prev) =>
      prev ? prev.map((r) => (r.id === id ? { ...r, enabled: next } : r)) : prev
    );
    try {
      const res = await automationsApi.setGrantEnabled(id, next);
      const n = res.scheduleIds.length;
      toast.success(
        next
          ? `Enabled ${id}${n ? ` · ${n} schedule${n === 1 ? "" : "s"} running` : ""}`
          : `Disabled ${id}${n ? ` · schedule${n === 1 ? "" : "s"} paused` : ""}`
      );
      void refresh(true); // pick up auto-pinned accounts
    } catch (err) {
      setRows(before);
      toast.error(apiErrorMessage(err, `Failed to ${next ? "enable" : "disable"} ${id}`));
    } finally {
      setActing(null);
    }
  }

  const enabledCount = rows?.filter((r) => r.enabled).length ?? 0;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookOpen className="size-4 text-primary" />
            Automation Catalog
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {rows === null
              ? "The automations available on this workspace."
              : `${rows.length} available · ${enabledCount} enabled for you.`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={refreshing}
          onClick={() => void refresh()}
          aria-label="Refresh catalog"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </header>

      {rows === null && !error ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading catalog…
        </div>
      ) : error && rows === null ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive">Couldn&apos;t load the catalog</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      ) : rows && rows.length === 0 ? (
        <p className="py-6 text-xs text-muted-foreground">
          No automations seeded. Run migration <code className="font-mono">0026_automation_catalog</code>.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows!.map((r) => (
            <li
              key={r.id}
              className={cn(
                "flex flex-col gap-2 rounded-xl border bg-background/60 p-3.5 transition-colors hover:border-primary/30 hover:bg-background sm:flex-row sm:items-start sm:justify-between",
                !r.enabled && "opacity-80"
              )}
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {r.id}
                  </code>
                  <h3 className="truncate text-sm font-medium">{r.name}</h3>
                  {r.enabled ? (
                    <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400">
                      <span className="size-1.5 rounded-full bg-emerald-500" /> enabled
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      disabled
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{r.description}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="size-3" /> {r.cadence}
                  </span>
                  {r.chainsTo.length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <ChevronRight className="size-3" />
                      chains&nbsp;
                      {r.chainsTo.map((c, i) => (
                        <span key={c}>
                          {i > 0 && ", "}
                          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                            {c}
                          </code>
                        </span>
                      ))}
                    </span>
                  )}
                  {r.perAccount && (
                    <span className="inline-flex min-w-0 items-center gap-1 [overflow-wrap:anywhere]">
                      <Mail className="size-3 shrink-0" />
                      {r.config.accounts?.length
                        ? r.config.accounts.map((a) => a.email).join(", ")
                        : "no Google account pinned yet (all connected ones are pinned on enable)"}
                    </span>
                  )}
                  {r.requiredScopes.length > 0 && (
                    <span className="inline-flex items-center gap-1" title={r.requiredScopes.join(", ")}>
                      <Shield className="size-3" />
                      {r.requiredScopes.length} scope{r.requiredScopes.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center self-end sm:self-auto">
                {r.enabled ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={acting === r.id}
                    onClick={() => void toggle(r.id, false)}
                  >
                    {acting === r.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <PowerOff className="size-3" />
                    )}
                    Disable
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={acting === r.id}
                    onClick={() => void toggle(r.id, true)}
                  >
                    {acting === r.id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Power className="size-3" />
                    )}
                    Enable
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
