"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from "lucide-react";

function Thumb({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <Tag className="size-5" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="size-14 shrink-0 rounded-md border bg-muted object-contain"
    />
  );
}
import { toast } from "sonner";
import { priceWatchesApi, type PriceWatch } from "@/lib/price-watches-api";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

function fmtMoney(amount: number | null, currency: string): string {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

const VERDICT_STYLE: Record<string, string> = {
  target: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  wait: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  fair: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
};

const VERDICT_LABEL: Record<string, string> = {
  target: "At target",
  wait: "Above target",
  fair: "No target",
};

const SOURCE_LABEL: Record<string, string> = {
  amazon: "Amazon",
  flipkart: "Flipkart",
  generic: "Other",
};

export default function PriceWatcherPage() {
  const [rows, setRows] = useState<PriceWatch[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const [actingId, setActingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [editTargetValue, setEditTargetValue] = useState("");

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const data = await priceWatchesApi.list();
      setRows(data);
      setError(null);
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed to load watches");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Light auto-refresh: the initial-fetch workflow lands async, so poll every
  // ~15s while any row is still "fetching" (currentPrice null, not paused).
  // Backs off once everything has a price.
  useEffect(() => {
    if (!rows) return;
    const pending = rows.some((r) => !r.paused && r.currentPrice == null);
    if (!pending) return;
    const t = setInterval(() => void refresh(true), 15_000);
    return () => clearInterval(t);
  }, [rows, refresh]);

  function openCreate() {
    setUrl("");
    setTarget("");
    setNote("");
    setOpen(true);
  }

  async function save() {
    if (!url.trim()) return;
    const t = target.trim();
    const parsedTarget = t ? Number(t) : undefined;
    if (t && (!Number.isFinite(parsedTarget) || parsedTarget! <= 0)) {
      toast.error("Target price must be a positive number");
      return;
    }
    setSaving(true);
    try {
      await priceWatchesApi.create({
        url: url.trim(),
        target_price: parsedTarget,
        note: note.trim() || undefined,
      });
      toast.success("Watch added — fetching price…");
      setOpen(false);
      await refresh(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to add watch"));
    } finally {
      setSaving(false);
    }
  }

  async function togglePaused(w: PriceWatch) {
    setActingId(w.id);
    const before = rows;
    setRows((prev) => prev && prev.map((r) => (r.id === w.id ? { ...r, paused: !r.paused } : r)));
    try {
      await priceWatchesApi.update(w.id, { paused: !w.paused });
      toast.success(w.paused ? "Resumed" : "Paused");
    } catch (err) {
      setRows(before);
      toast.error(apiErrorMessage(err, "Failed to update watch"));
    } finally {
      setActingId(null);
    }
  }

  async function remove(id: string) {
    setActingId(id);
    try {
      await priceWatchesApi.remove(id);
      toast.success("Watch deleted");
      setConfirmDeleteId(null);
      await refresh(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete watch"));
    } finally {
      setActingId(null);
    }
  }

  async function saveTarget(w: PriceWatch) {
    const t = editTargetValue.trim();
    const parsed = t ? Number(t) : null;
    if (t && (!Number.isFinite(parsed) || (parsed as number) <= 0)) {
      toast.error("Target must be a positive number or empty to clear");
      return;
    }
    setActingId(w.id);
    try {
      await priceWatchesApi.update(w.id, { target_price: parsed });
      toast.success(parsed == null ? "Target cleared" : `Target set to ${parsed}`);
      setEditTargetId(null);
      await refresh(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to update target"));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Price Watcher</h1>
          <p className="text-sm text-muted-foreground">
            Track Amazon products. Add a URL, set a target price, we poll Keepa daily and ping you when it drops.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={refreshing}
            onClick={() => void refresh()}
            aria-label="Refresh"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
              <Plus className="size-4" /> New watch
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New price watch</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="pw-url">Product URL</Label>
                  <Input
                    id="pw-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://www.amazon.in/dp/..."
                    autoFocus
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Amazon URLs get live prices via Keepa. Other sites are tracked without prices for now.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="pw-target">Target price (optional)</Label>
                  <Input
                    id="pw-target"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="999"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="pw-note">Note (optional)</Label>
                  <Input
                    id="pw-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Why you want it, size/colour, etc."
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={save} disabled={saving || !url.trim()}>
                  {saving ? "Adding…" : "Add watch"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {rows === null && !error ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading watches…
        </div>
      ) : error && rows === null ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Couldn&apos;t load watches</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      ) : rows && rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-10 text-center">
          <Tag className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No watches yet</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Save a Keepa API key on the Automations page, then add an Amazon product URL here.
          </p>
          <Button size="sm" className="mt-2 gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add your first watch
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows!.map((r) => {
            const verdict = r.currentVerdict;
            const sourceLabel = SOURCE_LABEL[r.source] ?? r.source;
            const fetching = r.currentPrice == null && !r.paused;
            return (
              <li
                key={r.id}
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-card px-3.5 py-3 transition-shadow hover:shadow-md",
                  r.paused && "opacity-70"
                )}
              >
                <Thumb src={r.imageUrl} />

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {r.title ?? r.url}
                    </a>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                    <Badge variant="outline" className="text-[10px]">
                      {sourceLabel}
                    </Badge>
                    {r.paused && (
                      <Badge variant="outline" className="text-[10px]">
                        paused
                      </Badge>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono text-sm font-semibold">
                      {fetching ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" /> fetching…
                        </span>
                      ) : (
                        fmtMoney(r.currentPrice, r.currency)
                      )}
                    </span>

                    {editTargetId === r.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          value={editTargetValue}
                          onChange={(e) => setEditTargetValue(e.target.value)}
                          className="h-7 w-24 text-xs"
                          placeholder="target"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 px-2 text-xs"
                          disabled={actingId === r.id}
                          onClick={() => void saveTarget(r)}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => setEditTargetId(null)}
                        >
                          <X className="size-3" />
                        </Button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditTargetId(r.id);
                          setEditTargetValue(r.targetPrice != null ? String(r.targetPrice) : "");
                        }}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        target: {r.targetPrice != null ? fmtMoney(r.targetPrice, r.currency) : "—"}
                        <Pencil className="size-3" />
                      </button>
                    )}

                    {verdict && (
                      <Badge className={cn("text-[10px]", VERDICT_STYLE[verdict])}>
                        {VERDICT_LABEL[verdict] ?? verdict}
                      </Badge>
                    )}

                    <span className="text-muted-foreground">
                      checked {fmtRelative(r.lastCheckedAt)}
                    </span>
                  </div>

                  {r.note && (
                    <p className="truncate text-xs text-muted-foreground">{r.note}</p>
                  )}
                </div>

                {confirmDeleteId === r.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Delete?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={actingId === r.id}
                      onClick={() => void remove(r.id)}
                    >
                      {actingId === r.id ? "…" : "Confirm"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actingId === r.id}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={actingId === r.id}
                      onClick={() => void togglePaused(r)}
                      aria-label={r.paused ? "Resume" : "Pause"}
                    >
                      {actingId === r.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : r.paused ? (
                        <Play className="size-3.5" />
                      ) : (
                        <Pause className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 hover:text-destructive"
                      onClick={() => setConfirmDeleteId(r.id)}
                      aria-label="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
