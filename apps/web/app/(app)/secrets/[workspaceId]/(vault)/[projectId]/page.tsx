"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { secretsApi, type ProjectDetail } from "@/lib/secrets-api";
import { useWorkspace } from "@/lib/workspace-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { Breadcrumb } from "@/components/breadcrumb";
import { apiErrorMessage } from "@/lib/api";

export default function ProjectDetailPage() {
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const { activeWorkspaceName } = useWorkspace();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProject(await secretsApi.getProject(projectId));
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function openCreate() {
    setEditingId(null);
    setName("");
    setOpen(true);
  }

  function openEdit(env: { id: string; name: string }) {
    setEditingId(env.id);
    setName(env.name);
    setOpen(true);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await secretsApi.updateEnvironment(editingId, name.trim());
        toast.success("Environment renamed");
      } else {
        await secretsApi.createEnvironment(projectId, name.trim());
        toast.success("Environment created");
      }
      setOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, editingId ? "Failed to rename environment" : "Failed to create environment"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      await secretsApi.deleteEnvironment(id);
      toast.success("Environment deleted");
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete environment"));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (notFound || !project) return <p className="text-sm text-destructive">Project not found or access denied.</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Breadcrumb
            items={[
              { label: "Secrets", href: "/secrets" },
              { label: activeWorkspaceName ?? "Workspace", href: `/secrets/${workspaceId}` },
              { label: project.name },
            ]}
          />
          <h1 className="mt-1 text-xl font-heading font-semibold tracking-tight">{project.name}</h1>
          <p className="text-sm text-muted-foreground">Environments</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openCreate} />}>
            <Plus className="size-4" /> New environment
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingId ? "Rename environment" : "New environment"}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="env-name">Name</Label>
              <Input
                id="env-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="PROD"
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

      {project.environments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No environments yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {project.environments.map((env, i) => (
            <Card
              key={env.id}
              className="animate-in fade-in slide-in-from-bottom-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
              style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
            >
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <Link href={`/secrets/${workspaceId}/${projectId}/${env.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Layers className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base font-medium">{env.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {env.secret_count} secret{env.secret_count === 1 ? "" : "s"}
                    </p>
                  </div>
                </Link>
                <div className="flex shrink-0 items-center gap-1">
                  {confirmDeleteId === env.id ? (
                    <div className="flex items-center gap-1.5">
                      <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleDelete(env.id)}>
                        {deleting ? "…" : "Confirm"}
                      </Button>
                      <Button variant="outline" size="sm" disabled={deleting} onClick={() => setConfirmDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(env)} aria-label="Rename">
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => setConfirmDeleteId(env.id)} aria-label="Delete">
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
