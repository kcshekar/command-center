"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { serviceTokensApi, AVAILABLE_SCOPES, type ServiceToken, type NewServiceToken } from "@/lib/service-tokens-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";

export default function ServiceTokensPage() {
  const { user } = useAuth();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  const [tokens, setTokens] = useState<ServiceToken[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [revealed, setRevealed] = useState<NewServiceToken | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setTokens(await serviceTokensApi.list());
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to load service tokens"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOwnerOrAdmin) refresh();
  }, [isOwnerOrAdmin]);

  function openCreate() {
    setName("");
    setScopes([]);
    setCreateOpen(true);
  }

  async function handleCreate() {
    if (!name.trim() || scopes.length === 0) return;
    setSaving(true);
    try {
      const created = await serviceTokensApi.create({ name: name.trim(), scopes });
      setCreateOpen(false);
      setRevealed(created);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to create token"));
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(id: string) {
    setDeleting(true);
    try {
      await serviceTokensApi.revoke(id);
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to revoke token"));
    } finally {
      setDeleting(false);
    }
  }

  async function copyToken() {
    if (!revealed) return;
    await navigator.clipboard.writeText(revealed.token);
    toast.success("Token copied");
  }

  if (!isOwnerOrAdmin) return <p className="text-sm text-muted-foreground">Only owners/admins can manage service tokens.</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Service Tokens</h1>
          <p className="text-sm text-muted-foreground">
            Bearer tokens for machine-to-machine calls from the Automations Worker. Raw tokens are shown once at creation and cannot be recovered.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
            <Plus className="size-4" /> Issue token
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Issue new service token</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="st-name">Name</Label>
                <Input id="st-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Automations Worker – home server" autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Scopes</Label>
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
              <p className="text-xs text-muted-foreground">
                Acting user defaults to you. All actions performed with this token show as taken by you in the audit log.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={saving || !name.trim() || scopes.length === 0}>
                {saving ? "Issuing…" : "Issue"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* One-time token reveal — closes on X, cannot be reopened */}
      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this token now</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              This is the only time the raw token will be shown. Store it somewhere safe (e.g. your Secrets vault) before closing this dialog.
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-3">
              <code className="flex-1 break-all font-mono text-xs">{revealed?.token}</code>
              <Button variant="ghost" size="icon" onClick={copyToken} aria-label="Copy">
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">No service tokens yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-3.5 text-muted-foreground" />
                    {t.name}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{t.token_prefix}…</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="outline" className="text-[10px] font-normal">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
                </TableCell>
                <TableCell className="text-right">
                  {confirmDeleteId === t.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground">Revoke?</span>
                      <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleRevoke(t.id)}>
                        {deleting ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteId(t.id)} aria-label="Revoke">
                      <Trash2 className="size-3.5" />
                    </Button>
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
