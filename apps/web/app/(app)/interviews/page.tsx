"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Briefcase, Building, Calendar, ChevronDown, ChevronRight, Clock, Copy, FileText,
  FlaskConical, Loader2, MessageSquare, Pencil, Plus, Save, Trash2, User, X,
} from "lucide-react";
import { toast } from "sonner";
import {
  interviewsApi, linkedDocsApi,
  SESSION_STATUSES, ROUND_KINDS, ROUND_OUTCOMES,
  type InterviewSession, type InterviewSessionDetail, type InterviewRound,
  type SessionStatus, type RoundKind, type RoundOutcome,
  type InterviewLinkedDoc,
} from "@/lib/interviews-api";
import { apiErrorMessage } from "@/lib/api";
import { useLiveEvents } from "@/lib/live-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<SessionStatus, string> = {
  researching:  "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  applied:      "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  interviewing: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  offered:      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected:     "bg-destructive/15 text-destructive",
  withdrawn:    "bg-muted text-muted-foreground",
};
const OUTCOME_STYLE: Record<string, string> = {
  passed:   "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed:   "bg-destructive/15 text-destructive",
  pending:  "bg-amber-500/15 text-amber-700 dark:text-amber-400",
};
const KIND_LABEL: Record<RoundKind, string> = {
  phone_screen: "Phone screen",
  technical: "Technical",
  system_design: "System design",
  behavioral: "Behavioral",
  onsite: "Onsite",
  bar_raiser: "Bar raiser",
  other: "Other",
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function InterviewsPage() {
  const [sessions, setSessions] = useState<InterviewSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Board (Kanban) is the default view; #list deep-links the detailed list.
  const [view, setView] = useState<"board" | "list">("board");
  useEffect(() => {
    const fromHash = () => setView(window.location.hash === "#list" ? "list" : "board");
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  function showView(v: "board" | "list") {
    setView(v);
    history.replaceState(null, "", v === "list" ? "#list" : window.location.pathname);
  }
  // Card click on the board opens that session expanded in the list.
  function openInList(id: string) {
    setExpandedId(id);
    showView("list");
    requestAnimationFrame(() => document.getElementById(`session-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  // Optimistic status move (board drag/drop or "Move to"). Stamps
  // appliedAt / decisionAt the first time a session reaches those stages.
  async function moveSession(s: InterviewSession, status: SessionStatus) {
    if (s.status === status) return;
    const before = sessions;
    setSessions((prev) => prev?.map((x) => (x.id === s.id ? { ...x, status } : x)) ?? prev);
    const now = new Date().toISOString();
    try {
      await interviewsApi.updateSession(s.id, {
        status,
        ...(status === "applied" && !s.appliedAt ? { appliedAt: now } : {}),
        ...(["offered", "rejected", "withdrawn"].includes(status) && !s.decisionAt ? { decisionAt: now } : {}),
      });
      toast.success(`${s.company} → ${status}`);
      void refresh();
    } catch (e) {
      setSessions(before);
      toast.error(apiErrorMessage(e, "Could not move this session"));
    }
  }

  const refresh = useCallback(async () => {
    try { setSessions(await interviewsApi.listSessions()); setErr(null); }
    catch (e) { setErr(apiErrorMessage(e, "Failed to load interviews")); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // When A3 prep or A9 tailor land, this page's session metadata (prep/
  // resume/cover ids) changes — refresh so the badges + linked docs appear.
  useLiveEvents(["interview_prep:completed", "resume_tailor:completed"], () => {
    void refresh();
  });

  const grouped = useMemo(() => {
    const g: Record<SessionStatus, InterviewSession[]> = {
      researching: [], applied: [], interviewing: [], offered: [], rejected: [], withdrawn: [],
    };
    for (const s of sessions ?? []) g[s.status].push(s);
    return g;
  }, [sessions]);

  // Create dialog
  const [newOpen, setNewOpen] = useState(false);
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  async function createSession() {
    if (!company.trim() || !role.trim()) return;
    setSaving(true);
    try {
      await interviewsApi.createSession({ company: company.trim(), role: role.trim() });
      toast.success("Session created");
      setCompany(""); setRole("");
      setNewOpen(false);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to create session"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight">Interviews</h1>
          <p className="text-sm text-muted-foreground">
            Your job pipeline. Prep on a job creates a session here; calendar sync and mail triage add rounds. Drag a card to move it, or open it for rounds, notes and tailored docs.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5" role="group" aria-label="View">
          {(["board", "list"] as const).map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => showView(v)}
              className={cn("rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {v}
            </button>
          ))}
        </div>
        <Dialog open={newOpen} onOpenChange={setNewOpen}>
          <DialogTrigger render={<Button size="sm" className="gap-1.5" />}>
            <Plus className="size-4" /> New session
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New interview session</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3">
              <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme" autoFocus /></Field>
              <Field label="Role"><Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Senior Backend Engineer" /></Field>
            </div>
            <DialogFooter>
              <Button onClick={() => void createSession()} disabled={saving || !company.trim() || !role.trim()}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Couldn&apos;t load</p>
          <p className="mt-1 text-muted-foreground">{err}</p>
        </div>
      )}

      {sessions === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-10 text-center">
          <MessageSquare className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">No interview sessions yet</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Click <strong>Prep</strong> on a lead in <code>/jobs</code> to create one, or add a manual session.
          </p>
        </div>
      ) : view === "board" ? (
        <Board grouped={grouped} onMove={(s, status) => void moveSession(s, status)} onOpen={openInList} />
      ) : (
        (SESSION_STATUSES).filter((s) => grouped[s].length > 0).map((status) => (
          <section key={status} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Badge className={cn("text-[10px]", STATUS_STYLE[status])}>{status}</Badge>
              <span>{grouped[status].length}</span>
            </div>
            <ul className="flex flex-col gap-2">
              {grouped[status].map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  expanded={expandedId === s.id}
                  onToggle={() => setExpandedId((prev) => (prev === s.id ? null : s.id))}
                  onChanged={() => void refresh()}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// --- Board (Kanban) ---------------------------------------------------------
// Four active stages are drop targets; Closed (rejected + withdrawn) is
// read-only because a drop there would be ambiguous — use "Move to".

const ACTIVE: SessionStatus[] = ["researching", "applied", "interviewing", "offered"];

function Board({
  grouped, onMove, onOpen,
}: {
  grouped: Record<SessionStatus, InterviewSession[]>;
  onMove: (s: InterviewSession, status: SessionStatus) => void;
  onOpen: (id: string) => void;
}) {
  const [over, setOver] = useState<SessionStatus | null>(null);
  const byId = useMemo(
    () => new Map(Object.values(grouped).flat().map((s) => [s.id, s])),
    [grouped],
  );
  const closed = [...grouped.rejected, ...grouped.withdrawn];

  function drop(e: React.DragEvent, status: SessionStatus) {
    e.preventDefault();
    setOver(null);
    const s = byId.get(e.dataTransfer.getData("text/plain"));
    if (s) onMove(s, status);
  }

  return (
    <div className="-mx-1 overflow-x-auto pb-2">
      <div className="grid min-w-[880px] grid-cols-5 gap-3 px-1">
        {ACTIVE.map((status) => (
          <section
            key={status}
            aria-label={`${status} column`}
            onDragOver={(e) => { e.preventDefault(); setOver(status); }}
            onDragLeave={() => setOver((o) => (o === status ? null : o))}
            onDrop={(e) => drop(e, status)}
            className={cn(
              "flex min-h-[220px] flex-col gap-2 rounded-xl border bg-muted/30 p-2 transition-colors",
              over === status && "border-primary bg-primary/5",
            )}
          >
            <ColumnHead status={status} count={grouped[status].length} />
            {grouped[status].map((s) => <BoardCard key={s.id} s={s} onMove={onMove} onOpen={onOpen} />)}
            {grouped[status].length === 0 && (
              <p className="px-1 py-3 text-xs text-muted-foreground">Drop a card here</p>
            )}
          </section>
        ))}
        <section aria-label="closed column" className="flex min-h-[220px] flex-col gap-2 rounded-xl border border-dashed p-2">
          <div className="flex items-center justify-between px-1 pt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Closed</span><span className="font-mono">{closed.length}</span>
          </div>
          {closed.map((s) => <BoardCard key={s.id} s={s} onMove={onMove} onOpen={onOpen} />)}
          {closed.length === 0 && <p className="px-1 py-3 text-xs text-muted-foreground">Rejected and withdrawn sessions land here.</p>}
        </section>
      </div>
    </div>
  );
}

function ColumnHead({ status, count }: { status: SessionStatus; count: number }) {
  return (
    <div className="flex items-center justify-between px-1 pt-0.5">
      <Badge className={cn("text-[10px] capitalize", STATUS_STYLE[status])}>{status}</Badge>
      <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
    </div>
  );
}

function BoardCard({
  s, onMove, onOpen,
}: {
  s: InterviewSession;
  onMove: (s: InterviewSession, status: SessionStatus) => void;
  onOpen: (id: string) => void;
}) {
  const closed = s.status === "rejected" || s.status === "withdrawn";
  return (
    <article
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; }}
      className={cn(
        "flex cursor-grab flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-sm shadow-sm active:cursor-grabbing",
        closed && "opacity-75",
      )}
    >
      <button onClick={() => onOpen(s.id)} className="flex flex-col items-start gap-0.5 text-left">
        <span className="font-semibold [overflow-wrap:anywhere]">{s.company}</span>
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.role}</span>
      </button>
      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-muted-foreground">
        <span>
          {s.roundCount ? `${s.roundCount} round${s.roundCount === 1 ? "" : "s"}` : "No rounds"}
          {s.appliedAt && ` · applied ${fmtDate(s.appliedAt)}`}
        </span>
        {closed && <Badge className={cn("text-[10px] capitalize", STATUS_STYLE[s.status])}>{s.status}</Badge>}
      </div>
      <select
        aria-label={`Move ${s.company} to`}
        value={s.status}
        onChange={(e) => onMove(s, e.target.value as SessionStatus)}
        className="h-7 rounded-md border bg-background px-1.5 text-[11px] text-muted-foreground"
      >
        {SESSION_STATUSES.map((st) => <option key={st} value={st}>{st === s.status ? `Stage: ${st}` : `Move to ${st}`}</option>)}
      </select>
    </article>
  );
}

function SessionCard({
  session, expanded, onToggle, onChanged,
}: {
  session: InterviewSession;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<InterviewSessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    try { setDetail(await interviewsApi.getSession(session.id)); }
    catch (e) { toast.error(apiErrorMessage(e, "Failed to load session")); }
    finally { setLoadingDetail(false); }
  }, [session.id]);

  useEffect(() => { if (expanded) void loadDetail(); }, [expanded, loadDetail]);

  async function setStatus(status: SessionStatus) {
    try {
      await interviewsApi.updateSession(session.id, { status });
      toast.success(`Status → ${status}`);
      onChanged();
    } catch (e) { toast.error(apiErrorMessage(e, "Failed to update")); }
  }
  async function remove() {
    try {
      await interviewsApi.deleteSession(session.id);
      toast.success("Session deleted");
      setConfirmDel(false);
      onChanged();
    } catch (e) { toast.error(apiErrorMessage(e, "Failed to delete")); }
  }

  const hasPrep = !!session.metadata.prepKnowledgeItemId;
  const hasResume = !!session.metadata.resumeKnowledgeItemId;
  const hasCover = !!session.metadata.coverLetterKnowledgeItemId;

  return (
    <li id={`session-${session.id}`} className="flex scroll-mt-4 flex-col gap-0 rounded-xl border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-start justify-between gap-3 px-3.5 py-3 text-left hover:bg-muted/30"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <span className="truncate text-sm font-medium">{session.company}</span>
            <span className="truncate text-sm text-muted-foreground">· {session.role}</span>
          </div>
          <div className="ml-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {session.roundCount != null && <span>{session.roundCount} round{session.roundCount === 1 ? "" : "s"}</span>}
            {hasPrep && <Badge variant="outline" className="text-[10px]">prep</Badge>}
            {hasResume && <Badge variant="outline" className="text-[10px]">resume</Badge>}
            {hasCover && <Badge variant="outline" className="text-[10px]">cover</Badge>}
            {session.appliedAt && <span>applied {fmtDate(session.appliedAt)}</span>}
            <span>updated {fmtDate(session.updatedAt)}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-4 border-t px-3.5 py-4">
          {loadingDetail || !detail ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading details…
            </div>
          ) : (
            <>
              {/* Status + action row */}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={detail.status}
                  onChange={(e) => void setStatus(e.target.value as SessionStatus)}
                  className="h-7 rounded-md border bg-transparent px-2 text-xs"
                >
                  {SESSION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {confirmDel ? (
                  <div className="inline-flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Delete session?</span>
                    <Button size="sm" variant="destructive" className="h-7" onClick={() => void remove()}>Confirm</Button>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirmDel(false)}>Cancel</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" className="h-7 hover:text-destructive" onClick={() => setConfirmDel(true)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>

              {/* Notes (editable) */}
              <NotesEditor session={detail} onSaved={onChanged} />

              {/* Linked documents */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <LinkedDocCard title="Prep notes" icon={FlaskConical} id={detail.metadata.prepKnowledgeItemId} />
                <LinkedDocCard title="Tailored resume" icon={FileText} id={detail.metadata.resumeKnowledgeItemId} />
                <LinkedDocCard title="Cover letter" icon={FileText} id={detail.metadata.coverLetterKnowledgeItemId} />
              </div>

              {/* Rounds */}
              <Rounds detail={detail} onChanged={() => void loadDetail()} />
            </>
          )}
        </div>
      )}
    </li>
  );
}

function NotesEditor({ session, onSaved }: { session: InterviewSessionDetail; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(session.notes ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(session.notes ?? ""); setEditing(false); }, [session.id, session.notes]);

  async function save() {
    setSaving(true);
    try {
      await interviewsApi.updateSession(session.id, { notes: text || null });
      toast.success("Notes saved");
      setEditing(false);
      onSaved();
    } catch (e) { toast.error(apiErrorMessage(e, "Failed to save notes")); }
    finally { setSaving(false); }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">Notes</Label>
        {!editing && (
          <Button size="sm" variant="ghost" className="h-6 gap-1 text-xs" onClick={() => setEditing(true)}>
            <Pencil className="size-3" /> Edit
          </Button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            className="min-h-[80px] rounded-md border bg-background px-3 py-2 font-sans text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setText(session.notes ?? ""); setEditing(false); }}>
              <X className="size-3.5" />
            </Button>
            <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
            </Button>
          </div>
        </>
      ) : (
        <div className="rounded-md border bg-muted/30 p-3">
          <pre className={cn("whitespace-pre-wrap font-sans text-xs text-foreground/90", !session.notes && "italic text-muted-foreground")}>
            {session.notes || "No notes yet. Prep + Tailor from /jobs populate this automatically."}
          </pre>
        </div>
      )}
    </div>
  );
}

function LinkedDocCard({
  title, icon: Icon, id,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  id: string | undefined;
}) {
  const [doc, setDoc] = useState<InterviewLinkedDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  async function load() {
    if (!id || doc) return;
    setLoading(true);
    try { setDoc(await linkedDocsApi.get(id)); }
    catch (e) { toast.error(apiErrorMessage(e, "Failed to load document")); }
    finally { setLoading(false); }
  }
  async function copy() {
    if (!doc?.body) return;
    try { await navigator.clipboard.writeText(doc.body); setJustCopied(true); setTimeout(() => setJustCopied(false), 1500); }
    catch { toast.error("Clipboard blocked"); }
  }

  if (!id) {
    return (
      <div className="rounded-md border bg-muted/20 p-3 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5" /> {title}
        </div>
        <div className="mt-1">Not generated yet.</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Icon className="size-3.5" /> {title}
        </div>
        <Button
          size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[10px]"
          onClick={() => { setOpen((v) => !v); if (!open) void load(); }}
        >
          {open ? "Hide" : "View"}
        </Button>
      </div>
      {open && (
        <div className="mt-2">
          {loading || !doc ? (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap rounded border bg-background p-2 font-sans text-[11px] text-foreground/90">
                {doc.body ?? "(empty)"}
              </pre>
              <div className="mt-1 flex justify-end">
                <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]" onClick={() => void copy()}>
                  <Copy className="size-3" /> {justCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Rounds({ detail, onChanged }: { detail: InterviewSessionDetail; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<RoundKind>("phone_screen");
  const [scheduledAt, setScheduledAt] = useState("");
  const [interviewer, setInterviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    setSaving(true);
    try {
      await interviewsApi.createRound({
        sessionId: detail.id, kind,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        interviewer: interviewer || null,
        notes: notes || null,
      });
      toast.success("Round added");
      setAdding(false);
      setKind("phone_screen"); setScheduledAt(""); setInterviewer(""); setNotes("");
      onChanged();
    } catch (e) { toast.error(apiErrorMessage(e, "Failed to add round")); }
    finally { setSaving(false); }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">Rounds ({detail.rounds.length})</Label>
        {!adding && (
          <Button size="sm" variant="outline" className="h-6 gap-1 text-xs" onClick={() => setAdding(true)}>
            <Plus className="size-3" /> Add round
          </Button>
        )}
      </div>

      {adding && (
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <Field label="Kind">
              <select className="h-8 rounded-md border bg-background px-2 text-xs" value={kind} onChange={(e) => setKind(e.target.value as RoundKind)}>
                {ROUND_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </Field>
            <Field label="Scheduled at">
              <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="h-8 text-xs" />
            </Field>
            <Field label="Interviewer">
              <Input value={interviewer} onChange={(e) => setInterviewer(e.target.value)} className="h-8 text-xs" />
            </Field>
            <Field label="Notes">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="h-8 text-xs" />
            </Field>
          </div>
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAdding(false)}><X className="size-3.5" /></Button>
            <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => void add()} disabled={saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
            </Button>
          </div>
        </div>
      )}

      {detail.rounds.length === 0 ? (
        <p className="rounded-md border bg-muted/20 p-3 text-[11px] italic text-muted-foreground">No rounds yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {detail.rounds.map((r) => <RoundRow key={r.id} round={r} onChanged={onChanged} />)}
        </ul>
      )}
    </div>
  );
}

function RoundRow({ round, onChanged }: { round: InterviewRound; onChanged: () => void }) {
  const [outcome, setOutcome] = useState<RoundOutcome | "">(round.outcome ?? "");
  async function setOut(v: RoundOutcome | "") {
    setOutcome(v);
    try {
      await interviewsApi.updateRound(round.id, { outcome: v || null });
    } catch (e) {
      setOutcome(round.outcome ?? "");
      toast.error(apiErrorMessage(e, "Failed to update outcome"));
    }
  }
  async function remove() {
    try { await interviewsApi.deleteRound(round.id); toast.success("Round removed"); onChanged(); }
    catch (e) { toast.error(apiErrorMessage(e, "Failed to delete round")); }
  }

  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">{KIND_LABEL[round.kind]}</Badge>
          {round.scheduledAt && (
            <span className="inline-flex items-center gap-1 text-muted-foreground"><Calendar className="size-3" />{fmtDateTime(round.scheduledAt)}</span>
          )}
          {round.durationMin != null && (
            <span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="size-3" />{round.durationMin}m</span>
          )}
          {round.interviewer && (
            <span className="inline-flex items-center gap-1 text-muted-foreground"><User className="size-3" />{round.interviewer}</span>
          )}
        </div>
        {round.notes && <div className="text-muted-foreground">{round.notes}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <select
          value={outcome}
          onChange={(e) => void setOut(e.target.value as RoundOutcome | "")}
          className="h-6 rounded-md border bg-transparent px-1.5 text-[11px]"
        >
          <option value="">—</option>
          {ROUND_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        {round.outcome && <Badge className={cn("text-[10px]", OUTCOME_STYLE[round.outcome])}>{round.outcome}</Badge>}
        <Button size="sm" variant="ghost" className="size-6 p-0 hover:text-destructive" onClick={() => void remove()} aria-label="Delete round">
          <Trash2 className="size-3" />
        </Button>
      </div>
    </li>
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
