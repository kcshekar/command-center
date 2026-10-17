"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { slackApi, type SlackConnection } from "@/lib/slack-api";
import { notificationsApi, type NotificationRoute } from "@/lib/notifications-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Bot, CheckCircle2, Plus, RefreshCw, Trash2, ShieldCheck, Zap, ToggleLeft, ToggleRight, Pencil } from "lucide-react";
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

  const [connections, setConnections] = useState<SlackConnection[]>([]);
  const [routes, setRoutes] = useState<NotificationRoute[]>([]);
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
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [channelType, setChannelType] = useState<"slack" | "in_app">("slack");
  const [routeKey, setRouteKey] = useState("reminders.due");
  const [routeConnId, setRouteConnId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [allowButtons, setAllowButtons] = useState(false);
  const [approverIds, setApproverIds] = useState("");
  const [savingRoute, setSavingRoute] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [conns, rts] = await Promise.all([
        slackApi.listConnections(),
        notificationsApi.listRoutes(),
      ]);
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
    setEditingRouteId(null);
    setChannelType("slack");
    setRouteKey("reminders.due");
    setRouteConnId(connections[0]?.id ?? "");
    setChannelId("");
    setChannelName("");
    setAllowButtons(false);
    setApproverIds("");
    setRouteOpen(true);
  }

  function openEditRoute(r: NotificationRoute) {
    setEditingRouteId(r.id);
    setChannelType((r.channel_type === "in_app" ? "in_app" : "slack"));
    setRouteKey(r.route_key);
    setRouteConnId(r.connection_id ?? "");
    setChannelId(r.channel_id ?? "");
    setChannelName(r.channel_name ?? "");
    setAllowButtons(r.allow_buttons);
    setApproverIds((r.allowed_approver_slack_ids ?? []).join(", "));
    setRouteOpen(true);
  }

  async function handleSaveRoute() {
    if (!routeKey.trim()) return;
    if (channelType === "slack" && (!routeConnId || !channelId.trim())) return;
    setSavingRoute(true);
    try {
      const idsArray = approverIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await notificationsApi.upsertRoute({
        routeKey: routeKey.trim(),
        channelType,
        connectionId: channelType === "slack" ? routeConnId : null,
        channelId: channelType === "slack" ? channelId.trim() : null,
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
      await notificationsApi.removeRoute(id);
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
                      <th className="p-3">Channel</th>
                      <th className="p-3">Destination</th>
                      <th className="p-3">Interactive Buttons</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {routes.map((r) => (
                      <tr key={r.id} className="hover:bg-muted/30">
                        <td className="p-3 font-mono font-medium text-foreground">{r.route_key}</td>
                        <td className="p-3">
                          <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                            {r.channel_type}
                          </Badge>
                        </td>
                        <td className="p-3 font-mono text-xs">
                          {r.channel_type === "in_app"
                            ? "— (in-app feed)"
                            : (r.channel_name ? `${r.channel_name} (${r.channel_id})` : r.channel_id) +
                              (r.connection_name ? ` · ${r.connection_name}` : "")}
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
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" onClick={() => openEditRoute(r)} aria-label="Edit route">
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteRoute(r.id)} aria-label="Delete route">
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
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
            <DialogTitle>{editingRouteId ? "Edit Route Mapping" : "Add Route Mapping"}</DialogTitle>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-4 py-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="route-key">System Route Key</Label>
              <select
                id="route-key"
                value={routeKey}
                onChange={(e) => setRouteKey(e.target.value)}
                disabled={!!editingRouteId}
                className="h-9 w-full min-w-0 rounded-md border bg-transparent px-3 text-sm disabled:opacity-60"
              >
                {PRESET_ROUTES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} — {p.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="channel-type">Channel</Label>
              <select
                id="channel-type"
                value={channelType}
                onChange={(e) => {
                  const next = e.target.value as "slack" | "in_app";
                  setChannelType(next);
                  // Switching to slack from in_app leaves routeConnId empty if the
                  // row stored null — default to the first connection so the
                  // dropdown's visible selection matches state and Save enables.
                  if (next === "slack" && !routeConnId && connections[0]) {
                    setRouteConnId(connections[0].id);
                  }
                }}
                disabled={!!editingRouteId}
                className="h-9 w-full min-w-0 rounded-md border bg-transparent px-3 text-sm disabled:opacity-60"
              >
                <option value="slack">Slack</option>
                <option value="in_app">In-app (CC notification feed)</option>
              </select>
              {editingRouteId && (
                <p className="text-[11px] text-muted-foreground">Channel is fixed once a route exists. Delete and recreate to change it.</p>
              )}
            </div>

            {channelType === "slack" && (
              <>
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
              </>
            )}

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

            {allowButtons && channelType === "slack" && (
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
            <Button
              onClick={handleSaveRoute}
              disabled={
                savingRoute ||
                !routeKey ||
                (channelType === "slack" && (!routeConnId || !channelId.trim()))
              }
            >
              {savingRoute ? "Saving…" : "Save Route"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
