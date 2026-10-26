"use client";

import { useEffect, useRef } from "react";

export interface LiveEvent<P = Record<string, unknown>> {
  type: string;
  payload: P;
  ts: string;
}

// Subscribe to a filtered set of user-scoped SSE events. The EventSource is
// per-mount; closes on unmount or route change. Reconnects automatically via
// the browser's built-in backoff.
//
// Browser → /api/events hits same-origin through the Next.js rewrite, so the
// session cookie travels normally.
export function useLiveEvents(
  types: string[],
  onEvent: (e: LiveEvent) => void
): void {
  // Keep the latest handler in a ref so the EventSource doesn't tear down on
  // every re-render — otherwise the stream reopens on each parent re-paint.
  const handlerRef = useRef(onEvent);
  useEffect(() => { handlerRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    if (typeof window === "undefined" || !("EventSource" in window)) return;
    const es = new EventSource("/api/events");
    const listeners: Array<[string, (ev: MessageEvent) => void]> = [];
    for (const t of types) {
      const fn = (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data) as LiveEvent;
          handlerRef.current(parsed);
        } catch { /* ignore malformed */ }
      };
      es.addEventListener(t, fn);
      listeners.push([t, fn]);
    }
    return () => {
      for (const [t, fn] of listeners) es.removeEventListener(t, fn);
      es.close();
    };
    // types is treated as stable per mount — callers pass a static array literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join("|")]);
}
