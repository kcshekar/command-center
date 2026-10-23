"use client";

import { useEffect, useState } from "react";
import { apiFetch, apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { ChevronDown, ChevronRight, ExternalLink, Plug, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:3005";

interface ExternalAccount {
  service: string;
  user_id: string;
  label: string;
  scopes: string[];
  status: string;
  last_refreshed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const SERVICE_LABEL: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  slack_user: "Slack",
  notion: "Notion",
};

export function ConnectedAccountsCompact() {
  const [email, setEmail] = useState("");
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const target = email.trim()
    ? `${WORKER_URL}/auth/google/start?email=${encodeURIComponent(email.trim())}`
    : null;

  async function refresh() {
    setLoading(true);
    try {
      setAccounts(await apiFetch<ExternalAccount[]>("/integrations/external-accounts"));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to load connected accounts"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  const grouped = accounts.reduce<Record<string, ExternalAccount[]>>((acc, a) => {
    (acc[a.service] ??= []).push(a);
    return acc;
  }, {});
  const serviceCount = Object.keys(grouped).length;

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Plug className="size-4 text-primary" />
            Connected Accounts
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {accounts.length === 0
              ? "No accounts linked yet."
              : `${accounts.length} account${accounts.length === 1 ? "" : "s"} across ${serviceCount} service${serviceCount === 1 ? "" : "s"}.`}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={loading} aria-label="Refresh">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </header>

      {/* Collapsed account list */}
      {accounts.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {Object.entries(grouped).map(([service, list]) =>
            list.map((a) => {
              const key = `${a.service}:${a.user_id}:${a.label}`;
              const isOpen = expanded.has(key);
              return (
                <li key={key} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggleExpand(key)}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isOpen ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
                      <span className="truncate text-xs">
                        <span className="text-muted-foreground">{SERVICE_LABEL[service] ?? service}</span>
                        <span className="mx-1.5 text-muted-foreground/50">·</span>
                        <span className="font-mono">{a.user_id}</span>
                        {a.label !== "primary" && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground">[{a.label}]</span>
                        )}
                      </span>
                    </div>
                    <Badge
                      variant={a.status === "active" ? "default" : "destructive"}
                      className="shrink-0 text-[10px]"
                    >
                      {a.status}
                    </Badge>
                  </button>
                  {isOpen && (
                    <div className="flex flex-col gap-1.5 border-t bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                      <div className="flex flex-wrap gap-1">
                        {a.scopes.map((s) => (
                          <code key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                            {s.replace("https://www.googleapis.com/auth/", "")}
                          </code>
                        ))}
                      </div>
                      {a.last_refreshed_at && (
                        <span>last refreshed {new Date(a.last_refreshed_at).toLocaleString()}</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}

      {/* Add account — collapsed by default */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setAddOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          {addOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Connect a Google account
        </button>
        {addOpen && (
          <div className="flex flex-col gap-2 pl-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="gmail-compact" className="text-[11px]">
                Gmail address
              </Label>
              <Input
                id="gmail-compact"
                type="email"
                placeholder="you@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="h-8 text-xs"
              />
            </div>
            <a
              href={target ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!target}
              onClick={(e) => !target && e.preventDefault()}
              className={cn(
                buttonVariants({ size: "sm" }),
                "h-8 w-fit gap-1.5 text-xs",
                !target && "pointer-events-none opacity-50"
              )}
            >
              Sign in with Google
              <ExternalLink className="size-3" />
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
