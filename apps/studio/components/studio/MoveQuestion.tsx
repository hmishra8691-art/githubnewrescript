"use client";
import React from "react";
import { useStudio } from "./store";
import { listBlocks, listPages, blockSize } from "./blockModel";

/**
 * Move a question to any block, at a chosen position.
 *
 * The move is a MOVE, not a copy-and-recreate: the question object stays
 * exactly where it is in `definition.questions` and only its membership of a
 * page's `questionIds` changes. That is why id, code, variable name, text,
 * type, options, validation, display and skip logic, piping, randomisation
 * and every option-level setting survive it — none of them are touched, and
 * none of them live in the flow.
 *
 * The one thing a move CAN break is logic that depends on order: a question
 * cannot reference an answer that has not been asked yet. The dialog says so
 * when the move puts a question in front of something it reads.
 */
export function MoveQuestionModal({ qid, onClose }: { qid: string; onClose(): void }) {
  const s = useStudio();
  const q = s.def.questions.find((x) => x.id === qid);
  const blocks = listBlocks(s.def.flow as any[]);

  const currentPage = listPages(s.def.flow as any[]).find((p) => p.node.questionIds.includes(qid));
  const currentBlock = blocks.find((b) => b.pages.some((p) => p.node.id === currentPage?.node.id));

  const [blockId, setBlockId] = React.useState(currentBlock?.id ?? blocks[0]?.id ?? "");
  const target = blocks.find((b) => b.id === blockId);

  /**
   * "End of the block" has to mean the end of the BLOCK, which in a
   * paginated block is the end of its last page. Defaulting the page to 0
   * made the default action move a question backwards across a page break —
   * the opposite of what the option it was sitting on said.
   */
  const lastPage = Math.max((target?.pages.length ?? 1) - 1, 0);
  const [pageIdx, setPageIdx] = React.useState(lastPage);
  const page = target?.pages[Math.min(pageIdx, lastPage)];

  const [pos, setPos] = React.useState<number>(-1);

  React.useEffect(() => {
    const b = blocks.find((x) => x.id === blockId);
    setPageIdx(Math.max((b?.pages.length ?? 1) - 1, 0));
    setPos(-1);
  }, [blockId]);

  if (!q) return null;

  const siblings = (page?.node.questionIds ?? []).filter((x) => x !== qid);
  const label = (id: string) => {
    const other = s.def.questions.find((x) => x.id === id);
    if (!other) return id;
    const text = other.text.replace(/<[^>]*>/g, "").trim();
    return `${other.code}${text ? ` — ${text.slice(0, 46)}` : ""}`;
  };

  /**
   * Which questions this one reads. Piping and conditions are text and rules
   * over question ids/codes, so a shallow scan of the serialised question is
   * both accurate enough to warn on and immune to schema growth.
   */
  const referenced = React.useMemo(() => {
    // Two precise signals, and nothing looser. Matching a bare code anywhere
    // in the serialised question fired on an OPTION whose code happened to
    // equal another question's code, and `{{Q1` also matched `{{Q10}}`.
    const blob = JSON.stringify(q);
    const piped = new Set<string>();
    for (const m of `${q.text ?? ""} ${q.instruction ?? ""}`.matchAll(/\{\{\s*([A-Za-z0-9_]+)/g)) {
      piped.add(m[1]);
    }
    return s.def.questions.filter(
      (o) =>
        o.id !== q.id &&
        (blob.includes(`"${o.id}"`) || piped.has(o.code) || piped.has(o.variableName)),
    );
  }, [q, s.def.questions]);

  /** Order across the whole survey, so "after" means what a respondent sees. */
  const orderedIds = listPages(s.def.flow as any[]).flatMap((p) => p.node.questionIds);
  const landingIndex = () => {
    const before: string[] = [];
    for (const p of listPages(s.def.flow as any[])) {
      for (const id of p.node.questionIds) {
        if (id === qid) continue;
        if (p.node.id === page?.node.id) {
          const at = pos < 0 ? siblings.length : pos;
          if (siblings.indexOf(id) >= at) return before.length;
        }
        before.push(id);
      }
    }
    return before.length;
  };
  const wouldPrecede = React.useMemo(() => {
    if (referenced.length === 0) return [];
    const at = landingIndex();
    return referenced.filter((r) => {
      const ri = orderedIds.filter((x) => x !== qid).indexOf(r.id);
      return ri >= at;
    });
  }, [blockId, pageIdx, pos, referenced.length]);

  const doMove = () => {
    s.update((d) => {
      // 1. take it out of wherever it is
      for (const p of listPages(d.flow as any[])) {
        const k = p.node.questionIds.indexOf(qid);
        if (k >= 0) p.node.questionIds.splice(k, 1);
      }
      // 2. put it where it was asked for. The question object itself is never
      //    read, cloned or rewritten — only this list of ids changes.
      const b = listBlocks(d.flow as any[]).find((x) => x.id === blockId);
      const target = b?.pages[Math.min(pageIdx, b.pages.length - 1)];
      if (!target) return;
      const ids: string[] = target.node.questionIds;
      ids.splice(pos < 0 || pos > ids.length ? ids.length : pos, 0, qid);
    });
    s.toast(`${q.code} moved to ${target?.title || "the block"}`);
    onClose();
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal move-modal" role="dialog" aria-label="Move question" data-testid="move-question"
        onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px" }}>Move {q.code}</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          {q.text.replace(/<[^>]*>/g, "").slice(0, 90) || "(untitled question)"}
        </p>

        <div className="flabel">Move to block</div>
        <div className="move-list" data-testid="move-blocks">
          {blocks.map((b, i) => (
            <label key={b.id} className={`move-opt ${b.id === blockId ? "on" : ""}`}>
              <input type="radio" name="mv-block" checked={b.id === blockId}
                onChange={() => setBlockId(b.id)} />
              <span className="block-badge">BLOCK {i + 1}</span>
              <span className="grow">{b.title || <span className="muted">untitled</span>}</span>
              <span className="muted" style={{ fontSize: 11 }}>
                {blockSize(b)} q{b.pages.length > 1 ? ` · ${b.pages.length} pages` : ""}
                {b.id === currentBlock?.id ? " · current" : ""}
              </span>
            </label>
          ))}
        </div>

        {(target?.pages.length ?? 0) > 1 && (
          <>
            <div className="flabel" style={{ marginTop: 10 }}>Onto page</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {target!.pages.map((p, i) => (
                <button key={p.node.id} className={`btn small ${i === pageIdx ? "primary" : ""}`}
                  onClick={() => { setPageIdx(i); setPos(-1); }}>
                  Page {i + 1} ({p.node.questionIds.filter((x) => x !== qid).length})
                </button>
              ))}
            </div>
          </>
        )}

        <div className="flabel" style={{ marginTop: 10 }}>Position</div>
        <div className="move-list" data-testid="move-positions">
          <label className={`move-opt ${pos === 0 ? "on" : ""}`}>
            <input type="radio" name="mv-pos" checked={pos === 0} onChange={() => setPos(0)} />
            <span>Beginning of the page</span>
          </label>
          {siblings.map((id, i) => (
            <label key={id} className={`move-opt ${pos === i + 1 ? "on" : ""}`}>
              <input type="radio" name="mv-pos" checked={pos === i + 1} onChange={() => setPos(i + 1)} />
              <span>After <span className="mono">{label(id)}</span></span>
            </label>
          ))}
          <label className={`move-opt ${pos === -1 && pageIdx === lastPage ? "on" : ""}`}>
            <input type="radio" name="mv-pos" checked={pos === -1 && pageIdx === lastPage}
              onChange={() => { setPageIdx(lastPage); setPos(-1); }} />
            <span>End of the block{(target?.pages.length ?? 1) > 1 ? ` (page ${lastPage + 1})` : ""}</span>
          </label>
        </div>

        {wouldPrecede.length > 0 && (
          <div className="chip warn" style={{ display: "block", marginTop: 12, padding: "7px 10px", whiteSpace: "normal" }}>
            <strong>{q.code} reads {wouldPrecede.map((r) => r.code).join(", ")}</strong>, which
            would now be asked after it. Piping and conditions on a question that has not been
            answered yet resolve to nothing — move it earlier, or move those first.
          </div>
        )}

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" data-testid="do-move" onClick={doMove}>Move question</button>
        </div>
      </div>
    </div>
  );
}
