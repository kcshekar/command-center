"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check, Copy, FileText, GitBranch, GitPullRequest, Loader2, Pencil, Save, Share2, UserCircle, X,
} from "lucide-react";
import { toast } from "sonner";
import { profileDraftsApi, type ProfileDraft, type ProfileKind } from "@/lib/profile-drafts-api";
import { apiErrorMessage } from "@/lib/api";
import { useLiveEvents } from "@/lib/live-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ProfileKind, string> = {
  linkedin: "LinkedIn",
  readme: "GitHub README",
  resume: "Resume",
};
const KIND_ICON: Record<ProfileKind, React.ComponentType<{ className?: string }>> = {
  linkedin: Share2,
  readme: GitBranch,
  resume: FileText,
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function ProfileDraftsPage() {
  const [all, setAll] = useState<ProfileDraft[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setAll(await profileDraftsApi.listA7()); setErr(null); }
    catch (e) { setErr(apiErrorMessage(e, "Failed to load drafts")); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Workflow runs async in Temporal; toast with the PR link when the activity
  // fires its `github_pr:opened` event.
  useLiveEvents(["github_pr:opened"], (e) => {
    const p = e.payload as { prUrl?: string; prNumber?: number; repo?: string };
    if (!p.prUrl) return;
    toast.success(`PR #${p.prNumber} opened in ${p.repo}`, {
      action: { label: "Open", onClick: () => window.open(p.prUrl!, "_blank", "noopener") },
    });
  });

  // Latest draft per kind (first entry is newest; the list is already ordered DESC).
  const latest: Record<ProfileKind, ProfileDraft | null> = useMemo(() => {
    const out: Record<ProfileKind, ProfileDraft | null> = { linkedin: null, readme: null, resume: null };
    for (const d of all ?? []) {
      const k = d.metadata.kind as ProfileKind | undefined;
      if (!k || !(k in out)) continue;
      if (!out[k]) out[k] = d;
    }
    return out;
  }, [all]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Profile Drafts</h1>
        <p className="text-sm text-muted-foreground">
          A7 drafts refreshed LinkedIn / GitHub README / resume artifacts on the 1st of each month (10:00 IST), based on your profile + recent news/learning engagement. Edit below before copying anywhere.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Couldn&apos;t load drafts</p>
          <p className="mt-1 text-muted-foreground">{err}</p>
        </div>
      )}

      {all === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-10 text-center">
          <UserCircle className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No drafts yet</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Trigger <code>a7-profile-monthly</code> from the Automations page to run one on demand.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {(["linkedin", "readme", "resume"] as const).map((kind) => (
            <DraftCard key={kind} kind={kind} draft={latest[kind]} onSaved={() => void refresh()} />
          ))}
        </div>
      )}

      {/* History of all drafts (older than latest) — collapsible-feeling list */}
      {all && all.length > 3 && (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-5 shadow-sm">
          <h2 className="text-base font-semibold">History</h2>
          <p className="text-xs text-muted-foreground">Older drafts, newest first.</p>
          <ul className="flex flex-col divide-y rounded-md border">
            {all.slice(3).map((d) => {
              const kind = d.metadata.kind as ProfileKind | undefined;
              const Icon = kind ? KIND_ICON[kind] : UserCircle;
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <Icon className="size-3.5 text-muted-foreground" />
                      <span className="truncate text-sm">{d.title}</span>
                      {kind && <Badge variant="outline" className="text-[10px]">{KIND_LABEL[kind]}</Badge>}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{fmtDate(d.updatedAt)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function DraftCard({
  kind, draft, onSaved,
}: { kind: ProfileKind; draft: ProfileDraft | null; onSaved: () => void }) {
  const Icon = KIND_ICON[kind];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  useEffect(() => { setText(draft?.body ?? ""); setEditing(false); }, [draft?.id, draft?.body]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await profileDraftsApi.updateBody(draft.id, text);
      toast.success("Saved");
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }
  async function copy() {
    const t = draft?.body ?? "";
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1500);
    } catch { toast.error("Clipboard blocked"); }
  }

  async function openPR() {
    if (!draft) return;
    const key = "a7:lastRepo";
    const last = (() => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } })();
    const repo = window.prompt("Open PR into which repo? (owner/repo)", last);
    if (!repo || !/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo)) {
      if (repo != null) toast.error("Expected owner/repo");
      return;
    }
    try { localStorage.setItem(key, repo); } catch { /* noop */ }
    try {
      await profileDraftsApi.openPR(draft.id, repo);
      toast.success(`PR workflow started for ${repo}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to start PR workflow"));
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-primary" /> {KIND_LABEL[kind]}
        </h2>
        {draft && <span className="text-[11px] text-muted-foreground">{fmtDate(draft.updatedAt)}</span>}
      </header>
      {!draft ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No {KIND_LABEL[kind]} draft yet. Trigger <code>a7-profile-monthly</code>.
        </p>
      ) : editing ? (
        <>
          <textarea
            className="min-h-[220px] rounded-md border bg-background px-3 py-2 font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setText(draft.body ?? ""); setEditing(false); }}>
              <X className="size-3.5" /> Cancel
            </Button>
            <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="min-h-[160px] rounded-md border bg-muted/30 p-3">
            <pre className={cn("whitespace-pre-wrap font-sans text-xs text-foreground/90", !draft.body && "italic text-muted-foreground")}>
              {draft.body || "(empty)"}
            </pre>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => void copy()}>
              {justCopied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
              {justCopied ? "Copied" : "Copy"}
            </Button>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            {kind === "readme" && draft.body && (
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => void openPR()}>
                <GitPullRequest className="size-3.5" /> Open PR
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
