"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { secretsApi, type SecretItem, type ProjectDetail } from "@/lib/secrets-api";
import { unwrapKey, encryptData, decryptData } from "@/lib/zk-crypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Copy, Download, Eye, EyeOff, Pencil, Plus, Trash2, Upload, Wand2 } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { apiErrorMessage } from "@/lib/api";
import { parseKeyValueText } from "@/lib/kv-parse";

interface ImportRow {
  key: string;
  value: string;
  include: boolean;
}

function formatExport(rows: Array<{ key: string; value: string; note?: string }>, fmt: "env" | "json"): string {
  if (fmt === "json") {
    return JSON.stringify(Object.fromEntries(rows.map((r) => [r.key, r.value])), null, 2);
  }
  const needsQuoting = /[\s"'#`$\\]/;
  return rows
    .map((r) => {
      const quoted = needsQuoting.test(r.value) ? `"${r.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : r.value;
      const noteLine = r.note ? `# ${r.note.replace(/\n/g, " ")}\n` : "";
      return `${noteLine}${r.key}=${quoted}`;
    })
    .join("\n") + "\n";
}

export default function EnvironmentSecretsPage() {
  const { workspaceId, projectId, envId } = useParams<{ workspaceId: string; projectId: string; envId: string }>();
  const { workspaceKey, activeWorkspaceName } = useWorkspace();
  const [dek, setDek] = useState<CryptoKey | null>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [decryptError, setDecryptError] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [keyLabel, setKeyLabel] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [importing, setImporting] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"env" | "json">("env");
  const [exportText, setExportText] = useState("");
  const [exporting, setExporting] = useState(false);

  const refreshSecrets = useCallback(async () => {
    setSecrets(await secretsApi.listSecrets(envId));
  }, [envId]);

  // Notes decrypt as derived state — fires when dek arrives OR secrets change.
  // Kept out of refreshSecrets so that callback stays stable and doesn't retrigger
  // the parent effect (which would loop, since unwrapKey yields a new CryptoKey each run).
  useEffect(() => {
    if (!dek) return;
    let cancelled = false;
    (async () => {
      const decrypted: Record<string, string> = {};
      for (const r of secrets) {
        if (r.noteCiphertext && r.noteIv) {
          try {
            decrypted[r.id] = await decryptData(dek, r.noteCiphertext, r.noteIv);
          } catch {}
        }
      }
      if (!cancelled) setNotes(decrypted);
    })();
    return () => {
      cancelled = true;
    };
  }, [dek, secrets]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setDecryptError(false);
      try {
        const projectDetail = await secretsApi.getProject(projectId);
        setProject(projectDetail);
        if (workspaceKey) {
          try {
            setDek(await unwrapKey(projectDetail.wrappedDek, projectDetail.wrapIv, workspaceKey));
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
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to decrypt this secret"));
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
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to copy"));
    }
  }

  function openCreate() {
    setEditingId(null);
    setKeyLabel("");
    setValue("");
    setNote("");
    setOpen(true);
  }

  function openEdit(s: SecretItem) {
    setEditingId(s.id);
    setKeyLabel(s.keyLabel);
    setValue("");
    setNote(notes[s.id] ?? "");
    setOpen(true);
  }

  async function handleSave() {
    if (!dek || !keyLabel.trim()) return;
    if (!editingId && !value) return;
    setSaving(true);
    try {
      // Notes are always sent (even empty → null) so edit can clear one.
      const encryptedNote = note.trim() ? await encryptData(dek, note) : null;
      if (editingId) {
        const encrypted = value ? await encryptData(dek, value) : null;
        await secretsApi.updateSecret(editingId, {
          keyLabel: keyLabel.trim(),
          ciphertext: encrypted?.ciphertext,
          iv: encrypted?.iv,
          noteCiphertext: encryptedNote?.ciphertext ?? null,
          noteIv: encryptedNote?.iv ?? null,
        });
        // The cached plaintext in `revealed` is now stale if the value
        // changed — drop it so the row goes back to masked until re-revealed,
        // which re-fetches the current ciphertext instead of showing the old one.
        if (encrypted) handleHide(editingId);
        toast.success("Secret updated");
      } else {
        const { ciphertext, iv } = await encryptData(dek, value);
        await secretsApi.upsertSecret(envId, {
          keyLabel: keyLabel.trim(),
          ciphertext,
          iv,
          noteCiphertext: encryptedNote?.ciphertext ?? null,
          noteIv: encryptedNote?.iv ?? null,
        });
        toast.success("Secret saved");
      }
      setOpen(false);
      await refreshSecrets();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingId ? "Failed to update secret" : "Failed to save secret"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(secretId: string) {
    setDeleting(true);
    try {
      await secretsApi.deleteSecret(secretId);
      toast.success("Secret deleted");
      setConfirmDeleteId(null);
      handleHide(secretId);
      await refreshSecrets();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete secret"));
    } finally {
      setDeleting(false);
    }
  }

  function openImport() {
    setImportText("");
    setImportRows(null);
    setImportOpen(true);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleParseImport() {
    const direct = parseKeyValueText(importText);
    if (direct) {
      setImportRows(Object.entries(direct).map(([key, value]) => ({ key, value, include: true })));
      return;
    }
    setExtracting(true);
    try {
      const extracted = await secretsApi.extractKeyValuePairs(importText);
      const rows = Object.entries(extracted).map(([key, value]) => ({ key, value, include: true }));
      if (rows.length === 0) throw new Error("No key-value pairs found");
      setImportRows(rows);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't extract key-value pairs from that text"));
    } finally {
      setExtracting(false);
    }
  }

  async function handleConfirmImport() {
    if (!dek || !importRows) return;
    const rows = importRows.filter((r) => r.include && r.key.trim());
    if (rows.length === 0) return;
    setImporting(true);
    try {
      for (const row of rows) {
        const { ciphertext, iv } = await encryptData(dek, row.value);
        await secretsApi.upsertSecret(envId, { keyLabel: row.key.trim(), ciphertext, iv });
      }
      toast.success(`Imported ${rows.length} secret${rows.length === 1 ? "" : "s"}`);
      setImportOpen(false);
      await refreshSecrets();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Import failed partway through — check which secrets were saved"));
    } finally {
      setImporting(false);
    }
  }

  async function decryptAllForExport(): Promise<Array<{ key: string; value: string; note?: string }>> {
    if (!dek) return [];
    const rows: Array<{ key: string; value: string; note?: string }> = [];
    for (const s of secrets) {
      try {
        rows.push({ key: s.keyLabel, value: await decryptData(dek, s.ciphertext, s.iv), note: notes[s.id] || undefined });
      } catch {
        // skip broken rows rather than aborting the file
      }
    }
    return rows;
  }

  async function openExport() {
    if (!dek) return;
    setExporting(true);
    setExportOpen(true);
    try {
      setExportText(formatExport(await decryptAllForExport(), exportFormat));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to build export"));
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }

  async function reformatExport(fmt: "env" | "json") {
    setExportFormat(fmt);
    setExportText(formatExport(await decryptAllForExport(), fmt));
  }

  function handleDownloadExport() {
    const filename = exportFormat === "env" ? `${envName}.env` : `${envName}.json`;
    const mime = exportFormat === "env" ? "text/plain" : "application/json";
    const blob = new Blob([exportText], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopyExport() {
    await navigator.clipboard.writeText(exportText);
    toast.success("Copied to clipboard");
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (decryptError) {
    return (
      <p className="text-sm text-destructive">
        Could not decrypt this project&apos;s key with the current workspace key.
      </p>
    );
  }

  const envName = project?.environments.find((e) => e.id === envId)?.name ?? "Environment";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Breadcrumb
            items={[
              { label: "Secrets", href: "/secrets" },
              { label: activeWorkspaceName ?? "Workspace", href: `/secrets/${workspaceId}` },
              { label: project?.name ?? "Project", href: `/secrets/${workspaceId}/${projectId}` },
              { label: envName },
            ]}
          />
          <h1 className="mt-1 text-xl font-heading font-semibold tracking-tight">{envName}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={openExport} disabled={secrets.length === 0}>
            <Download className="size-4" /> Export
          </Button>
          <Dialog open={exportOpen} onOpenChange={setExportOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Export as .env or JSON</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <Label>Format</Label>
                  <select
                    value={exportFormat}
                    onChange={(e) => reformatExport(e.target.value as "env" | "json")}
                    className="h-8 rounded-md border bg-transparent px-2 text-sm"
                  >
                    <option value="env">.env</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
                <textarea
                  value={exporting ? "Decrypting…" : exportText}
                  readOnly
                  rows={12}
                  className="rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCopyExport} disabled={exporting || !exportText}>
                  <Copy className="size-4" /> Copy
                </Button>
                <Button onClick={handleDownloadExport} disabled={exporting || !exportText}>
                  <Download className="size-4" /> Download
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={openImport}>
            <Upload className="size-4" /> Import
          </Button>
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Import from JSON or .env</DialogTitle>
              </DialogHeader>
              {!importRows ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="import-file">Upload a file</Label>
                    <Input id="import-file" type="file" accept=".json,.env,.txt" onChange={handleImportFile} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="import-text">Or paste content</Label>
                    <textarea
                      id="import-text"
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      rows={8}
                      placeholder={'{"API_KEY": "..."}\nor\nAPI_KEY=...'}
                      className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Clean JSON or .env is parsed directly. Anything messier is sent to local Ollama to structure.
                    </p>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleParseImport} disabled={!importText.trim() || extracting} className="gap-1.5">
                      <Wand2 className="size-4" /> {extracting ? "Extracting…" : "Parse"}
                    </Button>
                  </DialogFooter>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {importRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No key-value pairs found.</p>
                  ) : (
                    <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                      {importRows.map((row, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={row.include}
                            onChange={(e) =>
                              setImportRows((rows) => rows!.map((r, ri) => (ri === i ? { ...r, include: e.target.checked } : r)))
                            }
                          />
                          <Input
                            value={row.key}
                            onChange={(e) => setImportRows((rows) => rows!.map((r, ri) => (ri === i ? { ...r, key: e.target.value } : r)))}
                            className="w-40 shrink-0 font-mono text-sm"
                          />
                          <Input
                            value={row.value}
                            onChange={(e) => setImportRows((rows) => rows!.map((r, ri) => (ri === i ? { ...r, value: e.target.value } : r)))}
                            className="font-mono text-sm"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setImportRows(null)}>
                      Back
                    </Button>
                    <Button onClick={handleConfirmImport} disabled={importing || importRows.filter((r) => r.include).length === 0}>
                      {importing ? "Importing…" : `Import ${importRows.filter((r) => r.include).length}`}
                    </Button>
                  </DialogFooter>
                </div>
              )}
            </DialogContent>
          </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
              <Plus className="size-4" /> Add secret
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit secret" : "Add secret"}</DialogTitle>
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
                  <Label htmlFor="secret-value">{editingId ? "New value (leave blank to keep current)" : "Value"}</Label>
                  <Input
                    id="secret-value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    type="password"
                    className="font-mono"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="secret-note">Note (optional)</Label>
                  <textarea
                    id="secret-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="Where this is used, rotation policy, etc."
                    className="rounded-md border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !keyLabel.trim() || (!editingId && !value)}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets in this environment yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-40 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-sm">
                  {s.keyLabel}
                  {notes[s.id] && (
                    <div className="mt-0.5 font-sans text-xs font-normal text-muted-foreground">{notes[s.id]}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground break-all">
                  {revealed[s.id] ?? "••••••••••••"}
                </TableCell>
                <TableCell className="text-right">
                  {confirmDeleteId === s.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete?</span>
                      <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleDelete(s.id)}>
                        {deleting ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
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
                      <Button variant="ghost" size="icon" onClick={() => openEdit(s)} aria-label="Edit">
                        <Pencil className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setConfirmDeleteId(s.id)} aria-label="Delete">
                        <Trash2 className="size-4" />
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
