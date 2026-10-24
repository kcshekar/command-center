"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookMarked,
  ExternalLink,
  GitBranch,
  GraduationCap,
  Loader2,
  Plus,
  Rss,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  learningGoalsApi, lessonsApi,
  SOURCE_KINDS, type SourceKind,
  type LearningGoal, type LearningGoalInput, type Lesson,
} from "@/lib/learning-api";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<SourceKind, string> = {
  github_release: "GitHub Releases",
  dev_to_tag: "dev.to tag",
  rss: "RSS feed",
};
const KIND_ICON: Record<SourceKind, React.ComponentType<{ className?: string }>> = {
  github_release: GitBranch,
  dev_to_tag: Tag,
  rss: Rss,
};
const KIND_PLACEHOLDER: Record<SourceKind, string> = {
  github_release: "owner/repo (e.g. oven-sh/bun)",
  dev_to_tag: "tag slug (e.g. rust)",
  rss: "https://example.com/feed.xml",
};

const PRIO_STYLE: Record<string, string> = {
  must: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  skim: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  skip: "bg-muted text-muted-foreground",
};

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function LearningPage() {
  const [goals, setGoals] = useState<LearningGoal[] | null>(null);
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [digest, setDigest] = useState<Lesson | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [g, l, d] = await Promise.all([
        learningGoalsApi.list(),
        lessonsApi.list(100),
        lessonsApi.latestDigest(),
      ]);
      setGoals(g);
      setLessons(l);
      setDigest(d);
      setErr(null);
    } catch (e) {
      setErr(apiErrorMessage(e, "Failed to load learning data"));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Dialog
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<LearningGoalInput>({ sourceKind: "github_release", target: "", weight: 3, enabled: true, note: null });
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  function openNew() {
    setForm({ sourceKind: "github_release", target: "", weight: 3, enabled: true, note: null });
    setOpen(true);
  }
  async function save() {
    if (!form.target.trim()) return;
    setSaving(true);
    try {
      await learningGoalsApi.create({ ...form, target: form.target.trim() });
      toast.success("Goal added");
      setOpen(false);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to add goal"));
    } finally {
      setSaving(false);
    }
  }
  async function toggle(g: LearningGoal, next: boolean) {
    setActing(g.id);
    const before = goals;
    setGoals((prev) => prev && prev.map((x) => x.id === g.id ? { ...x, enabled: next } : x));
    try {
      await learningGoalsApi.update(g.id, { enabled: next });
      toast.success(next ? "Enabled" : "Disabled");
    } catch (e) {
      setGoals(before);
      toast.error(apiErrorMessage(e, "Failed to toggle"));
    } finally {
      setActing(null);
    }
  }
  async function bumpWeight(g: LearningGoal, w: number) {
    setActing(g.id);
    const before = goals;
    setGoals((prev) => prev && prev.map((x) => x.id === g.id ? { ...x, weight: w } : x));
    try {
      await learningGoalsApi.update(g.id, { weight: w });
    } catch (e) {
      setGoals(before);
      toast.error(apiErrorMessage(e, "Failed to update weight"));
    } finally {
      setActing(null);
    }
  }
  async function remove(id: string) {
    try {
      await learningGoalsApi.remove(id);
      toast.success("Goal removed");
      setConfirmDel(null);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to delete"));
    }
  }

  // Group lessons by priority
  const byPrio: Record<"must" | "skim" | "skip" | "unrated", Lesson[]> = { must: [], skim: [], skip: [], unrated: [] };
  for (const l of lessons ?? []) {
    const p = l.metadata.classification?.priority ?? "unrated";
    (byPrio[p as keyof typeof byPrio] ?? byPrio.unrated).push(l);
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Learning Digest</h1>
        <p className="text-sm text-muted-foreground">
          A8 pulls new releases/articles from your learning goals every Monday 08:00 IST, classifies, and Slacks a short digest. Enabled goals only.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Couldn&apos;t load</p>
          <p className="mt-1 text-muted-foreground">{err}</p>
        </div>
      )}

      {/* Latest digest preview */}
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
        <header className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookMarked className="size-4 text-primary" /> Latest digest
          </h2>
          {digest && <span className="text-xs text-muted-foreground">{fmtDate(digest.createdAt)}</span>}
        </header>
        {digest ? (
          <div className="rounded-md border bg-muted/30 p-4">
            <div className="text-sm font-medium">{digest.title}</div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-sans text-sm text-foreground/90">{digest.body}</pre>
            <div className="mt-3 flex gap-2 text-[11px] text-muted-foreground">
              <span>must: {String(digest.metadata.mustCount ?? 0)}</span>
              <span>skim: {String(digest.metadata.skimCount ?? 0)}</span>
            </div>
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            No digest yet. Trigger <code>a8-learning-weekly</code> from the Automations page to run one on demand.
          </p>
        )}
      </section>

      {/* Goals */}
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
        <header className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <GraduationCap className="size-4 text-primary" /> Goals
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {goals === null ? "Loading…" : `${goals.length} total · ${goals.filter(g => g.enabled).length} enabled`}
            </p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openNew} />}>
              <Plus className="size-4" /> Add goal
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New learning goal</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px]">Source</Label>
                  <select
                    className="h-9 rounded-md border bg-transparent px-2 text-sm"
                    value={form.sourceKind}
                    onChange={(e) => setForm({ ...form, sourceKind: e.target.value as SourceKind, target: "" })}
                  >
                    {SOURCE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px]">Target</Label>
                  <Input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder={KIND_PLACEHOLDER[form.sourceKind]} />
                  {form.sourceKind !== "github_release" && (
                    <p className="text-[11px] text-muted-foreground">
                      Note: only <code>github_release</code> is wired into the fetcher today. {KIND_LABEL[form.sourceKind]} goals land in a follow-up.
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px]">Weight (1 = low, 5 = high)</Label>
                  <Input type="number" min={1} max={5} value={form.weight ?? 3} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px]">Note (optional)</Label>
                  <Input value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value || null })} />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={save} disabled={saving || !form.target.trim()}>
                  {saving ? "Adding…" : "Add"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </header>

        {goals === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : goals.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No goals yet. Add a GitHub repo to start.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {goals.map((g) => {
              const Icon = KIND_ICON[g.sourceKind] ?? Tag;
              return (
                <li key={g.id} className={cn("flex items-center gap-3 px-3.5 py-3", !g.enabled && "opacity-55")}>
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{g.target}</span>
                      <Badge variant="outline" className="text-[10px]">{KIND_LABEL[g.sourceKind]}</Badge>
                    </div>
                    {g.note && <div className="text-[11px] text-muted-foreground">{g.note}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {[1,2,3,4,5].map((w) => (
                      <button key={w} type="button"
                        onClick={() => void bumpWeight(g, w)}
                        disabled={acting === g.id}
                        aria-label={`Set weight ${w}`}
                        className={cn("p-0.5 transition-colors",
                          w <= g.weight ? "text-amber-500" : "text-muted-foreground/30 hover:text-muted-foreground")}>
                        <Star className="size-3.5" fill={w <= g.weight ? "currentColor" : "none"} />
                      </button>
                    ))}
                  </div>
                  <Button
                    size="sm" variant={g.enabled ? "ghost" : "outline"}
                    className="h-7 shrink-0 text-xs"
                    disabled={acting === g.id}
                    onClick={() => void toggle(g, !g.enabled)}
                  >
                    {g.enabled ? "Disable" : "Enable"}
                  </Button>
                  {confirmDel === g.id ? (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="destructive" size="sm" onClick={() => void remove(g.id)}>Confirm</Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirmDel(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="icon" className="size-7 shrink-0 hover:text-destructive" onClick={() => setConfirmDel(g.id)} aria-label="Delete">
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Lessons */}
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
        <header>
          <h2 className="text-base font-semibold">Lessons</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {lessons === null ? "Loading…" : `${lessons.length} total · must ${byPrio.must.length} · skim ${byPrio.skim.length} · skip ${byPrio.skip.length}`}
          </p>
        </header>

        {lessons === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : lessons.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No lessons yet. Trigger the schedule to pull some.</p>
        ) : (
          (["must", "skim", "skip", "unrated"] as const).filter((p) => byPrio[p].length > 0).map((p) => (
            <div key={p} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <Badge className={cn("text-[10px]", PRIO_STYLE[p] ?? "")}>{p}</Badge>
                <span>{byPrio[p].length}</span>
              </div>
              <ul className="flex flex-col divide-y rounded-md border">
                {byPrio[p].slice(0, 15).map((l) => (
                  <li key={l.id} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <a href={l.metadata.url ?? "#"} target="_blank" rel="noreferrer"
                        className="truncate text-sm font-medium hover:underline">
                        {l.title} <ExternalLink className="ml-0.5 inline size-3 text-muted-foreground" />
                      </a>
                      <div className="text-[11px] text-muted-foreground">
                        {l.metadata.target ?? "—"}
                        {l.metadata.classification?.rationale && (
                          <> · {l.metadata.classification.rationale}</>
                        )}
                      </div>
                    </div>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(l.metadata.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
