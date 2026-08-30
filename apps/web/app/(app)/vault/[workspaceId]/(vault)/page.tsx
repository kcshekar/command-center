"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { vaultApi, type VaultItemSummary } from "@/lib/vault-api";
import { generateKey, wrapKey, unwrapKey, encryptData, decryptData } from "@/lib/zk-crypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { apiErrorMessage } from "@/lib/api";

interface CredentialPayload {
  username: string;
  password: string;
  notes: string;
}

type DialogMode = "closed" | "create" | "edit";

export default function VaultItemsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { workspaceKey, activeWorkspaceName } = useWorkspace();
  const [items, setItems] = useState<VaultItemSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<DialogMode>("closed");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Viewing an item's decrypted contents happens in-place per row (no
  // separate dialog needed) — revealed[id] holds the decrypted payload.
  const [revealed, setRevealed] = useState<Record<string, CredentialPayload>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await vaultApi.list(workspaceId));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function openCreate() {
    setMode("create");
    setEditingItemId(null);
    setLabel("");
    setUrl("");
    setUsername("");
    setPassword("");
    setNotes("");
  }

  async function openEdit(itemId: string) {
    if (!workspaceKey) return;
    try {
      const item = await vaultApi.get(itemId);
      const dek = await unwrapKey(item.wrappedDek, item.wrapIv, workspaceKey, true);
      const payload: CredentialPayload = JSON.parse(await decryptData(dek, item.ciphertext, item.iv));
      setMode("edit");
      setEditingItemId(itemId);
      setLabel(item.label);
      setUrl(item.url ?? "");
      setUsername(payload.username);
      setPassword(payload.password);
      setNotes(payload.notes ?? "");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to decrypt this item"));
    }
  }

  async function handleSave() {
    if (!workspaceKey || !label.trim()) return;
    setSaving(true);
    try {
      const dek = await generateKey();
      const { wrapped: wrappedDek, wrapIv } = await wrapKey(dek, workspaceKey);
      const payload: CredentialPayload = { username, password, notes };
      const { ciphertext, iv } = await encryptData(dek, JSON.stringify(payload));

      if (mode === "create") {
        await vaultApi.create({ workspaceId, label: label.trim(), url: url || undefined, ciphertext, iv, wrappedDek, wrapIv });
        toast.success("Credential saved");
      } else if (editingItemId) {
        await vaultApi.update(editingItemId, { label: label.trim(), url: url || undefined, ciphertext, iv, wrappedDek, wrapIv });
        setRevealed((r) => {
          const next = { ...r };
          delete next[editingItemId];
          return next;
        });
        toast.success("Credential updated");
      }
      setMode("closed");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save credential"));
    } finally {
      setSaving(false);
    }
  }

  async function handleReveal(itemId: string) {
    if (!workspaceKey) return;
    try {
      const item = await vaultApi.get(itemId);
      const dek = await unwrapKey(item.wrappedDek, item.wrapIv, workspaceKey);
      const payload: CredentialPayload = JSON.parse(await decryptData(dek, item.ciphertext, item.iv));
      setRevealed((r) => ({ ...r, [itemId]: payload }));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to decrypt this item"));
    }
  }

  function handleHide(itemId: string) {
    setRevealed((r) => {
      const next = { ...r };
      delete next[itemId];
      return next;
    });
  }

  async function handleCopy(itemId: string, field: "username" | "password") {
    const payload = revealed[itemId];
    if (!payload) return;
    await navigator.clipboard.writeText(payload[field]);
    await vaultApi.copyEvent(itemId, field);
    toast.success(`${field === "username" ? "Username" : "Password"} copied`);
  }

  async function handleDelete(itemId: string) {
    try {
      await vaultApi.remove(itemId);
      toast.success("Credential deleted");
      handleHide(itemId);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete credential"));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Breadcrumb items={[{ label: "Password Vault", href: "/vault" }, { label: activeWorkspaceName ?? "Workspace" }]} />
          <h1 className="mt-1 text-xl font-heading font-semibold tracking-tight">{activeWorkspaceName ?? "Workspace"}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/secrets/${workspaceId}/settings`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings className="size-4" /> Settings
            </Button>
          </Link>
          <Dialog open={mode !== "closed"} onOpenChange={(o) => !o && setMode("closed")}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
              <Plus className="size-4" /> New credential
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{mode === "edit" ? "Edit credential" : "New credential"}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cred-label">Label</Label>
                  <Input id="cred-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="AWS Root" autoFocus />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cred-url">URL</Label>
                  <Input id="cred-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://aws.amazon.com" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cred-username">Username</Label>
                  <Input id="cred-username" value={username} onChange={(e) => setUsername(e.target.value)} className="font-mono" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cred-password">Password</Label>
                  <Input
                    id="cred-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cred-notes">Notes</Label>
                  <Input id="cred-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !label.trim()}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credentials yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Password</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const payload = revealed[item.id];
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-medium">{item.label}</div>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">
                        {item.url}
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {payload ? (
                      <div className="flex items-center gap-1">
                        {payload.username}
                        <Button variant="ghost" size="icon" className="size-6" onClick={() => handleCopy(item.id, "username")} aria-label="Copy username">
                          <Copy className="size-3" />
                        </Button>
                      </div>
                    ) : (
                      "••••••••"
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {payload ? (
                      <div className="flex items-center gap-1">
                        {payload.password}
                        <Button variant="ghost" size="icon" className="size-6" onClick={() => handleCopy(item.id, "password")} aria-label="Copy password">
                          <Copy className="size-3" />
                        </Button>
                      </div>
                    ) : (
                      "••••••••••••"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => (payload ? handleHide(item.id) : handleReveal(item.id))}
                        aria-label={payload ? "Hide" : "Reveal"}
                      >
                        {payload ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => openEdit(item.id)} aria-label="Edit">
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(item.id)} aria-label="Delete">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
