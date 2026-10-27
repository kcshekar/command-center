"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { financeApi, formatCents, formatDate, type Expense } from "@/lib/finance-api";

// R1 — setup for forwarding bank SMS from the phone. The endpoint files
// debits as the token owner's personal expenses; credits and OTPs are skipped
// with a 200 so the phone automation never shows an error.

function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-background px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>{value}</code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        aria-label={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => {});
        }}
      >
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {done ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export default function SmsSetupPage() {
  const [origin, setOrigin] = useState("");
  const [recent, setRecent] = useState<Expense[] | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
    financeApi.listExpenses("personal")
      .then((rows) => setRecent(rows.filter((e) => e.source === "sms").slice(0, 8)))
      .catch(() => setRecent([]));
  }, []);
  const endpoint = `${origin}/api/integrations/sms`;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Bank SMS</h1>
        <p className="text-sm text-muted-foreground">
          Forward bank SMS from your phone and every UPI or card debit lands in Finance as a personal expense. The same SMS twice is counted once. Credits, OTPs and autopay notices are ignored.
        </p>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">1. Make a token for your phone</h2>
        <p className="text-sm text-muted-foreground">
          In <Link href="/tokens" className="font-medium text-primary">Service Tokens</Link>, create a token named &quot;Phone SMS&quot; with only the <code className="font-mono text-xs">expenses:write</code> scope. Copy it when it&apos;s shown; you won&apos;t see it again. Expenses are filed under whoever created the token.
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">2. Point your phone at this address</h2>
        <CopyField label="endpoint" value={endpoint} />
        <p className="text-xs text-muted-foreground">
          Send a POST with header <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> and JSON body <code className="font-mono">{`{"text": "<the SMS>"}`}</code>. Your phone must be able to reach this address (same network, Tailscale, or the public domain).
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
          <h2 className="text-sm font-semibold">iPhone (Shortcuts)</h2>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Automation → New → <b>Message</b>; sender: your bank; message contains <b>debited</b> (add a second automation for <b>Sent</b> if your bank uses it).</li>
            <li>Choose <b>Run Immediately</b>.</li>
            <li>Action <b>Get Contents of URL</b>: the address above, method POST, header Authorization, Request Body JSON with key <b>text</b> = Shortcut Input → Content.</li>
          </ol>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
          <h2 className="text-sm font-semibold">Android (MacroDroid / Tasker)</h2>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Trigger: <b>SMS received</b> from your bank, containing <b>debited</b> or <b>sent</b>.</li>
            <li>Action: <b>HTTP request</b>, POST to the address above, header Authorization, body <code className="font-mono text-xs">{`{"text":"[sms_message]"}`}</code> as JSON.</li>
            <li>Allow it to run in the background.</li>
          </ol>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">3. Check it&apos;s working</h2>
        {recent === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No SMS expenses yet. After your next UPI payment it should appear here within seconds.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {recent.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span className="min-w-0 [overflow-wrap:anywhere]">{e.note ?? e.category} <span className="text-xs text-muted-foreground">· {e.category} · {formatDate(e.occurred_on)}</span></span>
                <span className="font-mono tabular-nums">{formatCents(e.amount_cents, e.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
