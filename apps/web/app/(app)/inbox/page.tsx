"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { notificationsApi, routeLabel, type InAppNotification } from "@/lib/notifications-api";
import { decideWithUndo } from "@/lib/approval-undo";
import { firstLine, slackToText } from "@/lib/slack-text";
import { cn } from "@/lib/utils";

// U3 Inbox — every in-app notification and approval in one list + detail
// view (Linear-style). Slack keeps its copy; the first decision on either side
// wins (CC settles the other copy). Keys: J/K move, A approve, R reject.
// ponytail: polls like the bell (20s); add an SSE "notification" event when
// waiting 20s for a new approval starts to matter.

const POLL_MS = 20_000;
type Filter = "action" | "unread" | "all";

const isPending = (n: InAppNotification) => n.is_approval && !n.approval_state;

// Slack Block Kit → readable lines. Only header/section text; buttons are
// replaced by our own actions.
function blockLines(blocks: unknown[] | null): string[] {
  if (!Array.isArray(blocks)) return [];
  const out: string[] = [];
  for (const b of blocks as Array<{ type?: string; text?: { text?: string } }>) {
    if ((b.type === "header" || b.type === "section") && b.text?.text) {
      out.push(slackToText(b.text.text));
    }
  }
  return out;
}

function when(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function InboxPage() {
  const [items, setItems] = useState<InAppNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [held, setHeld] = useState<Set<string>>(new Set()); // decisions inside the undo window
  const listRef = useRef<HTMLUListElement>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await notificationsApi.listInApp(false));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load notifications"));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const pendingCount = items?.filter(isPending).length ?? 0;
  const unreadCount = items?.filter((n) => !n.read_at).length ?? 0;
  // Default view: what needs you, or everything when nothing does.
  const active: Filter = filter ?? (pendingCount > 0 ? "action" : "all");

  const visible = useMemo(() => {
    const all = (items ?? []).filter((n) => !held.has(n.id));
    if (active === "action") return all.filter(isPending).reverse(); // oldest first
    if (active === "unread") return all.filter((n) => !n.read_at);
    return all;
  }, [items, active, held]);

  const selected = visible.find((n) => n.id === selectedId) ?? visible[0] ?? null;

  // Opening a plain notification marks it read; approvals stay unread until decided.
  useEffect(() => {
    if (selected && !selected.read_at && !isPending(selected)) {
      notificationsApi.markRead(selected.id).then(refresh, () => {});
    }
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = useCallback((n: InAppNotification, decision: "approved" | "rejected") => {
    if (!isPending(n) || held.has(n.id)) return;
    const toggle = (on: boolean) =>
      setHeld((prev) => { const next = new Set(prev); if (on) next.add(n.id); else next.delete(n.id); return next; });
    // Move to the next item so a queue can be worked with the keyboard.
    const i = visible.findIndex((v) => v.id === n.id);
    setSelectedId(visible[i + 1]?.id ?? visible[i - 1]?.id ?? null);
    decideWithUndo(n, decision, {
      onHold: () => toggle(true),
      onUndone: () => { toggle(false); setSelectedId(n.id); },
      onSent: () => { void refresh().then(() => toggle(false)); },
    });
  }, [held, visible, refresh]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      const i = selected ? visible.findIndex((v) => v.id === selected.id) : -1;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") {
        const next = visible[Math.min(i + 1, visible.length - 1)];
        if (next) { setSelectedId(next.id); e.preventDefault(); }
      } else if (k === "k" || e.key === "ArrowUp") {
        const prev = visible[Math.max(i - 1, 0)];
        if (prev) { setSelectedId(prev.id); e.preventDefault(); }
      } else if (k === "a" && selected) {
        decide(selected, "approved");
      } else if (k === "r" && selected) {
        decide(selected, "rejected");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, selected, decide]);

  // Keep the selected row in view while moving with J/K.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  const filters: Array<{ id: Filter; label: string; count?: number }> = [
    { id: "action", label: "Needs action", count: pendingCount },
    { id: "unread", label: "Unread", count: unreadCount },
    { id: "all", label: "All" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Inbox</h1>
          <p className="text-sm text-muted-foreground">
            Approvals and alerts from every automation. Slack shows the same cards; the first decision wins.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter">
          {filters.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={active === f.id}
              onClick={() => { setFilter(f.id); setSelectedId(null); setMobileDetail(false); }}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active === f.id ? "border-primary bg-primary/10 text-primary" : "bg-card hover:border-primary/40",
              )}
            >
              {f.label}{f.count ? ` · ${f.count}` : ""}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid min-h-[420px] overflow-hidden rounded-xl border bg-card lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Notifications"
          className={cn("max-h-[70vh] overflow-y-auto border-b lg:border-b-0 lg:border-r", mobileDetail && "hidden lg:block")}
        >
          {items === null && <li className="p-4 text-sm text-muted-foreground">Loading…</li>}
          {items !== null && visible.length === 0 && (
            <li className="p-6 text-sm text-muted-foreground">
              {active === "action"
                ? "Nothing waiting for a decision. New approvals from your automations land here."
                : active === "unread" ? "You're all caught up." : "No notifications yet. Automations post here once a route uses the in-app channel."}
            </li>
          )}
          {visible.map((n) => {
            const on = selected?.id === n.id;
            return (
              <li
                key={n.id}
                role="option"
                aria-selected={on}
                onClick={() => { setSelectedId(n.id); setMobileDetail(true); }}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 border-t px-4 py-3 text-sm first:border-t-0",
                  on ? "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-muted/50",
                )}
              >
                <div className="flex items-start gap-2">
                  {!n.read_at && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere]", !n.read_at && "font-semibold")}>{firstLine(n.text)}</span>
                </div>
                <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{routeLabel(n.route_key)}</span>
                  <span className="shrink-0">{when(n.created_at)}</span>
                </div>
              </li>
            );
          })}
        </ul>

        <div className={cn("min-w-0 p-5", !mobileDetail && "hidden lg:block")}>
          {selected ? (
            <Detail n={selected} onDecide={decide} onBack={() => setMobileDetail(false)} />
          ) : (
            <p className="text-sm text-muted-foreground">Select a notification.</p>
          )}
        </div>
      </div>

      <p className="hidden text-xs text-muted-foreground lg:block">
        <kbd className="font-mono">J</kbd>/<kbd className="font-mono">K</kbd> move · <kbd className="font-mono">A</kbd> approve · <kbd className="font-mono">R</kbd> reject · decisions wait 5s so you can undo
      </p>
    </div>
  );
}

function Detail({ n, onDecide, onBack }: {
  n: InAppNotification;
  onDecide: (n: InAppNotification, d: "approved" | "rejected") => void;
  onBack: () => void;
}) {
  const lines = blockLines(n.blocks);
  const body = lines.length > 0 ? lines : slackToText(n.text).split("\n").slice(1);
  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="w-fit gap-1 lg:hidden" onClick={onBack}>
        <ArrowLeft className="size-4" /> Back
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold [overflow-wrap:anywhere]">{firstLine(n.text)}</h2>
          <p className="text-xs text-muted-foreground">
            {routeLabel(n.route_key)} · {new Date(n.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
        {n.is_approval && <StatePill state={n.approval_state} />}
      </div>
      {body.some((l) => l.trim()) && (
        <div className="whitespace-pre-wrap rounded-lg border bg-background p-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {body.join("\n").trim()}
        </div>
      )}
      {isPending(n) && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onDecide(n, "approved")} className="gap-1">
            <Check className="size-4" /> Approve
          </Button>
          <Button variant="outline" onClick={() => onDecide(n, "rejected")} className="gap-1">
            <X className="size-4" /> Reject
          </Button>
        </div>
      )}
    </div>
  );
}

function StatePill({ state }: { state: InAppNotification["approval_state"] }) {
  const [label, tone] =
    state === "approved" ? ["approved", "bg-success/10 text-success"]
    : state === "rejected" ? ["rejected", "bg-destructive/10 text-destructive"]
    : state === "expired" ? ["expired", "bg-muted text-muted-foreground"]
    : ["pending", "bg-warning/10 text-warning"];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[11px]", tone)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}
