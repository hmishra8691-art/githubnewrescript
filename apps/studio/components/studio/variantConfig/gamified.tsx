"use client";
import React from "react";
import { registerOptionMetaFields, registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the gamified family.
 *
 *   quiz      per-option "correct" + "explanation", and the feedback switch
 *   timed     the clock and what running out of it does
 *   matching  the answer key — one row of the grid per prompt. Rows carry
 *             `meta`, but the option editor has no row-meta column, so the
 *             key gets its own small table here rather than a JSON field.
 */

registerOptionMetaFields("quiz", [
  { key: "correct", label: "correct", kind: "check" },
  { key: "explanation", label: "explanation", placeholder: "why this is right/wrong", width: 190 },
]);

registerVariantSettings("quiz", ({ q, patchSettings }) => {
  const keyed = q.options.filter((o) => o.meta?.correct).length;
  return (
    <>
      <h3 className="sec">Quiz</h3>
      <label className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox" data-testid="quiz-feedback"
          checked={q.settings.showFeedback !== false}
          onChange={(e) => patchSettings({ showFeedback: e.target.checked })} />
        <span>Show right / wrong immediately (locks the answer)</span>
      </label>
      <label className="f">
        <span>Points per correct answer</span>
        <CountInput data-testid="quiz-points" min={0}
          value={q.settings.pointsPerCorrect}
          onChange={(v) => patchSettings({ pointsPerCorrect: v })} />
      </label>
      <div className={keyed === 0 ? "chip warn" : "chip on"} data-testid="quiz-keycount">
        {keyed === 0
          ? "No option is marked correct — tick “correct” on the right answer above."
          : `${keyed} option${keyed === 1 ? "" : "s"} marked correct`}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Exports the chosen code plus <span className="mono">{q.variableName}_CORRECT</span> (1/0).
      </div>
    </>
  );
});

registerVariantSettings("timed", ({ q, patchSettings }) => (
  <>
    <h3 className="sec">Timer</h3>
    <div className="row">
      <label className="f" style={{ marginBottom: 0 }}>
        <span>Seconds allowed</span>
        <CountInput data-testid="timed-limit" min={1}
          value={q.settings.timeLimitSeconds}
          onChange={(v) => patchSettings({ timeLimitSeconds: v })} />
      </label>
      <label className="f grow" style={{ marginBottom: 0 }}>
        <span>When the time runs out</span>
        <select className="select" data-testid="timed-ontimeout"
          value={q.settings.onTimeout ?? "lock"}
          onChange={(e) => patchSettings({ onTimeout: e.target.value as "lock" | "advance" })}>
          <option value="lock">Lock the options and say “time’s up”</option>
          <option value="advance">Record no answer and move on</option>
        </select>
      </label>
    </div>
    {(q.settings.onTimeout ?? "lock") === "advance" && q.required && (
      <div className="chip warn" data-testid="timed-required-warn" style={{ marginTop: 8 }}>
        “Move on” leaves no answer, so a REQUIRED timed question would refuse to
        advance. Untick Required, or keep the timeout on “lock”.
      </div>
    )}
    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
      Exports <span className="mono">{q.variableName}_RT</span> (milliseconds from
      the question appearing to the answer) and <span className="mono">{q.variableName}_TIMEOUT</span>.
    </div>
  </>
));

registerVariantSettings("matching", ({ q, patch, patchSettings }) => {
  const setRowAnswer = (rowCode: string, code: string) =>
    patch({
      rows: q.rows.map((r) =>
        String(r.code) !== rowCode
          ? r
          : {
            ...r,
            meta: (() => {
              const meta = { ...(r.meta ?? {}) };
              if (code === "") delete meta.answer; else meta.answer = code;
              return Object.keys(meta).length ? meta : undefined;
            })(),
          },
      ),
    });
  const keyed = q.rows.filter((r) => r.meta?.answer != null && r.meta.answer !== "").length;

  return (
    <>
      <h3 className="sec">Matching</h3>
      <label className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox" data-testid="matching-feedback"
          checked={q.settings.showFeedback !== false}
          onChange={(e) => patchSettings({ showFeedback: e.target.checked })} />
        <span>Score the pairs once all are made</span>
      </label>

      <div className="flabel">Answer key</div>
      {q.rows.length === 0 || q.options.length === 0 ? (
        <div className="chip warn" data-testid="matching-needs">
          Add rows (the prompts) and options (the answers) first.
        </div>
      ) : (
        <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
          <tbody>
            {q.rows.map((r) => (
              <tr key={String(r.code)}>
                <td style={{ padding: "3px 6px 3px 0", maxWidth: 160, overflowWrap: "anywhere" }}>
                  {r.label.replace(/<[^>]*>/g, "") || String(r.code)}
                </td>
                <td style={{ padding: "3px 0" }}>
                  <select className="select" data-testid={`matching-answer-${r.code}`}
                    value={r.meta?.answer == null ? "" : String(r.meta.answer)}
                    onChange={(e) => setRowAnswer(String(r.code), e.target.value)}>
                    <option value="">— no correct answer —</option>
                    {q.options.map((o) => (
                      <option key={String(o.code)} value={String(o.code)}>
                        {o.label.replace(/<[^>]*>/g, "")}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        {keyed === 0
          ? "With no key the task is a free pairing exercise — nothing is scored."
          : `${keyed} of ${q.rows.length} prompts keyed; exports ${q.variableName}_CORRECT (pairs right).`}
      </div>
    </>
  );
});
