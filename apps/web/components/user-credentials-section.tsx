"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  userCredentialsApi,
  type UserCredential,
} from "@/lib/user-credentials-api";
import { apiErrorMessage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Display names for the known services.
const SERVICE_LABEL: Record<string, string> = {
  keepa: "Keepa",
  openai: "OpenAI",
  anthropic: "Anthropic",
  replicate: "Replicate",
  jsearch: "JSearch (RapidAPI)",
  serpapi: "SerpAPI",
  reddit: "Reddit",
  github: "GitHub",
  adzuna: "Adzuna",
  buffer: "Buffer",
};

export function UserCredentialsSection() {
  const [knownServices, setKnownServices] = useState<readonly string[]>([]);
  const [rows, setRows] = useState<UserCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [service, setService] = useState("keepa");
  const [label, setLabel] = useState("primary");
  const [key, setKey] = useState("");
  const [appId, setAppId] = useState(""); // adzuna only
  const [saving, setSaving] = useState(false);

  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const data = await userCredentialsApi.list();
      setKnownServices(data.knownServices);
      setRows(data.credentials);
      setError(null);
    } catch (err) {
      const msg = apiErrorMessage(err, "Failed to load API keys");
      setError(msg);
      if (!silent) toast.error(msg);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    // Adzuna needs both app_id + app_key; without appId the Jobs automation
    // can't call the API, so block save with a clear reason.
    if (service === "adzuna" && !appId.trim()) {
      toast.error("Adzuna needs both app_id and app_key — fill in app_id too.");
      return;
    }
    setSaving(true);
    try {
      await userCredentialsApi.save({
        service,
        label: label.trim() || undefined,
        key: key.trim(),
        metadata: service === "adzuna" ? { appId: appId.trim() } : undefined,
      });
      toast.success(`Saved ${SERVICE_LABEL[service] ?? service} key`);
      setKey("");
      setAppId("");
      setAddOpen(false);
      await refresh(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save key"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(svc: string, lbl: string) {
    const key = `${svc}:${lbl}`;
    setRemoving(key);
    try {
      await userCredentialsApi.remove(svc, lbl);
      toast.success(`Removed ${SERVICE_LABEL[svc] ?? svc} / ${lbl}`);
      await refresh(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to remove key"));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <KeyRound className="size-4 text-primary" />
            Your API Keys
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {rows === null
              ? "External API keys used by your automations."
              : rows.length === 0
                ? "No keys yet. Add Keepa first to enable A6 Price Watcher."
                : `${rows.length} key${rows.length === 1 ? "" : "s"} stored. Encrypted at rest.`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={refreshing}
          onClick={() => void refresh()}
          aria-label="Refresh keys"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </header>

      {rows === null && !error ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      ) : error && rows === null ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive">Couldn&apos;t load keys</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      ) : rows && rows.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-md border">
          {rows.map((r) => {
            const k = `${r.service}:${r.label}`;
            return (
              <li key={k} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {SERVICE_LABEL[r.service] ?? r.service}
                    </span>
                    {r.label !== "primary" && (
                      <Badge variant="outline" className="text-[10px]">
                        {r.label}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      {r.keyPrefix ?? "…"}
                      <span className="opacity-50">… hidden</span>
                    </code>
                    <span className="opacity-80">
                      updated {new Date(r.updatedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  disabled={removing === k}
                  onClick={() => void remove(r.service, r.label)}
                  aria-label={`Remove ${r.service} ${r.label}`}
                >
                  {removing === k ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setAddOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          {addOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Add API key
        </button>
        {addOpen && (
          <form onSubmit={save} className="flex flex-col gap-2 pl-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="service" className="text-[11px]">
                Service
              </Label>
              <select
                id="service"
                value={service}
                onChange={(e) => setService(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                {knownServices.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_LABEL[s] ?? s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="label" className="text-[11px]">
                Label (optional)
              </Label>
              <Input
                id="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="primary"
                className="h-8 text-xs"
              />
            </div>
            {service === "adzuna" && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="appId" className="text-[11px]">
                  Adzuna app_id <span className="text-muted-foreground">(public identifier, not secret)</span>
                </Label>
                <Input
                  id="appId"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="e.g. d630112c"
                  className="h-8 font-mono text-xs"
                />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="key" className="text-[11px]">
                {service === "adzuna" ? "Adzuna app_key" : "API key"}
              </Label>
              <Input
                id="key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Paste the key — it is encrypted on save"
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" className="h-8 gap-1 text-xs" disabled={saving || !key.trim()}>
                {saving && <Loader2 className="size-3 animate-spin" />}
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => {
                  setAddOpen(false);
                  setKey("");
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
