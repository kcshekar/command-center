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
import { FolderKanban, Plus, Settings } from "lucide-react";

export default function WorkspaceProjectsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { workspaceKey, activeWorkspaceName } = useWorkspace();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

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

  async function handleCreate() {
    if (!name.trim() || !workspaceKey) return;
    setCreating(true);
    try {
      const dek = await generateKey();
      const { wrapped, wrapIv } = await wrapKey(dek, workspaceKey);
      await secretsApi.createProject(workspaceId, name.trim(), wrapped, wrapIv);
      setName("");
      setOpen(false);
      toast.success("Project created");
      await refresh();
    } catch {
      toast.error("Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{activeWorkspaceName ?? "Workspace"}</h1>
          <p className="text-sm text-muted-foreground">Projects and environments.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/secrets/${workspaceId}/settings`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings className="size-4" /> Settings
            </Button>
          </Link>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
              <Plus className="size-4" /> New project
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New project</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="project-name">Name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="prod-config"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
              </div>
              <DialogFooter>
                <Button onClick={handleCreate} disabled={creating || !name.trim()}>
                  {creating ? "Creating…" : "Create"}
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
          {projects.map((p) => (
            <Link key={p.id} href={`/secrets/${workspaceId}/${p.id}`}>
              <Card className="cursor-pointer transition-colors hover:border-primary/50">
                <CardHeader className="flex flex-row items-center gap-3">
                  <FolderKanban className="size-5 text-muted-foreground" />
                  <CardTitle className="text-base font-medium">{p.name}</CardTitle>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
