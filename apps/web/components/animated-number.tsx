"use client";

import { useEffect, useRef, useState } from "react";

// Counts up/down to `value` whenever it changes, instead of snapping —
// the big-number treatment used across the KPI tiles (Finance overview,
// project totals, payroll summaries).
export function AnimatedNumber({ value, format, duration = 600 }: { value: number; format: (n: number) => string; duration?: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return <>{format(display)}</>;
}
