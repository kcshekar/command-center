"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceApi, type Workspace } from "@/lib/workspace-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Boxes, Copy, Plus, ShieldAlert } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";

// Workspaces are shared across Secrets and Password Vault — one workspace,
// one password, holds both a project's worth of secrets AND vault items.
// This picker is rendered by both sections' landing pages, parameterized
// only by where selecting/creating a workspace navigates to.
export function WorkspacePicker({ title, description, basePath }: { title: string; description: string; basePath: string }) {
  const router = useRouter();
  const { create } = useWorkspace();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Two-step: create, then show the recovery key exactly once before navigating away.
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  const [recoveryKeyString, setRecoveryKeyString] = useState<string | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setWorkspaces(await workspaceApi.list());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    setError(null);
    if (!name.trim() || password.length < 8) {
      setError("Name required, password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setCreating(true);
    try {
      const { id, recoveryKeyString } = await create(name.trim(), password);
      setPendingWorkspaceId(id);
      setRecoveryKeyString(recoveryKeyString);
      setOpen(false);
      setName("");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to create workspace"));
    } finally {
      setCreating(false);
    }
  }

  function handleContinue() {
    if (!pendingWorkspaceId) return;
    router.push(`${basePath}/${pendingWorkspaceId}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> New workspace
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New workspace</DialogTitle>
              <DialogDescription>
                This password never leaves your browser. A recovery key will be generated next — save it somewhere
                safe, it&apos;s the only way back in if you forget this password.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="workspace-name">Name</Label>
                <Input id="workspace-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal" autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="workspace-password">Password</Label>
                <Input id="workspace-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="workspace-password-confirm">Confirm password</Label>
                <Input
                  id="workspace-password-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workspaces yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((w, i) => {
            const count = basePath === "/vault" ? w.vault_item_count : w.project_count;
            const countLabel = basePath === "/vault" ? "credential" : "project";
            return (
              <Link key={w.id} href={`${basePath}/${w.id}`}>
                <Card
                  className="animate-in cursor-pointer fade-in slide-in-from-bottom-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
                  style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
                >
                  <CardHeader className="flex flex-row items-center gap-3">
                    <Boxes className="size-5 text-muted-foreground" />
                    <div>
                      <CardTitle className="text-base font-medium">{w.name}</CardTitle>
                      <p className="text-xs text-muted-foreground">
                        {count} {countLabel}
                        {count === 1 ? "" : "s"}
                      </p>
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {/* Recovery key: shown exactly once, right after creation, never retrievable again. */}
      <Dialog open={recoveryKeyString !== null} onOpenChange={() => {}}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-destructive" />
              Save your recovery key
            </DialogTitle>
            <DialogDescription>
              This is the <strong>only</strong> way to recover this workspace if you forget its password. It will
              never be shown again — save it in a password manager or another safe place now.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-3">
            <code className="flex-1 break-all font-mono text-xs">{recoveryKeyString}</code>
            <Button
              variant="ghost"
              size="icon"
              onClick={async () => {
                if (recoveryKeyString) {
                  await navigator.clipboard.writeText(recoveryKeyString);
                  toast.success("Recovery key copied");
                }
              }}
              aria-label="Copy recovery key"
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={savedConfirmed}
              onChange={(e) => setSavedConfirmed(e.target.checked)}
            />
            I have saved this recovery key somewhere safe.
          </label>
          <DialogFooter>
            <Button onClick={handleContinue} disabled={!savedConfirmed}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
