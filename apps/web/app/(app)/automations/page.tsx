"use client";

import { useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// Local-bootstrap page: hands you a "Sign in with Google" button that opens
// the Automations Worker's own loopback OAuth flow. Only meaningful locally
// — the worker's :3005 isn't exposed in prod.
const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:3005";

export default function AutomationsPage() {
  const [email, setEmail] = useState("");
  const target = email.trim()
    ? `${WORKER_URL}/auth/google/start?email=${encodeURIComponent(email.trim())}`
    : null;

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

          <p className="text-xs text-muted-foreground">
            Opens the worker's loopback flow at{" "}
            <code className="font-mono">{WORKER_URL}</code>. Set{" "}
            <code className="font-mono">NEXT_PUBLIC_WORKER_URL</code> in{" "}
            <code className="font-mono">apps/web/.env</code> to point elsewhere.
          </p>
        </div>
      </div>
    </div>
  );
}
