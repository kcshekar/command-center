export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// The server now sends a short, specific reason instead of a bare "internal
// error" (see apps/api/core/router.ts) — use it in toasts instead of a
// generic hardcoded string wherever the underlying cause is worth showing.
export function apiErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export async function apiFetch<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts.headers },
  });
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(res.status, (body as any)?.error ?? res.statusText);
  return body as T;
}
