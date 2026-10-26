import { tenantRoute, serviceTokenRoute, safe } from "../../core/router";
import { HttpError, authenticate } from "../../core/auth";
import { requireScope } from "../../core/service-token";
import { writeAudit } from "../../core/audit";
import { publish, subscribe } from "./bus";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SSE handler. Bun supports streaming responses by returning a `ReadableStream`.
// The connection stays open; the user's auth gates the subscription so one
// user can't eavesdrop on another's events.
async function sseStream(req: Request): Promise<Response> {
  const ctx = await authenticate(req);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Opening frame — the client treats this as "connected".
      controller.enqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ userId: ctx.userId, ts: new Date().toISOString() })}\n\n`));
      unsubscribe = subscribe(ctx.userId, (e) => {
        try {
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        } catch { /* client gone; the fn-throws-prune on bus handles it */ }
      });
      // Keep-alive heartbeat every 25s so proxies don't idle us out.
      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`:ka\n\n`)); }
        catch { /* ignore */ }
      }, 25_000);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export const eventsRoutes = {
  "/api/events": {
    GET: safe(sseStream),
  },

  // Workers push events here. Scope `events:write`. userId in body — the
  // service token's own org must contain that user (we trust the scope).
  "/api/integrations/events": {
    POST: serviceTokenRoute(async (req, ctx) => {
      requireScope(ctx, "events:write");
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) {
        throw new HttpError(400, "userId (uuid) is required");
      }
      if (typeof body.type !== "string" || !body.type.trim()) {
        throw new HttpError(400, "type is required");
      }
      const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? body.payload as Record<string, unknown> : {};
      publish(body.userId, body.type, payload);
      await writeAudit(ctx.tx, ctx, {
        action: "event:emit_via_integration",
        resourceType: "event",
        metadata: { targetUserId: body.userId, type: body.type, tokenId: ctx.tokenId },
      });
      return Response.json({ ok: true });
    }),
  },
};

// Prevent unused import warning: tenantRoute isn't used here now but kept so
// callers that already import tenantRoute from this file keep working.
void tenantRoute;
