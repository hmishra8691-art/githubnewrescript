"use client";
import React from "react";
import { SCORE_CAVEAT, describeOverall, type Scorecard as ScorecardData } from "@rescript/interviews";

/**
 * THE SCORECARD, AS A THING THAT OPENS.
 *
 * Every number on this card expands. Press a requirement and the quotes that
 * produced its verdict appear; a requirement with no quotes says what a
 * stronger answer would have contained — taken from the requirement's own
 * criteria, never invented. `SCORE_CAVEAT` is the first thing rendered, not a
 * footnote, because the reader who matters is the one who glances at the big
 * number and stops.
 *
 * Nothing here is a recommendation. That stays on the human review below it.
 */
export function Scorecard({ card, questionCodes }: {
  card: ScorecardData;
  /** responseId → question code, for the per-question rows */
  questionCodes: Record<string, string>;
}) {
  const [open, setOpen] = React.useState<string | null>(null);

  return (
    <section className="card" data-testid="scorecard">
      <p className="note" style={{ marginTop: 0 }}>{SCORE_CAVEAT}</p>

      <div className="row" style={{ gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <div className="tiny muted">Requirements with quoted evidence</div>
          <div style={{ fontSize: 40, fontWeight: 700, lineHeight: 1 }} data-testid="score-overall">
            {card.overall === null ? "—" : card.overall}
            {card.overall !== null && <span className="muted" style={{ fontSize: 16, fontWeight: 400 }}> / 100</span>}
          </div>
          <div className="tiny muted" style={{ marginTop: 4 }}>{describeOverall(card)}</div>
        </div>
        <div className="row" style={{ gap: 14 }}>
          <Stat n={card.coverage.met} say="with evidence" />
          <Stat n={card.coverage.partial} say="partly shown" />
          <Stat n={card.coverage.notDemonstrated} say="not found in the words" />
          {card.coverage.unscored > 0 && <Stat n={card.coverage.unscored} say="tracked, not scored" />}
        </div>
      </div>

      {card.categories.length > 1 && (
        <div style={{ marginTop: 16 }} data-testid="score-categories">
          {card.categories.map((c) => (
            <div key={c.category} className="row" style={{ gap: 10, alignItems: "center", marginTop: 6 }}>
              <span style={{ width: 150 }} className="small">{c.say}</span>
              <div className="bar" style={{ flex: 1 }}><i style={{ width: `${c.score ?? 0}%` }} /></div>
              <span className="small" style={{ width: 60, textAlign: "right" }}>{c.score === null ? "—" : `${c.score}`}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        {card.requirements.map((r) => (
          <div key={r.requirementId} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, marginTop: 8 }}
            data-testid="score-requirement" data-verdict={r.verdict}>
            <button type="button" className="row" style={{ gap: 10, width: "100%", background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", alignItems: "baseline" }}
              onClick={() => setOpen(open === r.requirementId ? null : r.requirementId)} aria-expanded={open === r.requirementId}>
              <strong><code>{r.code}</code></strong>
              <span style={{ flex: 1 }}>{r.title}</span>
              <span className={`pill ${r.verdict === "evidence" ? "ok" : r.verdict === "partial" ? "" : "warn"}`}>{r.say}</span>
              <span className="tiny muted" style={{ width: 70, textAlign: "right" }}>
                {r.weight === 0 ? "not scored" : `${r.points} · w${r.weight}`}
              </span>
            </button>
            {open === r.requirementId && (
              <div style={{ marginTop: 8, paddingLeft: 12 }} data-testid="score-expansion">
                {r.quotes.length > 0 ? r.quotes.map((q) => (
                  <blockquote key={q.evidenceId} style={{ margin: "6px 0", paddingLeft: 10, borderLeft: "3px solid var(--line)" }}>
                    &ldquo;{q.quote}&rdquo;
                    {q.responseId && questionCodes[q.responseId] && (
                      <span className="tiny muted"> — {questionCodes[q.responseId]}</span>
                    )}
                  </blockquote>
                )) : (
                  <p className="small muted" style={{ margin: 0 }}>
                    No passage could be quoted for this. The words were not found — that is what a zero means here.
                  </p>
                )}
                {r.wouldHaveShown && (
                  <p className="small" style={{ margin: "6px 0 0" }}>
                    <span className="muted">What meeting it looks like:</span> {r.wouldHaveShown}
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Stat({ n, say }: { n: number; say: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1 }}>{n}</div>
      <div className="tiny muted">{say}</div>
    </div>
  );
}
