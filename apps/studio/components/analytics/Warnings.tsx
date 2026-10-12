"use client";
import React from "react";

/**
 * The caveats on a result. A long list used to be stacked above the numbers
 * until it read as the result itself. The first few stay visible — they are the
 * ones that change how the numbers are read — and the rest sit behind one
 * line. The numbers are never replaced by a warning.
 */
export function Warnings({ items, testId = "ax-warnings", show = 3 }: { items: string[]; testId?: string; show?: number }) {
  const unique = [...new Set(items)];
  if (!unique.length) return null;
  const head = unique.slice(0, show), rest = unique.slice(show);
  return (
    <div className="ax-warnings" data-testid={testId}>
      {head.map((w, i) => <div key={i}>⚠ {w}</div>)}
      {rest.length > 0 && <details data-testid={`${testId}-more`}><summary>{rest.length} more note{rest.length === 1 ? "" : "s"}</summary>{rest.map((w, i) => <div key={i}>⚠ {w}</div>)}</details>}
    </div>
  );
}
