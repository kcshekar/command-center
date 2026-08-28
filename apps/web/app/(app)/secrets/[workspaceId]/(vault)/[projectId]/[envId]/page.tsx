"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { secretsApi, type SecretItem } from "@/lib/secrets-api";
import { unwrapKey, encryptData, decryptData } from "@/lib/zk-crypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, Plus } from "lucide-react";

export default function EnvironmentSecretsPage() {
  const { projectId, envId } = useParams<{ projectId: string; envId: string }>();
  const { workspaceKey } = useWorkspace();
  const [dek, setDek] = useState<CryptoKey | null>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [decryptError, setDecryptError] = useState(false);
  const [open, setOpen] = useState(false);
  const [keyLabel, setKeyLabel] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const refreshSecrets = useCallback(async () => {
    setSecrets(await secretsApi.listSecrets(envId));
  }, [envId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setDecryptError(false);
      try {
        const project = await secretsApi.getProject(projectId);
        if (workspaceKey) {
          try {
            setDek(await unwrapKey(project.wrappedDek, project.wrapIv, workspaceKey));
          } catch {
            setDecryptError(true);
          }
        }
        await refreshSecrets();
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId, envId, workspaceKey, refreshSecrets]);

  async function handleReveal(secretId: string) {
    if (!dek) return;
    try {
      const { ciphertext, iv } = await secretsApi.reveal(secretId);
      const plaintext = await decryptData(dek, ciphertext, iv);
      setRevealed((r) => ({ ...r, [secretId]: plaintext }));
    } catch {
      toast.error("Failed to decrypt this secret");
    }
  }

  function handleHide(secretId: string) {
    setRevealed((r) => {
      const next = { ...r };
      delete next[secretId];
      return next;
    });
  }

  async function handleCopy(secretId: string) {
    if (!dek) return;
    try {
      let plaintext = revealed[secretId];
      if (!plaintext) {
        const { ciphertext, iv } = await secretsApi.reveal(secretId);
        plaintext = await decryptData(dek, ciphertext, iv);
      }
      await navigator.clipboard.writeText(plaintext);
      await secretsApi.copyEvent(secretId);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  }

  async function handleAdd() {
    if (!dek || !keyLabel.trim() || !value) return;
    setSaving(true);
    try {
      const { ciphertext, iv } = await encryptData(dek, value);
      await secretsApi.upsertSecret(envId, keyLabel.trim(), ciphertext, iv);
      setKeyLabel("");
      setValue("");
      setOpen(false);
      toast.success("Secret saved");
      await refreshSecrets();
    } catch {
      toast.error("Failed to save secret");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (decryptError) {
    return (
      <p className="text-sm text-destructive">
        Could not decrypt this project&apos;s key with the current workspace key.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Secrets</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> Add secret
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add secret</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-label">Key</Label>
                <Input
                  id="key-label"
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  placeholder="DATABASE_URL"
                  className="font-mono"
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="secret-value">Value</Label>
                <Input
                  id="secret-value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  type="password"
                  className="font-mono"
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleAdd} disabled={saving || !keyLabel.trim() || !value}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets in this environment yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-sm">{s.keyLabel}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground break-all">
                  {revealed[s.id] ?? "••••••••••••"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => (revealed[s.id] ? handleHide(s.id) : handleReveal(s.id))}
                      aria-label={revealed[s.id] ? "Hide value" : "Reveal value"}
                    >
                      {revealed[s.id] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleCopy(s.id)} aria-label="Copy value">
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
