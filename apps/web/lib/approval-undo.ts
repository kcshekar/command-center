import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api";
import { notificationsApi, type InAppNotification } from "@/lib/notifications-api";
import { firstLine } from "@/lib/slack-text";

export const UNDO_MS = 5000;

// Approve/reject with a 5s Undo window. Approving can trash email or send a
// reply, and the Inbox approves on a single "A" keypress, so nothing is sent
// until the toast runs out. Callers hide the row in onHold and show it again
// in onUndone; onSent fires once the decision reached CC.
// ponytail: the pending decision lives in this tab — closing it within 5s
// drops the decision and the approval simply stays pending (safe direction).
export function decideWithUndo(
  n: InAppNotification,
  decision: "approved" | "rejected",
  hooks: { onHold: () => void; onUndone: () => void; onSent: () => void },
) {
  let undone = false;
  hooks.onHold();
  toast(`${decision === "approved" ? "Approving" : "Rejecting"}: ${firstLine(n.text, "approval")}`, {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => {
        undone = true;
        hooks.onUndone();
      },
    },
  });
  setTimeout(async () => {
    if (undone) return;
    try {
      await notificationsApi.respond(n.id, decision);
      hooks.onSent();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not send your decision"));
      hooks.onUndone();
    }
  }, UNDO_MS);
}
