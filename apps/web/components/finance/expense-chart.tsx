"use client";

import { useMemo, useState } from "react";
import type { ExpenseSummaryRow } from "@/lib/finance-api";
import { formatCents } from "@/lib/finance-api";

// Validated dark-mode categorical order from the dataviz skill's reference
// palette — fixed order, never cycled/reassigned. This app is dark-only
// (no light/dark toggle), so the dark column is used directly.
const CATEGORICAL_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const MUTED = "#898781";
const BASELINE = "#383835";

export function ExpenseChart({ rows }: { rows: ExpenseSummaryRow[] }) {
  const [showTable, setShowTable] = useState(false);

  const months = useMemo(() => Array.from(new Set(rows.map((r) => r.month))).sort(), [rows]);
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows) if (!seen.includes(r.category)) seen.push(r.category);
    return seen;
  }, [rows]);

  // Cap at 8 categorical slots (the palette's validated set); beyond that,
  // fold into "Other" rather than generating an unvalidated 9th hue.
  const cappedCategories = categories.slice(0, 8);
  const hasOverflow = categories.length > 8;
  const displayCategories = hasOverflow ? [...cappedCategories, "Other"] : cappedCategories;

  function colorFor(category: string): string {
    if (category === "Other") return MUTED;
    const idx = cappedCategories.indexOf(category);
    return idx === -1 ? MUTED : CATEGORICAL_DARK[idx];
  }

  const byMonth = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const key = cappedCategories.includes(r.category) ? r.category : "Other";
      if (!map.has(r.month)) map.set(r.month, new Map());
      const m = map.get(r.month)!;
      m.set(key, (m.get(key) ?? 0) + Number(r.total_cents));
    }
    return map;
  }, [rows, cappedCategories]);

  const maxTotal = Math.max(
    1,
    ...months.map((m) => Array.from((byMonth.get(m) ?? new Map()).values()).reduce((a, b) => a + b, 0))
  );

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No expense data yet.</p>;
  }

  const chartHeight = 200;
  const barWidth = 40;
  const gap = 28;
  const width = Math.max(280, months.length * (barWidth + gap));

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <svg width={width} height={chartHeight + 32} role="img" aria-label="Monthly expenses by category">
          <line x1={0} y1={chartHeight} x2={width} y2={chartHeight} stroke={BASELINE} strokeWidth={1} />
          {months.map((month, mi) => {
            const catMap = byMonth.get(month) ?? new Map();
            let yOffset = chartHeight;
            const x = mi * (barWidth + gap) + gap / 2;
            return (
              <g key={month}>
                {displayCategories.map((cat) => {
                  const val = catMap.get(cat) ?? 0;
                  if (val === 0) return null;
                  const segHeight = (val / maxTotal) * chartHeight;
                  yOffset -= segHeight;
                  return (
                    <rect key={cat} x={x} y={yOffset} width={barWidth} height={Math.max(0, segHeight - 2)} rx={2} fill={colorFor(cat)}>
                      <title>{`${cat}: ${formatCents(val)} — ${month}`}</title>
                    </rect>
                  );
                })}
                <text x={x + barWidth / 2} y={chartHeight + 18} textAnchor="middle" fontSize={11} fill={MUTED}>
                  {month}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap gap-3">
        {displayCategories.map((cat) => (
          <div key={cat} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: colorFor(cat) }} />
            {cat}
          </div>
        ))}
      </div>

      <button type="button" className="w-fit text-xs text-muted-foreground underline" onClick={() => setShowTable((s) => !s)}>
        {showTable ? "Hide table view" : "View as table"}
      </button>

      {showTable && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-normal">Month</th>
              <th className="py-1 font-normal">Category</th>
              <th className="py-1 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="py-1">{r.month}</td>
                <td className="py-1">{r.category}</td>
                <td className="py-1 text-right">{formatCents(r.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
