"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookMarked, Briefcase, Building, ChevronDown, ChevronRight,
  ExternalLink, FileEdit, FlaskConical, Loader2, MapPin, Save, Star, Tag, Trash2, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import {
  userProfileApi, jobLeadsApi, jobsDigestApi,
  REMOTE_PREFS, JOB_STATUSES,
  type UserProfile, type UserProfileInput,
  type JobLead, type JobStatus, type JobsDraft,
} from "@/lib/jobs-api";
import { useLiveEvents } from "@/lib/live-events";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<JobStatus, string> = {
  new: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  saved: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  applied: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  interview: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  rejected: "bg-destructive/15 text-destructive",
  skipped: "bg-muted text-muted-foreground",
};
const SCORE_LABEL: Record<string, string> = {
  "5": "Must apply", "4": "Strong matches", "3": "Consider",
  "2": "Low fit", "1": "Low fit", "0": "Unscored",
};
const SCORE_STYLE: Record<string, string> = {
  "5": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "4": "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  "3": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  "2": "bg-muted text-muted-foreground",
  "1": "bg-muted text-muted-foreground",
  "0": "bg-muted text-muted-foreground",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtSalary(j: JobLead): string {
  if (!j.salaryMin && !j.salaryMax) return "";
  const lo = j.salaryMin != null ? Math.round(j.salaryMin).toLocaleString() : "?";
  const hi = j.salaryMax != null ? Math.round(j.salaryMax).toLocaleString() : "?";
  return `${lo}–${hi} ${j.currency ?? ""}${j.salaryPeriod === "yearly" ? "/yr" : ""}`.trim();
}
function toCsv(arr: string[]): string { return arr.join(", "); }
function fromCsv(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

export default function JobsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [jobs, setJobs] = useState<JobLead[] | null>(null);
  const [draft, setDraft] = useState<JobsDraft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, j, d] = await Promise.all([
        userProfileApi.get(),
        jobLeadsApi.list({ limit: 500 }),
        jobsDigestApi.latest(),
      ]);
      setProfile(p);
      setJobs(j);
      setDraft(d);
      setErr(null);
      // Auto-open profile if empty, so new users land on something actionable.
      if (!p) setProfileOpen(true);
    } catch (e) {
      setErr(apiErrorMessage(e, "Failed to load jobs"));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Auto-refresh when a Prep or Tailor workflow this user started completes.
  useLiveEvents(["interview_prep:completed", "resume_tailor:completed"], (e) => {
    const which = e.type.startsWith("interview_prep") ? "Prep" : "Tailor";
    toast.success(`${which} completed — refreshed`);
    void refresh();
  });

  // Profile form state (mirror of profile, local edits)
  const [form, setForm] = useState<UserProfileInput>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (profile) {
      setForm({
        headline: profile.headline, yearsExp: profile.yearsExp,
        location: profile.location, remotePref: profile.remotePref,
        minSalaryLpa: profile.minSalaryLpa, currency: profile.currency,
        skills: profile.skills, keywords: profile.keywords, antiKeywords: profile.antiKeywords,
        bio: profile.bio,
      });
    } else {
      setForm({ remotePref: "any", currency: "INR" });
    }
  }, [profile]);

  async function saveProfile() {
    setSaving(true);
    try {
      await userProfileApi.save(form);
      toast.success("Profile saved");
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to save profile"));
    } finally {
      setSaving(false);
    }
  }

  const [acting, setActing] = useState<string | null>(null);
  async function setStatus(j: JobLead, status: JobStatus) {
    setActing(j.id);
    const before = jobs;
    setJobs((prev) => prev && prev.map((x) => (x.id === j.id ? { ...x, status } : x)));
    try {
      await jobLeadsApi.setStatus(j.id, status);
    } catch (e) {
      setJobs(before);
      toast.error(apiErrorMessage(e, "Failed to update status"));
    } finally {
      setActing(null);
    }
  }
  async function startPrep(j: JobLead) {
    setActing(j.id);
    try {
      await jobLeadsApi.startPrep(j.id);
      toast.success(`Prep started for ${j.company ?? j.title} — session appears in a minute`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to start prep"));
    } finally {
      setActing(null);
    }
  }
  async function startTailor(j: JobLead) {
    setActing(j.id);
    try {
      await jobLeadsApi.startTailor(j.id);
      toast.success(`Resume + cover letter tailoring for ${j.company ?? j.title} — Gmail draft appears if OAuth is set`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to start tailor"));
    } finally {
      setActing(null);
    }
  }
  async function remove(id: string) {
    setActing(id);
    try {
      await jobLeadsApi.remove(id);
      toast.success("Removed");
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to remove"));
    } finally {
      setActing(null);
    }
  }

  // Group by score bucket: 5, 4, 3, (2|1), null
  const buckets = useMemo(() => {
    const b: Record<string, JobLead[]> = { "5": [], "4": [], "3": [], "2": [], "0": [] };
    for (const j of jobs ?? []) {
      if (j.score == null) b["0"].push(j);
      else if (j.score >= 5) b["5"].push(j);
      else if (j.score === 4) b["4"].push(j);
      else if (j.score === 3) b["3"].push(j);
      else b["2"].push(j);
    }
    return b;
  }, [jobs]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          A2 pulls fresh matches from Adzuna twice a day, scores them against your profile, and Slacks a shortlist. Edit your profile below to tune the search.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Couldn&apos;t load</p>
          <p className="mt-1 text-muted-foreground">{err}</p>
        </div>
      )}

      {/* Latest digest */}
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
        <header className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookMarked className="size-4 text-primary" /> Latest digest
          </h2>
          {draft && <span className="text-xs text-muted-foreground">{fmtDate(draft.createdAt)}</span>}
        </header>
        {draft ? (
          <div className="rounded-md border bg-muted/30 p-4">
            <div className="text-sm font-medium">{draft.title}</div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-sans text-sm text-foreground/90">{draft.body}</pre>
            <div className="mt-3 text-[11px] text-muted-foreground">
              picked {String(draft.metadata.picked ?? 0)} · min score {String(draft.metadata.minScoreUsed ?? "—")}
            </div>
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">
            No digest yet. Trigger <code>a2-jobs-daily</code> from the Automations page to run one.
          </p>
        )}
      </section>

      {/* Profile editor */}
      <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm">
        <button
          type="button"
          onClick={() => setProfileOpen((v) => !v)}
          className="flex items-center justify-between gap-2 text-left"
        >
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              {profileOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              Your profile
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {profile
                ? `${profile.headline ?? "—"} · ${profile.skills.length} skill${profile.skills.length === 1 ? "" : "s"} · ${profile.keywords.length} search keyword${profile.keywords.length === 1 ? "" : "s"}`
                : "No profile yet — set one up so the automation can score matches for you."}
            </p>
          </div>
        </button>

        {profileOpen && (
          <div className="flex flex-col gap-3 border-t pt-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Headline">
                <Input value={form.headline ?? ""} onChange={(e) => setForm({ ...form, headline: e.target.value || null })} placeholder="Senior Backend Engineer" />
              </Field>
              <Field label="Years of experience">
                <Input type="number" min={0} max={60} value={form.yearsExp ?? ""} onChange={(e) => setForm({ ...form, yearsExp: e.target.value ? Number(e.target.value) : null })} />
              </Field>
              <Field label="Location (city only — the automation strips 'City, Country' for Adzuna)">
                <Input value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value || null })} placeholder="Hyderabad" />
              </Field>
              <Field label="Remote preference">
                <select
                  className="h-9 rounded-md border bg-transparent px-2 text-sm"
                  value={form.remotePref ?? "any"}
                  onChange={(e) => setForm({ ...form, remotePref: e.target.value as any })}
                >
                  {REMOTE_PREFS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="Min salary (LPA for India, else local annual)">
                <Input type="number" min={0} step="0.5" value={form.minSalaryLpa ?? ""} onChange={(e) => setForm({ ...form, minSalaryLpa: e.target.value ? Number(e.target.value) : null })} />
              </Field>
              <Field label="Currency">
                <Input value={form.currency ?? "INR"} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
              </Field>
            </div>
            <Field label="Skills (comma-separated)">
              <Input value={toCsv(form.skills ?? [])} onChange={(e) => setForm({ ...form, skills: fromCsv(e.target.value) })} placeholder="nodejs, postgres, typescript, temporal" />
            </Field>
            <Field label="Search keywords (comma-separated — the first 6 drive Adzuna's 'what' query)">
              <Input value={toCsv(form.keywords ?? [])} onChange={(e) => setForm({ ...form, keywords: fromCsv(e.target.value) })} placeholder="backend, platform, distributed systems" />
            </Field>
            <Field label="Anti-keywords (drop jobs whose title contains any of these)">
              <Input value={toCsv(form.antiKeywords ?? [])} onChange={(e) => setForm({ ...form, antiKeywords: fromCsv(e.target.value) })} placeholder="frontend only, pure frontend" />
            </Field>
            <Field label="Bio (free text — LLM context for the scorer)">
              <textarea
                className="min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm"
                value={form.bio ?? ""}
                onChange={(e) => setForm({ ...form, bio: e.target.value || null })}
                placeholder="Short self-description the scorer can lean on when ranking jobs."
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button onClick={() => void saveProfile()} disabled={saving} className="gap-1.5">
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                Save profile
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Jobs list */}
      <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm">
        <header>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Briefcase className="size-4 text-primary" /> Leads
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {jobs === null ? "Loading…" : `${jobs.length} total · ${jobs.filter(j => j.status === "saved" || j.status === "applied" || j.status === "interview").length} tracked`}
          </p>
        </header>

        {jobs === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : jobs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No leads yet. Trigger <code>a2-jobs-daily</code> from the Automations page.
          </p>
        ) : (
          (["5", "4", "3", "2", "0"] as const).filter((k) => buckets[k].length > 0).map((k) => (
            <div key={k} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <Badge className={cn("text-[10px]", SCORE_STYLE[k])}>{SCORE_LABEL[k]}</Badge>
                <span>{buckets[k].length}</span>
              </div>
              <ul className="flex flex-col divide-y rounded-md border">
                {buckets[k].slice(0, 20).map((j) => (
                  <li key={j.id} className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <a href={j.url} target="_blank" rel="noreferrer" className="truncate text-sm font-medium hover:underline">
                          {j.title} <ExternalLink className="ml-0.5 inline size-3 text-muted-foreground" />
                        </a>
                        <Badge variant="outline" className="text-[10px]">{j.source}</Badge>
                        <Badge className={cn("text-[10px]", STATUS_STYLE[j.status])}>{j.status}</Badge>
                        {j.score != null && (
                          <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-500">
                            {[...Array(j.score)].map((_, i) => <Star key={i} className="size-3" fill="currentColor" />)}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        {j.company && <span className="inline-flex items-center gap-1"><Building className="size-3" />{j.company}</span>}
                        {j.location && <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{j.location}</span>}
                        {fmtSalary(j) && <span className="inline-flex items-center gap-1"><Wallet className="size-3" />{fmtSalary(j)}</span>}
                        {j.postedAt && <span className="inline-flex items-center gap-1"><Tag className="size-3" />posted {fmtDate(j.postedAt)}</span>}
                      </div>
                      {j.scoreReason && (
                        <div className="text-[11px] text-muted-foreground italic">&ldquo;{j.scoreReason}&rdquo;</div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <select
                        className="h-7 rounded-md border bg-transparent px-1.5 text-xs"
                        value={j.status}
                        disabled={acting === j.id}
                        onChange={(e) => void setStatus(j, e.target.value as JobStatus)}
                      >
                        {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <Button
                        variant="outline" size="sm" className="h-7 gap-1 text-xs"
                        onClick={() => void startPrep(j)} disabled={acting === j.id} aria-label="Prep for interview"
                        title="Prep for interview — researches company + role, creates interview session"
                      >
                        <FlaskConical className="size-3.5" /> Prep
                      </Button>
                      <Button
                        variant="outline" size="sm" className="h-7 gap-1 text-xs"
                        onClick={() => void startTailor(j)} disabled={acting === j.id} aria-label="Tailor resume"
                        title="Tailor resume + cover letter + stage Gmail draft"
                      >
                        <FileEdit className="size-3.5" /> Tailor
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="size-7 hover:text-destructive"
                        onClick={() => void remove(j.id)} disabled={acting === j.id} aria-label="Remove"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
                {buckets[k].length > 20 && (
                  <li className="px-3.5 py-2 text-center text-[11px] text-muted-foreground">
                    +{buckets[k].length - 20} more hidden
                  </li>
                )}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px]">{label}</Label>
      {children}
    </div>
  );
}
