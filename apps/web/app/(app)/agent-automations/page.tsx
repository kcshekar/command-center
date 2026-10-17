"use client";

import { useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, RefreshCw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, apiErrorMessage } from "@/lib/api";
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
  slack_user: "Slack (user token)",
  notion: "Notion",
};

export default function AutomationsPage() {
  const [email, setEmail] = useState("");
  const [accounts, setAccounts] = useState<ExternalAccount[]>([]);
  const [loading, setLoading] = useState(true);
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
  useEffect(() => { refresh(); }, []);

  const grouped = accounts.reduce<Record<string, ExternalAccount[]>>((acc, a) => {
    (acc[a.service] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Automations</h1>
        <p className="text-sm text-muted-foreground">
          Authorize a Google account so the Automations Worker can read Gmail, Calendar, and Tasks on your behalf.
        </p>
      </div>

      <div className="max-w-md rounded-2xl border bg-card p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <Zap className="size-4 text-primary" />
          Google sign-in
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="gmail">Gmail address</Label>
            <Input
              id="gmail"
              type="email"
              placeholder="you@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>

          <a
            href={target ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!target}
            onClick={(e) => !target && e.preventDefault()}
            className={cn(buttonVariants(), "gap-1.5", !target && "pointer-events-none opacity-50")}
          >
            Sign in with Google
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Connected accounts</h2>
          <Button variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={loading} aria-label="Refresh">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        {loading && accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No accounts connected yet.</p>
        ) : (
          <div className="flex flex-col gap-5">
            {Object.entries(grouped).map(([service, list]) => (
              <div key={service} className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {SERVICE_LABEL[service] ?? service}
                </h3>
                <ul className="divide-y">
                  {list.map((a) => (
                    <li key={`${a.service}:${a.user_id}:${a.label}`} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-sm">
                          {a.user_id}
                          {a.label !== "primary" && (
                            <span className="ml-2 text-[10px] text-muted-foreground">[{a.label}]</span>
                          )}
                        </span>
                        <Badge variant={a.status === "active" ? "default" : "destructive"} className="text-[10px]">
                          {a.status}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {a.scopes.map((s) => (
                          <code key={s} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                            {s.replace("https://www.googleapis.com/auth/", "")}
                          </code>
                        ))}
                      </div>
                      {a.last_refreshed_at && (
                        <span className="text-[11px] text-muted-foreground">
                          last refreshed {new Date(a.last_refreshed_at).toLocaleString()}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
