"use client";
/**
 * THE INTELLIGENT IMPORT, AS A PERSON SEES IT (2026-11-13).
 *
 *   Scan → Understand → Analyze → Clarify → Program → Validate → Test → Final report
 *
 * One strip of stages (each with what it found, in a sentence), what the file was understood to be, the questions
 * the importer has for the person — in plain words, with why it is asking, the document's own words, the choices,
 * a recommendation where there is one, and room for the person's own answer — and the final report: completed,
 * pending, unresolved. Answering a question re-runs the import on the server with every answer so far; nothing
 * is re-uploaded and the rest of the survey is already programmed while a question waits.
 *
 * Data only: the shape is `IntelligenceView` (packages/import intelligence/pipeline.ts).
 */
import React from "react";
import type { IntelligenceView, ClarificationAnswer } from "@rescript/import";

const STATE_WORD: Record<string, string> = { done: "Done", attention: "Look", waiting: "Waiting for you", failed: "Failed", skipped: "Not run" };
const VERDICT_WORD: Record<string, string> = { passed: "Passed", passed_with_pending: "Passed — items pending", waiting_for_answers: "Waiting for your answers", checks_failed: "Checks did not pass" };

export function ImportIntelligence({ data, busy, canAnswer, onAnswer }: {
  data: IntelligenceView;
  busy?: boolean;
  /** false when the import has no stored session (answers cannot be applied in place) */
  canAnswer: boolean;
  onAnswer(answers: ClarificationAnswer[]): void;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [picks, setPicks] = React.useState<Record<string, number>>({});
  const [own, setOwn] = React.useState<Record<string, string>>({});
  const [show, setShow] = React.useState<"understood" | "report" | null>(null);
  const u = data.understanding;
  const waiting = data.clarifications.filter((c) => !c.answered);
  const answered = data.clarifications.filter((c) => c.answered);
  const ready: ClarificationAnswer[] = waiting.flatMap((c): ClarificationAnswer[] => (own[c.id]?.trim() ? [{ id: c.id, own: own[c.id].trim() }] : picks[c.id] !== undefined ? [{ id: c.id, choice: picks[c.id] }] : []));
  const f = data.final;

  return (
    <div className="iqx" data-testid="iqx">
      <ol className="iqx-stages" data-testid="iqx-stages" aria-label="Import stages">
        {data.stages.map((st, i) => (
          <li key={st.id} className={`iqx-stage is-${st.state}`} data-testid="iqx-stage" data-stage={st.id} data-state={st.state}>
            <button type="button" className="iqx-stage-head" aria-expanded={open === st.id} onClick={() => setOpen(open === st.id ? null : st.id)}>
              <span className="iqx-stage-n" aria-hidden="true">{i + 1}</span>
              <span className="iqx-stage-title">{st.title}</span>
              <span className="iqx-stage-state">{STATE_WORD[st.state] ?? st.state}</span>
            </button>
            <p className="iqx-stage-sum">{st.summary}</p>
            {open === st.id && (
              <div className="iqx-stage-more">
                <p className="iqi-dim">{st.engine}</p>
                {st.facts.length ? <ul>{st.facts.map((x, k) => <li key={k}>{x}</li>)}</ul> : <p className="iqi-dim">Nothing more to show for this stage.</p>}
              </div>
            )}
          </li>
        ))}
      </ol>

      {waiting.length > 0 && (
        <div className="iqx-asks" data-testid="iqx-asks">
          <p className="iqx-h"><b>{waiting.length} question{waiting.length === 1 ? "" : "s"} for you</b> <span className="iqi-dim">— everything else is already programmed and tested. Answer any of them; the survey is updated and re-tested each time.</span></p>
          <ol>
            {waiting.map((c) => (
              <li key={c.id} data-testid="iqx-ask" data-about={c.about}>
                <p className="iqx-ask-found">{c.found}</p>
                <p className="iqx-ask-why"><b>Why I'm asking:</b> {c.why}</p>
                {c.quote && <p className="iqx-ask-quote">In the document, at {c.where}: <q>{c.quote}</q></p>}
                <div className="iqx-ask-opts" role="radiogroup" aria-label={c.found}>
                  {c.options.map((o, i) => (
                    <label key={i} className="iqx-ask-opt">
                      <input type="radio" name={`iqx-${c.id}`} data-testid="iqx-ask-option" checked={!own[c.id]?.trim() && picks[c.id] === i}
                        onChange={() => { setPicks({ ...picks, [c.id]: i }); setOwn({ ...own, [c.id]: "" }); }} />
                      <span>{o.label}{o.recommended && <em className="iqx-rec"> · suggested</em>}{o.explains && <span className="iqi-dim"> — {o.explains}</span>}</span>
                    </label>
                  ))}
                  {c.allowsOwnAnswer && (
                    <label className="iqx-ask-own">
                      <span>Or tell me in your own words</span>
                      <input className="input" data-testid="iqx-ask-own" maxLength={1000} value={own[c.id] ?? ""} placeholder="Your answer is recorded with the question and left for you to apply — it is never guessed at"
                        onChange={(e) => setOwn({ ...own, [c.id]: e.target.value })} />
                    </label>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="iqx-actions">
            <button type="button" className="iq-btn primary" data-testid="iqx-answer" disabled={busy || !canAnswer || !ready.length} onClick={() => { onAnswer(ready); setPicks({}); setOwn({}); }}>
              {busy ? "Updating the survey…" : `Apply ${ready.length || ""} answer${ready.length === 1 ? "" : "s"} and continue`}
            </button>
            {!canAnswer && <span className="iqi-dim">This import was not kept as a session, so answers cannot be applied here — create the survey and finish these in Studio.</span>}
          </div>
        </div>
      )}
      {answered.length > 0 && (
        <details className="iqx-answered" data-testid="iqx-answered">
          <summary>{answered.length} answer{answered.length === 1 ? "" : "s"} on record</summary>
          <ul>{answered.map((c) => <li key={c.id}><b>{c.where}</b> — {c.found} <span className="iqi-dim">→ {c.answered!.label}</span></li>)}</ul>
        </details>
      )}
      {data.rejected.length > 0 && <p className="iqi-err" data-testid="iqx-rejected">{data.rejected.length} answer{data.rejected.length === 1 ? " was" : "s were"} not applied: {data.rejected.map((r) => r.reason).join("; ")}.</p>}

      <div className="iqx-tabs">
        {u && <button type="button" className={`iq-btn ${show === "understood" ? "primary" : ""}`} data-testid="iqx-tab-understood" onClick={() => setShow(show === "understood" ? null : "understood")}>What I understood</button>}
        {f && <button type="button" className={`iq-btn ${show === "report" ? "primary" : ""}`} data-testid="iqx-tab-report" onClick={() => setShow(show === "report" ? null : "report")}>Final report — {VERDICT_WORD[f.verdict] ?? f.verdict}</button>}
      </div>

      {show === "understood" && u && (
        <div className="iqx-panel" data-testid="iqx-understood">
          <p><b>Purpose</b> <span className="iqi-dim">(my reading — from {u.objective.basis.join("; ") || "the questions"})</span><br />{u.objective.text}</p>
          <p><b>Sections</b></p>
          <ul>{u.sections.map((s) => <li key={s.sourceId}><b>{s.title}</b> — {s.purpose}{s.questions ? `, ${s.questions} question${s.questions === 1 ? "" : "s"}` : ""}{s.looped ? ", repeated in a loop" : ""}{s.rotated ? ", rotated" : ""}{s.conditional ? ", shown on a condition" : ""} <span className="iqi-dim">({s.because}{s.dependsOn.length ? `; uses answers from ${s.dependsOn.join(", ")}` : ""})</span></li>)}</ul>
          <p><b>Questions</b> — {u.questions.total}: {u.questions.byKind.slice(0, 10).map((k) => `${k.count} ${k.kind}`).join(", ")}</p>
          {data.methodologies.length > 0 && (<><p><b>Research methods</b></p><ul>{data.methodologies.map((m, i) => <li key={i} data-testid="iqx-method" data-support={m.support}>{m.summary}{m.certainty === "inferred" ? " (my inference — the document does not name it)" : ""}{Object.keys(m.stated).length ? ` The document states: ${Object.entries(m.stated).map(([k, v]) => `${k} ${v}`).join(", ")}.` : ""}{m.needs.length ? <span className="iqi-dim"> Still needed: {m.needs.join("; ")}.</span> : null}</li>)}</ul></>)}
          {u.problems.length > 0 && (<><p><b>Missing, conflicting or unclear</b></p><ul>{u.problems.slice(0, 30).map((p, i) => <li key={i}><b>{p.where}</b> — {p.message}</li>)}</ul></>)}
          {data.content.length > 0 && (<><p><b>Wording to check</b> <span className="iqi-dim">(flagged only — nothing was changed)</span></p><ul>{data.content.slice(0, 30).map((c, i) => <li key={i}>{c.message}</li>)}</ul></>)}
          {u.filesNeeded.length > 0 && (<><p><b>Files this survey needs</b></p><ul>{u.filesNeeded.map((x, i) => <li key={i}><b>{x.name}</b> — {x.why}</li>)}</ul></>)}
        </div>
      )}

      {show === "report" && f && (
        <div className="iqx-panel" data-testid="iqx-report" data-verdict={f.verdict}>
          <p><b>{f.headline}</b></p>
          <p className="iqi-dim">Source items: {f.accounting.detected} found = {f.accounting.programmed} programmed + {f.accounting.partial} partly + {f.accounting.notProgrammed} not. Tests: {f.tests.walks} simulated interview{f.tests.walks === 1 ? "" : "s"} ({f.tests.walkErrors} error{f.tests.walkErrors === 1 ? "" : "s"}); {f.tests.scenariosPassed} of {f.tests.scenarios} logic scenarios pass, {f.tests.scenariosFailed} fail, {f.tests.notTestable} could not be tested automatically.</p>
          <p><b>Completed</b></p><ul>{f.completed.map((x, i) => <li key={i}>{x}</li>)}</ul>
          {f.corrected.length > 0 && (<><p><b>Found and corrected automatically</b></p><ul>{f.corrected.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
          {f.pending.length > 0 && (<><p><b>Pending — still to complete</b></p><ul>{f.pending.map((x, i) => <li key={i} data-testid="iqx-pending"><b>{x.what}</b> — {x.needs}</li>)}</ul></>)}
          {f.unresolved.length > 0 && (<><p><b>Unresolved</b></p><ul>{f.unresolved.map((x, i) => <li key={i} data-testid="iqx-unresolved"><b>{x.what}</b> — {x.why}</li>)}</ul></>)}
        </div>
      )}
    </div>
  );
}
