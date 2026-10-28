"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { brainApi, type KnowledgeInput, type KnowledgeItem } from "@/lib/brain-api";

// P1.1 — Brain: what the automations know about you (knowledge_items). Profile,
// resume and lesson items here are what RAG feeds into job scoring and the
// upgrade scan. Search is Postgres full-text; vector search arrives with
// local embeddings (P2.0).

const TYPES = ["profile", "resume", "note", "lesson", "snippet", "brief", "news", "prep"];
const EMPTY: KnowledgeInput = { type: "note", title: "", body: "", tags: [] };

export default function BrainPage() {
  const [rows, setRows] = useState<KnowledgeItem[] | null>(null);
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // the search actually run
  const [form, setForm] = useState<KnowledgeInput>(EMPTY);
  const [tagText, setTagText] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try { setRows(query ? await brainApi.search(query, type || undefined) : await brainApi.list(type || undefined)); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not load items")); setRows([]); }
  }
  useEffect(() => { void refresh(); }, [type, query]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toast.error("Add a title"); return; }
    setBusy(true);
    try {
      await brainApi.create({ ...form, tags: tagText.split(",").map((t) => t.trim()).filter(Boolean) });
      toast.success("Added");
      setForm(EMPTY); setTagText("");
      await refresh();
    } catch (err) { toast.error(apiErrorMessage(err, "Could not add")); }
    finally { setBusy(false); }
  }

  async function save(item: KnowledgeItem) {
    setBusy(true);
    try { await brainApi.update(item.id, { body: draft }); toast.success("Saved"); setOpen(null); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not save")); }
    finally { setBusy(false); }
  }

  async function remove(item: KnowledgeItem) {
    if (!window.confirm(`Delete "${item.title}"?`)) return;
    try { await brainApi.remove(item.id); toast.success("Deleted"); await refresh(); }
    catch (err) { toast.error(apiErrorMessage(err, "Could not delete")); }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Brain</h1>
        <p className="text-sm text-muted-foreground">
          What your automations know about you. Profile, resume and lesson items are read back into job scoring and
          the upgrade scan, so a few good ones here make every run sharper.
        </p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="brain-q">Search</Label>
          <Input id="brain-q" type="search" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setQuery(""); }} placeholder="typescript temporal postgres" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brain-type">Type</Label>
          <select id="brain-type" value={type} onChange={(e) => setType(e.target.value)} className="h-9 rounded-md border bg-transparent px-3 text-sm">
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <Button type="submit" variant="secondary">Search</Button>
      </form>

      <form onSubmit={add} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[auto_1fr_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brain-new-type">Type</Label>
          <select id="brain-new-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="h-9 rounded-md border bg-transparent px-3 text-sm">
            {TYPES.slice(0, 5).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brain-new-title">Title</Label>
          <Input id="brain-new-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Tech stack" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brain-new-tags">Tags (comma-separated)</Label>
          <Input id="brain-new-tags" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="skills, backend" />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-3">
          <Label htmlFor="brain-new-body">Content</Label>
          <Textarea id="brain-new-body" rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="TypeScript, Node, Postgres, Temporal. 8 years backend; led payments platform at …" />
        </div>
        <div><Button type="submit" disabled={busy}>Add to Brain</Button></div>
      </form>

      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? `Nothing matches “${query}”.` : "Nothing here yet. Start with your profile, tech stack and a resume summary."}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {rows.map((item) => (
            <li key={item.id} className="px-4 py-3 text-sm">
              <button type="button" className="flex w-full items-start gap-3 text-left" aria-expanded={open === item.id}
                onClick={() => { setOpen(open === item.id ? null : item.id); setDraft(item.body ?? ""); }}>
                <span className="mt-0.5 w-16 shrink-0 font-mono text-xs text-muted-foreground">{item.type}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere]">{item.title}</span>
                  {open !== item.id && item.body && (
                    <span className="line-clamp-2 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.body}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.source === "user" ? "you" : item.source}</span>
              </button>
              {open === item.id && (
                <div className="mt-3 flex flex-col gap-2 sm:pl-[4.75rem]">
                  <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Content of ${item.title}`} />
                  {item.tags.length > 0 && <p className="text-xs text-muted-foreground">Tags: {item.tags.join(", ")}</p>}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy || draft === (item.body ?? "")} onClick={() => void save(item)}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => void remove(item)}>Delete</Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
