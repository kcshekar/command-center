"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { slackApi, type SlackConnection, type SlackRoute, type EnvStatus } from "@/lib/slack-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Bot, CheckCircle2, AlertCircle, Plus, RefreshCw, Trash2, ArrowRight, ShieldCheck, Zap, ToggleLeft, ToggleRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api";

const PRESET_ROUTES = [
  { key: "reminders.due", description: "Daily reminder notification sweep" },
  { key: "automations.approval", description: "Interactive human approval requests (Gmail trash, actions)" },
  { key: "automations.digest", description: "Morning brief and evening wrap-up summaries" },
  { key: "finance.weekly-summary", description: "Weekly financial expense summary alerts" },
];

export default function SlackSettingsPage() {
  const { user } = useAuth();
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null);
  const [connections, setConnections] = useState<SlackConnection[]>([]);
  const [routes, setRoutes] = useState<SlackRoute[]>([]);
  const [loading, setLoading] = useState(true);

  // Connection modal state
  const [connOpen, setConnOpen] = useState(false);
  const [connId, setConnId] = useState<string | null>(null);
  const [connName, setConnName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [savingConn, setSavingConn] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Route modal state
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeKey, setRouteKey] = useState("reminders.due");
  const [routeConnId, setRouteConnId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [allowButtons, setAllowButtons] = useState(false);
  const [approverIds, setApproverIds] = useState("");
  const [savingRoute, setSavingRoute] = useState(false);

  const [migrating, setMigrating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [es, conns, rts] = await Promise.all([
        slackApi.envStatus(),
        slackApi.listConnections(),
        slackApi.listRoutes(),
      ]);
      setEnvStatus(es);
      setConnections(conns);
      setRoutes(rts);
      if (conns.length > 0 && !routeConnId) {
        setRouteConnId(conns[0].id);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to load Slack registry settings"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isOwnerOrAdmin) refresh();
  }, [isOwnerOrAdmin]);

  async function handleMigrateEnv() {
    setMigrating(true);
    try {
      await slackApi.migrateEnv();
      toast.success("Migrated environment Slack bot to DB registry!");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to migrate .env Slack bot"));
    } finally {
      setMigrating(false);
    }
  }

  function openCreateConn() {
    setConnId(null);
    setConnName("");
    setBotToken("");
    setAppToken("");
    setConnOpen(true);
  }

  function openEditConn(c: SlackConnection) {
    setConnId(c.id);
    setConnName(c.name);
    setBotToken(""); // Masked — leave blank unless changing
    setAppToken("");
    setConnOpen(true);
  }

  async function handleSaveConn() {
    if (!connName.trim()) return;
    if (!connId && !botToken.trim()) return;
    setSavingConn(true);
    try {
      if (connId) {
        await slackApi.updateConnection(connId, {
          name: connName.trim(),
          botToken: botToken.trim() || undefined,
          appToken: appToken.trim() || undefined,
        });
        toast.success("Bot connection updated");
      } else {
        await slackApi.createConnection({
          name: connName.trim(),
          botToken: botToken.trim(),
          appToken: appToken.trim() || undefined,
        });
        toast.success("Bot connection created & verified");
      }
      setConnOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save bot connection"));
    } finally {
      setSavingConn(false);
    }
  }

  async function handleTestConn(id: string) {
    setTestingId(id);
    try {
      const res = await slackApi.testConnection(id);
      if (res.ok) {
        toast.success(`Verified connection (Workspace: ${res.workspaceId}, Bot ID: ${res.botUserId})`);
      } else {
        toast.error(`Verification failed: ${res.error}`);
      }
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Test failed"));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDeleteConn(id: string) {
    if (!confirm("Delete this Slack bot connection and its associated routes?")) return;
    try {
      await slackApi.removeConnection(id);
      toast.success("Bot connection deleted");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to delete connection"));
    }
  }

  function openCreateRoute() {
    setRouteKey("reminders.due");
    setRouteConnId(connections[0]?.id ?? "");
    setChannelId("");
    setChannelName("");
    setAllowButtons(false);
    setApproverIds("");
    setRouteOpen(true);
  }

  async function handleSaveRoute() {
    if (!routeKey.trim() || !routeConnId || !channelId.trim()) return;
    setSavingRoute(true);
    try {
      const idsArray = approverIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await slackApi.upsertRoute({
        routeKey: routeKey.trim(),
        connectionId: routeConnId,
        channelId: channelId.trim(),
        channelName: channelName.trim() || undefined,
        allowButtons,
        allowedApproverSlackIds: idsArray,
      });
      toast.success("Route mapping saved");
      setRouteOpen(false);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to save route mapping"));
    } finally {
      setSavingRoute(false);
    }
  }

  async function handleDeleteRoute(id: string) {
    try {
      await slackApi.removeRoute(id);
      toast.success("Route mapping removed");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to remove route"));
    }
  }

  if (!isOwnerOrAdmin) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Admin access required to configure Slack integration.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-heading font-semibold tracking-tight flex items-center gap-2">
            <Bot className="size-5 text-primary" /> Multi-Bot Slack Registry
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage multiple Slack bots, encrypted tokens, and routing rules for automated alerts and human approvals.
          </p>
        </div>
      </div>

      {envStatus?.envConfigured && !envStatus.hasDbConnections && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-amber-950 dark:text-amber-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="text-sm">
              <span className="font-semibold">Legacy .env Slack Bot Detected:</span> Your environment contains <code className="font-mono text-xs">SLACK_BOT_TOKEN</code>. You can import it into the registry in one click.
            </div>
          </div>
          <Button size="sm" variant="default" onClick={handleMigrateEnv} disabled={migrating} className="gap-1.5 shrink-0">
            {migrating ? "Importing…" : "Import .env Bot"} <ArrowRight className="size-3.5" />
          </Button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading registry…</p>
      ) : (
        <>
          {/* Section 1: Slack Bot Connections */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">Bot Connections</h2>
                <p className="text-xs text-muted-foreground">Registered Slack App tokens encrypted at rest (AES-256-GCM).</p>
              </div>
              <Button size="sm" onClick={openCreateConn} className="gap-1.5">
                <Plus className="size-4" /> Add Bot Connection
              </Button>
            </div>

            {connections.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                No database Slack bots registered yet. Add a bot connection or import your environment bot.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {connections.map((c) => (
                  <div key={c.id} className="flex flex-col justify-between rounded-xl border bg-card p-4 shadow-sm">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-start justify-between">
                        <div className="font-medium text-sm flex items-center gap-2">
                          {c.name}
                          <Badge variant={c.status === "active" ? "default" : "destructive"} className="text-[10px]">
                            {c.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-muted-foreground"
                            onClick={() => handleTestConn(c.id)}
                            disabled={testingId === c.id}
                            title="Test connection auth.test"
                          >
                            <RefreshCw className={cn("size-3.5", testingId === c.id && "animate-spin")} />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => openEditConn(c)} title="Edit name">
                            <ShieldCheck className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteConn(c.id)} title="Delete">
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>

                      <div className="text-xs font-mono text-muted-foreground flex flex-col gap-0.5">
                        <span>Workspace: {c.workspace_id}</span>
                        <span>Bot User ID: {c.bot_user_id}</span>
                      </div>

                      {c.granted_scopes && c.granted_scopes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {c.granted_scopes.map((scope) => (
                            <Badge key={scope} variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 2: Route Mappings */}
          <div className="flex flex-col gap-4 pt-4 border-t">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">Route Mappings</h2>
                <p className="text-xs text-muted-foreground">Map abstract system route keys to specific bot connections and channel destinations.</p>
              </div>
              <Button size="sm" variant="outline" onClick={openCreateRoute} disabled={connections.length === 0} className="gap-1.5">
                <Plus className="size-4" /> Add Route Mapping
              </Button>
            </div>

            {routes.length === 0 ? (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                No route mappings configured. Without a database route, reminder alerts fall back to <code className="font-mono text-xs">.env</code> settings.
              </div>
            ) : (
              <div className="rounded-xl border bg-card overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 border-b font-medium text-muted-foreground">
                    <tr>
                      <th className="p-3">Route Key</th>
                      <th className="p-3">Bot Connection</th>
                      <th className="p-3">Channel Destination</th>
                      <th className="p-3">Interactive Buttons</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {routes.map((r) => (
                      <tr key={r.id} className="hover:bg-muted/30">
                        <td className="p-3 font-mono font-medium text-foreground">{r.route_key}</td>
                        <td className="p-3">{r.connection_name}</td>
                        <td className="p-3 font-mono">
                          {r.channel_name ? `${r.channel_name} (${r.channel_id})` : r.channel_id}
                        </td>
                        <td className="p-3">
                          {r.allow_buttons ? (
                            <Badge variant="default" className="text-[10px] gap-1">
                              <Zap className="size-3" /> Enabled
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">Disabled</Badge>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteRoute(r.id)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* Bot Connection Modal */}
      <Dialog open={connOpen} onOpenChange={setConnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{connId ? "Edit Bot Connection" : "Add Slack Bot Connection"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="conn-name">Connection Name</Label>
              <Input id="conn-name" value={connName} onChange={(e) => setConnName(e.target.value)} placeholder="e.g. Personal Operations Bot" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bot-token">Bot User OAuth Token (xoxb-...)</Label>
              <Input
                id="bot-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={connId ? "•••••••••••• (leave empty to keep unchanged)" : "xoxb-..."}
              />
              <p className="text-[11px] text-muted-foreground">Token is validated against Slack <code className="font-mono">auth.test</code> and encrypted with AES-256-GCM.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-token">App-Level Token (xapp-... optional)</Label>
              <Input
                id="app-token"
                type="password"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder="xapp-... (required only for Socket Mode interactive apps)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleSaveConn} disabled={savingConn || !connName.trim() || (!connId && !botToken.trim())}>
              {savingConn ? "Validating & Saving…" : "Save Connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Route Mapping Modal */}
      <Dialog open={routeOpen} onOpenChange={setRouteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add / Edit Route Mapping</DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-4 py-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="route-key">System Route Key</Label>
              <select
                id="route-key"
                value={routeKey}
                onChange={(e) => setRouteKey(e.target.value)}
                className="h-9 w-full min-w-0 rounded-md border bg-transparent px-3 text-sm"
              >
                {PRESET_ROUTES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} — {p.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="route-conn">Bot Connection</Label>
              <select
                id="route-conn"
                value={routeConnId}
                onChange={(e) => setRouteConnId(e.target.value)}
                className="h-9 w-full min-w-0 rounded-md border bg-transparent px-3 text-sm"
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.workspace_id})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-id">Slack Channel ID (C...)</Label>
              <Input id="channel-id" value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="e.g. C0897654321" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-name">Channel Display Name (Optional)</Label>
              <Input id="channel-name" value={channelName} onChange={(e) => setChannelName(e.target.value)} placeholder="e.g. #alerts" />
            </div>

            <div className="flex items-center gap-2 pt-2">
              <input
                type="checkbox"
                id="allow-buttons"
                checked={allowButtons}
                onChange={(e) => setAllowButtons(e.target.checked)}
                className="size-4 rounded border"
              />
              <Label htmlFor="allow-buttons" className="cursor-pointer text-xs font-normal">
                Allow interactive buttons in notifications on this route
              </Label>
            </div>

            {allowButtons && (
              <div className="flex flex-col gap-1.5 pl-6 border-l-2 border-primary/30">
                <Label htmlFor="approver-ids">Allowed Approver Slack User IDs (Comma separated)</Label>
                <Input
                  id="approver-ids"
                  value={approverIds}
                  onChange={(e) => setApproverIds(e.target.value)}
                  placeholder="e.g. U01234567, U07654321"
                />
                <p className="text-[11px] text-muted-foreground">Only button clicks from these Slack User IDs will be processed.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleSaveRoute} disabled={savingRoute || !routeKey || !routeConnId || !channelId.trim()}>
              {savingRoute ? "Saving…" : "Save Route"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
