"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";

type PageNode = Extract<FlowNode, { type: "page" }>;
type Review = NonNullable<PageNode["review"]>;

/**
 * S5a (AQ-12): make a flow page a REVIEW-YOUR-ANSWERS page — it lists the answers given so far (visited pages before
 * it), by section, with "Change" links back and "Return to review". Hidden questions are never listed; open-end text
 * is cut at the limit. IM: set_review_page.
 */
export function ReviewPageEditor({ node, onChange, testId }: { node: PageNode; onChange(n: FlowNode): void; testId: string }) {
  const r = node.review;
  const on = !!r && r.enabled !== false;
  const set = (p: Partial<Review> | null) => onChange({ ...node, review: p === null ? undefined : { enabled: true, ...(r ?? {}), ...p } } as FlowNode);
  return (
    <div className="card" style={{ padding: 10, marginTop: 6 }} data-testid={testId}>
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={on} data-testid={`${testId}-on`} onChange={(e) => set(e.target.checked ? { enabled: true } : null)} />
        Review page — list the answers so far with “Change” links
      </label>
      {on && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center", marginTop: 6 }}>
          <span className="flabel">Heading</span>
          <input className="input" data-testid={`${testId}-title`} placeholder="Review your answers" value={r?.title ?? ""} onChange={(e) => set({ title: e.target.value || undefined })} />
          <span className="flabel">Cut long text at (characters)</span>
          <input className="input" type="number" min={20} max={2000} style={{ width: 100 }} data-testid={`${testId}-limit`} value={r?.textLimit ?? 200}
            onChange={(e) => set({ textLimit: Math.max(20, Math.min(2000, Math.round(Number(e.target.value)) || 200)) })} />
        </div>
      )}
      {on && node.questionIds.length === 0 && <div className="muted" style={{ fontSize: 12.5, color: "var(--warn, #b45309)" }}>Add a text block to this page — an empty page is not shown.</div>}
    </div>
  );
}
