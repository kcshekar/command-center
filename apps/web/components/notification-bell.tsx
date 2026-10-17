"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notificationsApi, type InAppNotification } from "@/lib/notifications-api";
import { apiErrorMessage } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const POLL_MS = 20_000;

export function NotificationBell() {
  const [items, setItems] = useState<InAppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [responding, setResponding] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await notificationsApi.listInApp(false));
    } catch {
      // silent — polling shouldn't noisy-toast
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const unreadCount = items.filter((n) => !n.read_at).length;
  const pendingApprovals = items.filter((n) => n.is_approval && !n.approval_state);

  async function handleOpen(next: boolean) {
    setOpen(next);
    if (next && unreadCount > 0) {
      // Mark non-approval unread as read on open. Pending approvals stay unread
      // until the user actually decides.
      const toMark = items.filter((n) => !n.read_at && !(n.is_approval && !n.approval_state));
      await Promise.all(toMark.map((n) => notificationsApi.markRead(n.id).catch(() => {})));
      void refresh();
    }
  }

  async function respond(n: InAppNotification, decision: "approved" | "rejected") {
    setResponding(n.id);
    try {
      await notificationsApi.respond(n.id, decision);
      toast.success(decision === "approved" ? "Approved" : "Rejected");
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Failed to send decision"));
    } finally {
      setResponding(null);
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpen}>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
            <Bell className="size-4" />
            {unreadCount > 0 && (
              <Badge
                variant={pendingApprovals.length > 0 ? "destructive" : "default"}
                className="absolute -right-1 -top-1 size-4 min-w-4 justify-center p-0 text-[10px]"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </Badge>
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80 max-h-[70vh] overflow-y-auto">
        {items.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No notifications yet.</div>
        ) : (
          <ul className="divide-y">
            {items.map((n) => (
              <li
                key={n.id}
                className={cn(
                  "flex flex-col gap-1 p-3",
                  !n.read_at && "bg-muted/40"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-mono text-muted-foreground">{n.route_key}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(n.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-snug">{n.text}</p>
                {n.is_approval && !n.approval_state && (
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="gap-1 h-7"
                      disabled={responding === n.id}
                      onClick={() => respond(n, "approved")}
                    >
                      <Check className="size-3" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 h-7"
                      disabled={responding === n.id}
                      onClick={() => respond(n, "rejected")}
                    >
                      <X className="size-3" /> Reject
                    </Button>
                  </div>
                )}
                {n.approval_state && (
                  <Badge
                    variant={n.approval_state === "approved" ? "default" : "destructive"}
                    className="w-fit text-[10px]"
                  >
                    {n.approval_state === "approved" ? "✓ Approved" : "✗ Rejected"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
