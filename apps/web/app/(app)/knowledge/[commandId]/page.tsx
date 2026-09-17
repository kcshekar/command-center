"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { kbApi, uploadFile, type CommandDetail, type Attachment } from "@/lib/kb-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Copy, Download, Paperclip, Pencil, Send, Trash2, Upload } from "lucide-react";
import { apiErrorMessage } from "@/lib/api";

export default function CommandDetailPage() {
  const { commandId } = useParams<{ commandId: string }>();
  const router = useRouter();
  const [command, setCommand] = useState<CommandDetail | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editCommandText, setEditCommandText] = useState("");
  const [editContext, setEditContext] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, atts] = await Promise.all([kbApi.get(commandId), kbApi.listAttachments("kb_command", commandId)]);
      setCommand(detail);
      setAttachments(atts);
    } finally {
      setLoading(false);
    }
  }, [commandId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCopy() {
    if (!command) return;
    await navigator.clipboard.writeText(command.command_text);
    toast.success("Copied to clipboard");
  }

  function openEdit() {
    if (!command) return;
    setEditTitle(command.title);
    setEditCommandText(command.command_text);
    setEditContext(command.context ?? "");
    setEditNotes(command.notes ?? "");
    setEditOpen(true);
  }

  async function handleSaveEdit() {
    if (!editTitle.trim() || !editCommandText.trim()) return;
    setSaving(true);
    try {
      await kbApi.update(commandId, {
        title: editTitle.trim(),
        commandText: editCommandText.trim(),
        context: editContext.trim() || undefined,
        notes: editNotes.trim() || undefined,
      });
      toast.success("Command updated");
      setEditOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to update command"));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddComment() {
    if (!commentBody.trim()) return;
    setPostingComment(true);
    try {
      await kbApi.addComment(commandId, commentBody.trim());
      setCommentBody("");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to add comment"));
    } finally {
      setPostingComment(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadFile("kb_command", commandId, file);
      toast.success("File uploaded");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Upload failed — is file storage configured?"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDeleteAttachment(attachmentId: string) {
    try {
      await kbApi.deleteAttachment(attachmentId);
      toast.success("Attachment deleted");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete attachment"));
    }
  }

  async function handleDeleteCommand() {
    try {
      await kbApi.remove(commandId);
      toast.success("Command deleted");
      router.push("/knowledge");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete command"));
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!command) return <p className="text-sm text-destructive">Command not found.</p>;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link href="/knowledge" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Back to Knowledge Base
      </Link>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-lg">{command.title}</CardTitle>
            {command.context && <Badge variant="outline">{command.context}</Badge>}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={openEdit} aria-label="Edit command">
              <Pencil className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleDeleteCommand} aria-label="Delete command">
              <Trash2 className="size-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-md border bg-muted/50 p-3">
            <code className="flex-1 font-mono text-sm break-all whitespace-pre-wrap">{command.command_text}</code>
            <Button variant="ghost" size="icon" onClick={handleCopy} aria-label="Copy command">
              <Copy className="size-4" />
            </Button>
          </div>
          {command.notes && <p className="text-sm text-muted-foreground">{command.notes}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Paperclip className="size-4" /> Attachments
          </CardTitle>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Upload className="size-4" /> {uploading ? "Uploading…" : "Upload"}
          </Button>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelected} />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No attachments yet.</p>
          ) : (
            attachments.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span className="truncate">{a.filename}</span>
                <div className="flex items-center gap-1">
                  {a.downloadUrl && (
                    <a href={a.downloadUrl} target="_blank" rel="noreferrer">
                      <Button variant="ghost" size="icon" aria-label="Download">
                        <Download className="size-4" />
                      </Button>
                    </a>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => handleDeleteAttachment(a.id)} aria-label="Delete attachment">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Comments</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {command.comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {command.comments.map((c) => (
                <div key={c.id} className="text-sm">
                  <p>{c.body}</p>
                  <p className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleString()}</p>
                </div>
              ))}
            </div>
          )}
          <Separator />
          <div className="flex gap-2">
            <Input
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Add a comment…"
              onKeyDown={(e) => e.key === "Enter" && handleAddComment()}
            />
            <Button size="icon" onClick={handleAddComment} disabled={postingComment || !commentBody.trim()} aria-label="Post comment">
              <Send className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit command</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-kb-title">Title</Label>
              <Input id="edit-kb-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-kb-command">Command</Label>
              <textarea
                id="edit-kb-command"
                value={editCommandText}
                onChange={(e) => setEditCommandText(e.target.value)}
                rows={4}
                className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm whitespace-pre"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-kb-context">Context</Label>
              <Input id="edit-kb-context" value={editContext} onChange={(e) => setEditContext(e.target.value)} placeholder="git" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="edit-kb-notes">Notes</Label>
              <Input id="edit-kb-notes" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSaveEdit} disabled={saving || !editTitle.trim() || !editCommandText.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
