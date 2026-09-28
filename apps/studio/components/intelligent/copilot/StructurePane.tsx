"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { listBlocks, typeLabel, type SurveyDiff } from "@rescript/engine";
import { plainText } from "../../../lib/copilot/client";

/**
 * THE SURVEY, ON THE LEFT OF THE COPILOT WORKSPACE (the copilot brief §17):
 * blocks and their questions — code, text, type, and whether a question has
 * logic — with what the open proposal would add, change or remove marked,
 * so the conversation always has the real survey beside it. A click selects
 * the question, which the Inspector and the other modes follow.
 */
export function StructurePane({ def, diff, selectedId, onSelect }: { def: SurveyDefinition; diff: SurveyDiff | null; selectedId: string | null; onSelect(id: string): void }) {
  const blocks = React.useMemo(() => listBlocks(def.flow as unknown[]), [def]);
  const modified = new Set(diff?.questionsModified.map((q) => q.id));
  const removed = new Set(diff?.questionsRemoved.map((q) => q.id));
  const q = (id: string) => def.questions.find((x) => x.id === id);
  const placed = new Set(blocks.flatMap((b) => b.pages.flatMap((p) => p.node.questionIds)));
  const loose = def.questions.filter((x) => !placed.has(x.id));
  return (
    <nav className="cp-structure-pane" data-testid="cp-structure-pane" aria-label="Survey structure">
      <div className="ar-pane-head"><span className="ar-pane-title">Survey</span><span className="iqi-dim" data-testid="cp-sp-count">{def.questions.length} questions{diff && !diff.empty ? " · proposed" : ""}</span></div>
      <div className="cp-sp-body">
        {blocks.length === 0 && <p className="cp-empty">The survey is empty. Tell the copilot what you want to research, and it will propose the structure.</p>}
        {blocks.map((b) => (
          <div key={b.id} className="cp-sp-block">
            <div className="cp-sp-title">{b.title ?? "Untitled block"}</div>
            {b.pages.map((p, pi) => (
              <div key={p.node.id} className={`cp-sp-page${pi > 0 ? " break" : ""}`}>
                {p.node.questionIds.map((id) => {
                  const x = q(id); if (!x) return null;
                  const mark = removed.has(id) ? "removed" : modified.has(id) ? "modified" : undefined;
                  return (
                    <button key={id} type="button" className={`cp-sp-q${selectedId === id ? " sel" : ""}${mark ? ` m-${mark}` : ""}`} onClick={() => onSelect(id)} data-testid="cp-sp-q" data-code={x.code} data-mark={mark ?? ""} title={`${x.code} · ${typeLabel(x)}${x.required ? " · required" : ""}`}>
                      <span className="mono cp-sp-code">{x.code}</span>
                      <span className="cp-sp-text">{plainText(x.text ?? "") || "(no text)"}</span>
                      {(x.displayLogic || x.skipLogic?.length) ? <span className="cp-sp-logic" title="has logic">⤳</span> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
        {loose.length > 0 && <div className="cp-sp-block"><div className="cp-sp-title">Not on any page</div>{loose.map((x) => <button key={x.id} type="button" className="cp-sp-q" onClick={() => onSelect(x.id)}><span className="mono cp-sp-code">{x.code}</span><span className="cp-sp-text">{x.text}</span></button>)}</div>}
        {diff && diff.questionsAdded.length > 0 && <p className="cp-sp-note" data-testid="cp-sp-pending">+ {diff.questionsAdded.length} question{diff.questionsAdded.length === 1 ? "" : "s"} proposed — see Changes</p>}
      </div>
    </nav>
  );
}
