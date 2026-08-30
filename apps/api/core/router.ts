import type { SQL } from "bun";
import { authenticate, HttpError, type AuthCtx } from "./auth";
import { withTenantTx } from "./db";
import { checkRateLimit } from "./rate-limit";
import { log } from "./log";

// Wraps a route handler so any thrown HttpError (401/403/etc) becomes the
// right response, and every module route gets this for free instead of
// repeating try/catch.
export function safe(handler: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error("unhandled route error", {
        method: req.method,
        path: new URL(req.url).pathname,
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Short diagnostic instead of a bare "internal error" — this is an
      // internal admin/employee tool, not a public API, so surfacing e.g.
      // "getaddrinfo ENOTFOUND smtp.example.com" beats an opaque 500 that
      // sends the user straight to the server logs for something they could
      // have fixed themselves (bad env var, unreachable host, etc).
      return Response.json({ error: message.slice(0, 300) || "internal error" }, { status: 500 });
    }
  };
}

// Every authenticated, tenant-scoped route (i.e. every module route) is
// authenticate -> open a tenant tx -> run handler -> error-map. This is that,
// so modules just write the business logic. `req.params` (Bun's path params)
// passes through untyped since Bun injects it at runtime per-route.
export function tenantRoute(
  handler: (req: Request & { params: Record<string, string> }, ctx: AuthCtx & { tx: SQL }) => Promise<Response>
) {
  return safe(async (req: Request) => {
    const ctx = await authenticate(req);
    return withTenantTx(ctx, (tx) => handler(req as any, { ...ctx, tx }));
  });
}

// Wraps a tenantRoute handler with a per-user rate limit, keyed by action
// name — for endpoints where abuse means "a stolen session scripting mass
// reveals," not just raw traffic volume. Composes on top of tenantRoute
// rather than replacing it, so modules keep writing plain business logic.
export function rateLimited(action: string, limit: number, windowSeconds: number) {
  return function (
    handler: (req: Request & { params: Record<string, string> }, ctx: AuthCtx & { tx: SQL }) => Promise<Response>
  ) {
    return tenantRoute(async (req, ctx) => {
      const rl = await checkRateLimit({ key: `${action}:${ctx.userId}`, limit, windowSeconds });
      if (!rl.allowed) {
        throw new HttpError(429, `Rate limit exceeded, try again in ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s)`);
      }
      return handler(req, ctx);
    });
  };
}
