"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { kbApi, type CommandSummary } from "@/lib/kb-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Terminal } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";

export default function KnowledgeBasePage() {
  const [commands, setCommands] = useState<CommandSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [contextFilter, setContextFilter] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [commandText, setCommandText] = useState("");
  const [context, setContext] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setCommands(await kbApi.list(contextFilter ?? undefined));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextFilter]);

  async function handleCreate() {
    if (!title.trim() || !commandText.trim()) return;
    setSaving(true);
    try {
      await kbApi.create({ title: title.trim(), commandText: commandText.trim(), context: context.trim() || undefined, notes: notes.trim() || undefined });
      setTitle("");
      setCommandText("");
      setContext("");
      setNotes("");
      setOpen(false);
      toast.success("Command saved");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save command"));
    } finally {
      setSaving(false);
    }
  }

  const contexts = Array.from(new Set(commands.map((c) => c.context).filter((c): c is string => !!c)));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Knowledge Base</h1>
          <p className="text-sm text-muted-foreground">Commonly used commands, with notes and comments.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> New command
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New command</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="kb-title">Title</Label>
                <Input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Undo last commit, keep changes" autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="kb-command">Command</Label>
                <textarea
                  id="kb-command"
                  value={commandText}
                  onChange={(e) => setCommandText(e.target.value)}
                  placeholder={"git reset --soft HEAD~1\n# or paste a multi-line snippet"}
                  rows={4}
                  className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm whitespace-pre"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="kb-context">Context</Label>
                <Input id="kb-context" value={context} onChange={(e) => setContext(e.target.value)} placeholder="git" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="kb-notes">Notes</Label>
                <Input id="kb-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={saving || !title.trim() || !commandText.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {contexts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Badge variant={contextFilter === null ? "default" : "outline"} className="cursor-pointer" onClick={() => setContextFilter(null)}>
            All
          </Badge>
          {contexts.map((c) => (
            <Badge key={c} variant={contextFilter === c ? "default" : "outline"} className="cursor-pointer" onClick={() => setContextFilter(c)}>
              {c}
            </Badge>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : commands.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commands yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {commands.map((c, i) => (
            <Link key={c.id} href={`/knowledge/${c.id}`}>
              <Card
                className="animate-in cursor-pointer fade-in slide-in-from-bottom-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
                style={{ animationDelay: `${i * 40}ms`, animationFillMode: "backwards" }}
              >
                <CardHeader className="flex flex-row items-start gap-3">
                  <Terminal className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="text-base font-medium">{c.title}</CardTitle>
                    <code className="truncate text-xs text-muted-foreground">{c.command_text}</code>
                    {c.context && (
                      <Badge variant="outline" className="w-fit">
                        {c.context}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
