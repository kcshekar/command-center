"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  pilgrimsApi,
  ttdWindowsApi,
  GENDERS, ID_TYPES, RELATIONSHIPS,
  SLOT_TYPES, TTD_STATUSES,
  type Pilgrim, type PilgrimInput,
  type TtdWindow, type TtdWindowInput,
} from "@/lib/pilgrim-api";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const ID_TYPE_LABEL: Record<string, string> = {
  aadhaar: "Aadhaar", passport: "Passport", voter_id: "Voter ID", driving_license: "Driving License",
};
const SLOT_LABEL: Record<string, string> = {
  ssd: "SSD", vip_break: "VIP Break", suprabhatam: "Suprabhatam",
  archana: "Archana", kalyanam: "Kalyanam", other: "Other",
};
const STATUS_STYLE: Record<string, string> = {
  planned: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  booked: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  missed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  cancelled: "bg-muted text-muted-foreground",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function fmtDateOnly(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function mask(s: string | undefined, keep = 4): string {
  if (!s) return "—";
  if (s.length <= keep) return s;
  return "•".repeat(Math.max(4, s.length - keep)) + s.slice(-keep);
}

export default function PilgrimPage() {
  const [pilgrims, setPilgrims] = useState<Pilgrim[] | null>(null);
  const [windows, setWindows] = useState<TtdWindow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPii, setShowPii] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const [p, w] = await Promise.all([pilgrimsApi.list(), ttdWindowsApi.list()]);
      setPilgrims(p);
      setWindows(w);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to load pilgrim pack"));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // ------------- Pilgrim dialog state -------------
  const [pOpen, setPOpen] = useState(false);
  const [pEditing, setPEditing] = useState<Pilgrim | null>(null);
  const [pForm, setPForm] = useState<PilgrimInput>({ fullName: "", relationship: "self" });
  const [pSaving, setPSaving] = useState(false);
  const [pConfirmDel, setPConfirmDel] = useState<string | null>(null);

  function openPilgrimNew() {
    setPEditing(null);
    setPForm({ fullName: "", relationship: "self", pii: {} });
    setPOpen(true);
  }
  function openPilgrimEdit(p: Pilgrim) {
    setPEditing(p);
    setPForm({
      fullName: p.fullName, gender: p.gender, idType: p.idType,
      relationship: p.relationship, note: p.note, pii: { ...p.pii },
    });
    setPOpen(true);
  }
  async function savePilgrim() {
    if (!pForm.fullName.trim()) return;
    setPSaving(true);
    try {
      if (pEditing) {
        await pilgrimsApi.update(pEditing.id, pForm);
        toast.success("Pilgrim updated");
      } else {
        await pilgrimsApi.create(pForm);
        toast.success("Pilgrim added");
      }
      setPOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save"));
    } finally {
      setPSaving(false);
    }
  }
  async function deletePilgrim(id: string) {
    try {
      await pilgrimsApi.remove(id);
      toast.success("Pilgrim removed");
      setPConfirmDel(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete"));
    }
  }

  // ------------- Window dialog state -------------
  const [wOpen, setWOpen] = useState(false);
  const [wEditing, setWEditing] = useState<TtdWindow | null>(null);
  const [wForm, setWForm] = useState<TtdWindowInput>({ darshanDate: "", slotType: "ssd", pilgrimIds: [] });
  const [wSaving, setWSaving] = useState(false);
  const [wConfirmDel, setWConfirmDel] = useState<string | null>(null);

  function openWindowNew() {
    setWEditing(null);
    setWForm({ darshanDate: "", slotType: "ssd", pilgrimIds: [] });
    setWOpen(true);
  }
  function openWindowEdit(w: TtdWindow) {
    setWEditing(w);
    setWForm({
      darshanDate: w.darshanDate.slice(0, 10),
      slotType: w.slotType,
      releaseAt: w.releaseAt ?? undefined,
      pilgrimIds: w.pilgrimIds,
      note: w.note,
      status: w.status,
      bookingRef: w.bookingRef,
    });
    setWOpen(true);
  }
  async function saveWindow() {
    if (!wForm.darshanDate) return;
    setWSaving(true);
    try {
      if (wEditing) {
        await ttdWindowsApi.update(wEditing.id, wForm);
        toast.success("Window updated");
      } else {
        await ttdWindowsApi.create(wForm);
        toast.success("Window added");
      }
      setWOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save"));
    } finally {
      setWSaving(false);
    }
  }
  async function deleteWindow(id: string) {
    try {
      await ttdWindowsApi.remove(id);
      toast.success("Window removed");
      setWConfirmDel(null);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete"));
    }
  }

  const pilgrimById = useMemo(() => {
    const m = new Map<string, Pilgrim>();
    for (const p of pilgrims ?? []) m.set(p.id, p);
    return m;
  }, [pilgrims]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-heading font-semibold tracking-tight">TTD / Pilgrim Pack</h1>
        <p className="text-sm text-muted-foreground">
          Keep your family's ID details encrypted and ready, and track upcoming TTD booking windows. The daily poll Slacks you when a release is imminent.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Couldn&apos;t load</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      )}

      {/* ========== Pilgrims ========== */}
      <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm">
        <header className="flex items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Users className="size-4 text-primary" /> Pilgrims
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {pilgrims === null ? "Loading…" : `${pilgrims.length} on file — ID numbers encrypted at rest.`}
            </p>
          </div>
          <Dialog open={pOpen} onOpenChange={setPOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openPilgrimNew} />}>
              <Plus className="size-4" /> Add pilgrim
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{pEditing ? "Edit pilgrim" : "Add pilgrim"}</DialogTitle>
              </DialogHeader>
              <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
                <Field label="Full name" required>
                  <Input value={pForm.fullName} onChange={(e) => setPForm({ ...pForm, fullName: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Relationship">
                    <select className="h-9 rounded-md border bg-transparent px-2 text-sm"
                      value={pForm.relationship ?? "self"}
                      onChange={(e) => setPForm({ ...pForm, relationship: e.target.value })}>
                      {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </Field>
                  <Field label="Gender">
                    <select className="h-9 rounded-md border bg-transparent px-2 text-sm"
                      value={pForm.gender ?? ""}
                      onChange={(e) => setPForm({ ...pForm, gender: e.target.value || null })}>
                      <option value="">—</option>
                      {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="ID type">
                  <select className="h-9 rounded-md border bg-transparent px-2 text-sm"
                    value={pForm.idType ?? ""}
                    onChange={(e) => setPForm({ ...pForm, idType: e.target.value || null })}>
                    <option value="">—</option>
                    {ID_TYPES.map((t) => <option key={t} value={t}>{ID_TYPE_LABEL[t]}</option>)}
                  </select>
                </Field>
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">Encrypted at rest</div>
                  <div className="flex flex-col gap-2">
                    <Field label="ID number"><Input value={pForm.pii?.idNumber ?? ""} onChange={(e) => setPForm({ ...pForm, pii: { ...(pForm.pii ?? {}), idNumber: e.target.value } })} placeholder="XXXX XXXX XXXX" /></Field>
                    <Field label="Date of birth"><Input type="date" value={pForm.pii?.dob ?? ""} onChange={(e) => setPForm({ ...pForm, pii: { ...(pForm.pii ?? {}), dob: e.target.value } })} /></Field>
                    <Field label="Phone"><Input value={pForm.pii?.phone ?? ""} onChange={(e) => setPForm({ ...pForm, pii: { ...(pForm.pii ?? {}), phone: e.target.value } })} placeholder="+91 ..." /></Field>
                    <Field label="Email"><Input type="email" value={pForm.pii?.email ?? ""} onChange={(e) => setPForm({ ...pForm, pii: { ...(pForm.pii ?? {}), email: e.target.value } })} /></Field>
                    <Field label="Address"><Input value={pForm.pii?.address ?? ""} onChange={(e) => setPForm({ ...pForm, pii: { ...(pForm.pii ?? {}), address: e.target.value } })} /></Field>
                  </div>
                </div>
                <Field label="Note"><Input value={pForm.note ?? ""} onChange={(e) => setPForm({ ...pForm, note: e.target.value || null })} placeholder="Optional memo" /></Field>
              </div>
              <DialogFooter>
                <Button onClick={savePilgrim} disabled={pSaving || !pForm.fullName.trim()}>
                  {pSaving ? "Saving…" : (pEditing ? "Save" : "Add")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </header>

        {pilgrims === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : pilgrims.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No pilgrims yet. Add yourself first.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {pilgrims.map((p) => {
              const reveal = showPii[p.id];
              return (
                <li key={p.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{p.fullName}</span>
                      <Badge variant="outline" className="text-[10px]">{p.relationship}</Badge>
                      {p.gender && <span className="text-[11px] text-muted-foreground">{p.gender}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      {p.idType && <span>{ID_TYPE_LABEL[p.idType] ?? p.idType}: <code className="font-mono">{reveal ? (p.pii.idNumber ?? "—") : mask(p.pii.idNumber)}</code></span>}
                      {p.pii.dob && <span>dob {reveal ? p.pii.dob : "•••••"}</span>}
                      {p.pii.phone && <span>{reveal ? p.pii.phone : mask(p.pii.phone)}</span>}
                      {p.pii.email && <span>{reveal ? p.pii.email : "•••@" + (p.pii.email.split("@")[1] ?? "")}</span>}
                    </div>
                    {p.note && <div className="text-[11px] text-muted-foreground">{p.note}</div>}
                  </div>
                  {pConfirmDel === p.id ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete?</span>
                      <Button variant="destructive" size="sm" onClick={() => void deletePilgrim(p.id)}>Confirm</Button>
                      <Button variant="outline" size="sm" onClick={() => setPConfirmDel(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="size-7" aria-label={reveal ? "Hide PII" : "Reveal PII"}
                        onClick={() => setShowPii((s) => ({ ...s, [p.id]: !s[p.id] }))}>
                        {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7" aria-label="Edit" onClick={() => openPilgrimEdit(p)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7 hover:text-destructive" aria-label="Delete"
                        onClick={() => setPConfirmDel(p.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ========== TTD Windows ========== */}
      <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm">
        <header className="flex items-center justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <CalendarClock className="size-4 text-primary" /> TTD windows
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {windows === null ? "Loading…" : `${windows.length} planned/booked. Default release = darshan date − 60 days at 10:00 IST.`}
            </p>
          </div>
          <Dialog open={wOpen} onOpenChange={setWOpen}>
            <DialogTrigger render={<Button size="sm" className="gap-1.5" onClick={openWindowNew} />}>
              <Plus className="size-4" /> Add window
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{wEditing ? "Edit window" : "Add window"}</DialogTitle>
              </DialogHeader>
              <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
                <Field label="Darshan date" required>
                  <Input type="date" value={wForm.darshanDate} onChange={(e) => setWForm({ ...wForm, darshanDate: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Slot type">
                    <select className="h-9 rounded-md border bg-transparent px-2 text-sm"
                      value={wForm.slotType ?? "ssd"}
                      onChange={(e) => setWForm({ ...wForm, slotType: e.target.value })}>
                      {SLOT_TYPES.map((s) => <option key={s} value={s}>{SLOT_LABEL[s]}</option>)}
                    </select>
                  </Field>
                  <Field label="Status">
                    <select className="h-9 rounded-md border bg-transparent px-2 text-sm"
                      value={wForm.status ?? "planned"}
                      onChange={(e) => setWForm({ ...wForm, status: e.target.value })}>
                      {TTD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                </div>
                <Field label="Release at (optional, overrides default)">
                  <Input type="datetime-local" value={wForm.releaseAt ? wForm.releaseAt.slice(0, 16) : ""}
                    onChange={(e) => setWForm({ ...wForm, releaseAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
                </Field>
                <Field label="Booking reference">
                  <Input value={wForm.bookingRef ?? ""} onChange={(e) => setWForm({ ...wForm, bookingRef: e.target.value || null })} placeholder="TTD-xxxxx (once booked)" />
                </Field>
                <Field label="Pilgrims">
                  <div className="flex flex-wrap gap-2 rounded-md border p-2">
                    {(pilgrims ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">Add a pilgrim first.</span>
                    ) : (pilgrims ?? []).map((p) => {
                      const picked = (wForm.pilgrimIds ?? []).includes(p.id);
                      return (
                        <button key={p.id} type="button"
                          onClick={() => setWForm({
                            ...wForm,
                            pilgrimIds: picked
                              ? (wForm.pilgrimIds ?? []).filter((id) => id !== p.id)
                              : [...(wForm.pilgrimIds ?? []), p.id],
                          })}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                            picked ? "border-primary bg-primary text-primary-foreground" : "hover:border-primary/50"
                          )}>
                          {p.fullName} ({p.relationship})
                        </button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Note"><Input value={wForm.note ?? ""} onChange={(e) => setWForm({ ...wForm, note: e.target.value || null })} /></Field>
              </div>
              <DialogFooter>
                <Button onClick={saveWindow} disabled={wSaving || !wForm.darshanDate}>
                  {wSaving ? "Saving…" : (wEditing ? "Save" : "Add")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </header>

        {windows === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : windows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No windows planned. Add one.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {windows.map((w) => {
              const names = w.pilgrimIds.map((id) => pilgrimById.get(id)?.fullName ?? "(deleted)").join(", ");
              return (
                <li key={w.id} className="flex items-start justify-between gap-3 px-3.5 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{fmtDateOnly(w.darshanDate)}</span>
                      <Badge variant="outline" className="text-[10px]">{SLOT_LABEL[w.slotType] ?? w.slotType}</Badge>
                      <Badge className={cn("text-[10px]", STATUS_STYLE[w.status])}>{w.status}</Badge>
                      {w.lastNotifiedAt && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="size-3" /> pinged {fmtDate(w.lastNotifiedAt)}</span>}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Opens: {fmtDate(w.releaseAt)}
                      {w.bookingRef && <span> · ref <code className="font-mono">{w.bookingRef}</code></span>}
                    </div>
                    {names && <div className="text-[11px] text-muted-foreground">Pilgrims: {names}</div>}
                    {w.note && <div className="text-[11px] text-muted-foreground">{w.note}</div>}
                  </div>
                  {wConfirmDel === w.id ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete?</span>
                      <Button variant="destructive" size="sm" onClick={() => void deleteWindow(w.id)}>Confirm</Button>
                      <Button variant="outline" size="sm" onClick={() => setWConfirmDel(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="size-7" aria-label="Edit" onClick={() => openWindowEdit(w)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7 hover:text-destructive" aria-label="Delete" onClick={() => setWConfirmDel(w.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px]">{label}{required && <span className="text-destructive"> *</span>}</Label>
      {children}
    </div>
  );
}
