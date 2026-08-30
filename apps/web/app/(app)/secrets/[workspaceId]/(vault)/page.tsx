"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { secretsApi, type Project } from "@/lib/secrets-api";
import { generateKey, wrapKey } from "@/lib/zk-crypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { FolderKanban, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { apiErrorMessage } from "@/lib/api";

export default function WorkspaceProjectsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { workspaceKey, activeWorkspaceName } = useWorkspace();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setProjects(await secretsApi.listProjects(workspaceId));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [workspaceId]);

  function openCreate() {
    setEditingId(null);
    setName("");
    setOpen(true);
  }

  function openEdit(p: Project) {
    setEditingId(p.id);
    setName(p.name);
    setOpen(true);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await secretsApi.updateProject(editingId, name.trim());
        toast.success("Project renamed");
      } else {
        if (!workspaceKey) return;
        const dek = await generateKey();
        const { wrapped, wrapIv } = await wrapKey(dek, workspaceKey);
        await secretsApi.createProject(workspaceId, name.trim(), wrapped, wrapIv);
        toast.success("Project created");
      }
      setOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingId ? "Failed to rename project" : "Failed to create project"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      await secretsApi.deleteProject(id);
      toast.success("Project deleted");
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete project"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Breadcrumb items={[{ label: "Secrets", href: "/secrets" }, { label: activeWorkspaceName ?? "Workspace" }]} />
          <h1 className="mt-1 text-xl font-heading font-semibold tracking-tight">{activeWorkspaceName ?? "Workspace"}</h1>
          <p className="text-sm text-muted-foreground">Projects and environments.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/secrets/${workspaceId}/settings`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings className="size-4" /> Settings
            </Button>
          </Link>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
              <Plus className="size-4" /> New project
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingId ? "Rename project" : "New project"}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="prod-config"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleSave()}
                />
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !name.trim()}>
                  {saving ? "Saving…" : editingId ? "Save" : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet. Create one to get started.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p, i) => (
            <Card
              key={p.id}
              className="animate-in fade-in slide-in-from-bottom-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
              style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
            >
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <Link href={`/secrets/${workspaceId}/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <FolderKanban className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base font-medium">{p.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {p.environment_count} environment{p.environment_count === 1 ? "" : "s"}
                    </p>
                  </div>
                </Link>
                <div className="flex shrink-0 items-center gap-1">
                  {confirmDeleteId === p.id ? (
                    <div className="flex items-center gap-1.5">
                      <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleDelete(p.id)}>
                        {deleting ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(p)} aria-label="Rename">
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteId(p.id)} aria-label="Delete">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
