"use client";

import { useEffect, useState } from "react";
import {
  workerClientsApi,
  AVAILABLE_SCOPES,
  type WorkerClient,
  type NewWorkerClient,
  type RotatedWorkerClient,
} from "@/lib/service-tokens-api";
import { apiErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Copy, Cog, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface SecretReveal {
  heading: string;
  clientId: string;
  clientSecret: string;
  context: string;
}

export function WorkerIdentitiesSection() {
  const [clients, setClients] = useState<WorkerClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([...AVAILABLE_SCOPES]);
  const [ttl, setTtl] = useState(3600);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<SecretReveal | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setClients(await workerClientsApi.list());
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to load worker identities"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function openCreate() {
    setName("");
    setScopes([...AVAILABLE_SCOPES]);
    setTtl(3600);
    setCreateOpen(true);
  }

  async function handleCreate() {
    if (!name.trim() || scopes.length === 0) return;
    setSaving(true);
    try {
      const created: NewWorkerClient = await workerClientsApi.create({
        name: name.trim(),
        allowedScopes: scopes,
        defaultTtlSeconds: ttl,
      });
      setCreateOpen(false);
      setReveal({
        heading: "Worker identity registered",
        clientId: created.client_id,
        clientSecret: created.client_secret,
        context: `Run on the worker VM: pnpm tokens:init (paste client_id and client_secret when prompted).`,
      });
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to register worker identity"));
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate(c: WorkerClient) {
    setActingId(c.id);
    try {
      const rotated: RotatedWorkerClient = await workerClientsApi.rotate(c.id);
      setReveal({
        heading: "Secret rotated & pushed to worker",
        clientId: rotated.client_id,
        clientSecret: rotated.client_secret,
        context: `Worker DB has been updated automatically. Caches are flushed, so the next mint uses the new secret immediately — no restart, no SSH.

Save this value in your password manager as a backup in case the worker ever needs re-seeding.`,
      });
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to rotate"));
    } finally {
      setActingId(null);
    }
  }

  async function handleDelete(id: string) {
    setActingId(id);
    try {
      await workerClientsApi.remove(id);
      toast.success("Worker identity deleted");
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete"));
    } finally {
      setActingId(null);
    }
  }

  async function handleToggleActive(c: WorkerClient) {
    setActingId(c.id);
    try {
      await workerClientsApi.update(c.id, { isActive: !c.is_active });
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to update"));
    } finally {
      setActingId(null);
    }
  }

  async function copySecret() {
    if (!reveal) return;
    await navigator.clipboard.writeText(reveal.clientSecret);
    toast.success("Secret copied");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <Cog className="size-4 text-primary" /> Worker Identities
          </h2>
          <p className="text-sm text-muted-foreground">
            OAuth2-style credentials for the Automations Worker. The worker uses these to mint short-lived service tokens on demand instead of carrying a long-lived token in <code className="font-mono text-xs">.env</code>.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus className="size-4" /> Register Worker
        </Button>
      </div>

      {/* Register modal */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register new worker identity</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="wc-name">Name</Label>
              <Input id="wc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Automations Worker – home VM" autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Allowed scopes</Label>
              <p className="text-[11px] text-muted-foreground">Max scopes a mint request can include. Each minted token can request a subset per activity.</p>
              {AVAILABLE_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) =>
                      setScopes((prev) => (e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)))
                    }
                  />
                  <code className="text-xs">{s}</code>
                </label>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wc-ttl">Default token TTL (seconds, 60–3600)</Label>
              <Input id="wc-ttl" type="number" min={60} max={3600} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleCreate} disabled={saving || !name.trim() || scopes.length === 0}>
              {saving ? "Registering…" : "Register"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal modal (shared for create + rotate) */}
      <Dialog open={!!reveal} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reveal?.heading}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              This is the only time the raw secret will be shown. Copy it to the worker VM before closing.
            </p>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">client_id</Label>
              <code className="rounded-md border bg-muted/50 p-2 font-mono text-xs break-all">{reveal?.clientId}</code>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs">client_secret</Label>
              <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
                <code className="flex-1 break-all font-mono text-xs">{reveal?.clientSecret}</code>
                <Button variant="ghost" size="icon" onClick={copySecret} aria-label="Copy">
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
            {reveal?.context && (
              <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">{reveal.context}</pre>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setReveal(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : clients.length === 0 ? (
        <p className="text-sm text-muted-foreground">No worker identities registered yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>TTL</TableHead>
              <TableHead>Live tokens</TableHead>
              <TableHead>Last mint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{c.client_id.slice(0, 20)}…</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {c.allowed_scopes.map((s) => (
                      <Badge key={s} variant="outline" className="text-[10px] font-normal">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs">{c.default_ttl_seconds}s</TableCell>
                <TableCell className="text-xs">{c.live_minted_count}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {c.last_mint_at ? new Date(c.last_mint_at).toLocaleString() : "never"}
                </TableCell>
                <TableCell>
                  <Badge variant={c.is_active ? "default" : "outline"} className="text-[10px]">
                    {c.is_active ? "active" : "disabled"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {confirmDeleteId === c.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete?</span>
                      <Button variant="destructive" size="sm" disabled={actingId === c.id} onClick={() => handleDelete(c.id)}>
                        {actingId === c.id ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="Rotate secret"
                        disabled={actingId === c.id}
                        onClick={() => handleRotate(c)}
                      >
                        <RefreshCw className={actingId === c.id ? "size-3.5 animate-spin" : "size-3.5"} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title={c.is_active ? "Disable" : "Enable"}
                        disabled={actingId === c.id}
                        onClick={() => handleToggleActive(c)}
                      >
                        <Cog className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 hover:text-destructive"
                        title="Delete"
                        onClick={() => setConfirmDeleteId(c.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
