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

interface GoogleAccount {
  email: string;
  scopes: string[];
  status: string;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export default function AutomationsPage() {
  const [email, setEmail] = useState("");
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const target = email.trim()
    ? `${WORKER_URL}/auth/google/start?email=${encodeURIComponent(email.trim())}`
    : null;

  async function refresh() {
    setLoading(true);
    try {
      setAccounts(await apiFetch<GoogleAccount[]>("/integrations/google-accounts"));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to load Google accounts"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

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
          <h2 className="text-sm font-semibold">Connected Google accounts</h2>
          <Button variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={loading} aria-label="Refresh">
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>

        {loading && accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No Google accounts connected yet.</p>
        ) : (
          <ul className="divide-y">
            {accounts.map((a) => (
              <li key={a.email} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm">{a.email}</span>
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
        )}
      </div>
    </div>
  );
}
