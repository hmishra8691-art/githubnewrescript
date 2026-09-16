"use client";
import * as React from "react";
import { VERDICTS, VERDICT_SAY, VERDICT_MEANS, type Verdict } from "@rescript/interviews";

/**
 * WHAT A PERSON THINKS, RECORDED SEPARATELY FROM WHAT THE MODEL SAID.
 *
 * Deliberately below the analysis and visually apart from it. A reviewer
 * should be able to read the machine's reading and then disagree with it, and
 * a form that sits inside the analysis card invites agreeing with it by
 * default — which is the failure mode of every "AI-assisted" review screen.
 *
 * The verdicts are the SAME three the analysis uses, so agreement and
 * disagreement are directly comparable rather than needing translation. What
 * is different is the recommendation: the analysis has none and may not have
 * one, because recommending a decision about a person is a thing only a person
 * does here.
 */

export interface ReviewRequirement {
  id: string;
  code: string;
  title: string;
  /** what the analysis concluded, for comparison — never pre-filled into the answer */
  analysisVerdict?: Verdict | null;
}

export function ReviewPanel({
  interviewId, requirements, initial,
}: {
  interviewId: string;
  requirements: ReviewRequirement[];
  initial: {
    status: string;
    assessments: Record<string, string>;
    notes: string;
    recommendation: string | null;
  } | null;
}) {
  const [assessments, setAssessments] = React.useState<Record<string, string>>(initial?.assessments ?? {});
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [recommendation, setRecommendation] = React.useState(initial?.recommendation ?? "");
  const [saved, setSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const save = async (complete: boolean) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/interviews/${interviewId}/review`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assessments, notes,
          recommendation: recommendation || null,
          status: complete ? "complete" : "in_progress",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) setError(data.error ?? "That review could not be saved.");
      else setSaved(complete ? "Review complete." : "Saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ marginTop: 16 }} data-testid="review-panel">
      <h2 style={{ marginTop: 0 }}>Your review</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Your own assessment, kept separately from the automated reading. Disagreeing with it is a
        useful thing to record.
      </p>

      {requirements.map((r) => (
        <div key={r.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <strong>{r.code}</strong>
            <span>{r.title}</span>
            {r.analysisVerdict && (
              <span className="muted small">automated reading: {VERDICT_SAY[r.analysisVerdict]}</span>
            )}
          </div>
          <div className="row" style={{ gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            {VERDICTS.map((v) => (
              <label key={v} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <input
                  type="radio"
                  name={`req-${r.id}`}
                  checked={assessments[r.id] === v}
                  onChange={() => setAssessments((prev) => ({ ...prev, [r.id]: v }))}
                />
                <span title={VERDICT_MEANS[v]}>{VERDICT_SAY[v]}</span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 14 }}>
        <label className="small">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          data-testid="review-notes"
          style={{ display: "block", width: "100%", marginTop: 4 }}
        />
      </div>

      <div style={{ marginTop: 14 }}>
        <label className="small">Recommendation</label>
        <div className="row" style={{ gap: 12, marginTop: 4 }}>
          {(["advance", "hold", "decline"] as const).map((r) => (
            <label key={r} style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <input
                type="radio" name="recommendation"
                checked={recommendation === r}
                onChange={() => setRecommendation(r)}
              />
              <span style={{ textTransform: "capitalize" }}>{r}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 10, marginTop: 16, alignItems: "center" }}>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => save(false)}
          data-testid="review-save">
          Save draft
        </button>
        <button type="button" className="btn" disabled={busy || !recommendation} onClick={() => save(true)}
          data-testid="review-complete">
          Mark complete
        </button>
        {!recommendation && (
          <span className="muted small">Choose a recommendation to finish.</span>
        )}
        {saved && <span className="muted small">{saved}</span>}
      </div>

      {error && <p className="note warn" style={{ marginTop: 10 }}>{error}</p>}
    </section>
  );
}
