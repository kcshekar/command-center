// In-process pub/sub for user-scoped SSE. Scales to the single CC node we run
// today; if we ever shard CC we'd swap this for Redis pub/sub or a KeyDB
// stream, same shape at the call sites.
//
// Subscribers are per-userId. publish fans out to every open controller for
// that user; a controller that throws is pruned (stale socket).

export interface AppEvent {
  type: string;                 // e.g. "workflow:completed"
  payload: Record<string, unknown>;
  ts: string;                   // ISO
}

type Subscriber = (e: AppEvent) => void;

const subs = new Map<string, Set<Subscriber>>();

export function subscribe(userId: string, fn: Subscriber): () => void {
  let set = subs.get(userId);
  if (!set) { set = new Set(); subs.set(userId, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subs.delete(userId);
  };
}

export function publish(userId: string, type: string, payload: Record<string, unknown>): void {
  const set = subs.get(userId);
  if (!set) return;
  const e: AppEvent = { type, payload, ts: new Date().toISOString() };
  for (const fn of [...set]) {
    try { fn(e); } catch { set.delete(fn); }
  }
}

export function subscriberCount(userId: string): number {
  return subs.get(userId)?.size ?? 0;
}
