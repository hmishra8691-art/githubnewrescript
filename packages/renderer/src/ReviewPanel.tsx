"use client";
import React from "react";
import type { ReviewGroup } from "@rescript/engine";

/**
 * S5a item 5 — REVIEW YOUR ANSWERS (audit AQ-12), drawn on a page whose flow node has `review` set. The groups come
 * from the engine (`reviewSummary`: visited pages before this one, by section, hidden questions never listed, long
 * text already cut). Each section is a region with its heading; each answer is a definition-list pair, and "Change"
 * is a real button whose name says which question it changes. The Runner does the jump (goToPage — visited pages
 * only) and offers "Return to review" on the page it lands on.
 */
export function ReviewPanel({ title, groups, onChange, note }: { title: string; groups: ReviewGroup[]; onChange(pageId: string, questionId: string): void; note?: string | null }) {
  const headId = React.useId();
  return (
    <section className="rs-review" aria-labelledby={headId} data-testid="rs-review">
      <h2 id={headId} className="rs-review-title">{title}</h2>
      {note && <div className="rs-media-note" role="status" data-testid="rs-review-note">{note}</div>}
      {!groups.length && <p className="rs-review-empty" data-testid="rs-review-empty">There are no answers to review yet.</p>}
      {groups.map((g) => (
        <section key={g.id} className="rs-review-group" aria-label={g.title} data-testid="rs-review-group">
          <h3 className="rs-review-section">{g.title}</h3>
          <dl className="rs-review-list">
            {g.items.map((it) => (
              <div key={`${it.pageId}:${it.questionId}`} className="rs-review-item" data-testid="rs-review-item" data-qid={it.questionId}>
                <dt className="rs-review-q">{it.text}</dt>
                <dd className="rs-review-a">
                  <span data-testid="rs-review-answer" title={it.truncated ? "Shortened — open Change to see all of it" : undefined}>{it.answer}</span>
                  <button type="button" className="rs-btn secondary rs-review-change" data-testid="rs-review-change"
                    aria-label={`Change your answer to: ${it.text}`} onClick={() => onChange(it.pageId, it.questionId)}>Change</button>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </section>
  );
}
