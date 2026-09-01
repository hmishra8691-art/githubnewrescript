"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import {
  createResponseState,
  explainOptions,
  questionDependencies,
  lintQuestionLogic,
  type OptionPipelineTrace,
} from "@rescript/engine";
import { useStudio } from "./store";

/**
 * Option preview / debugger (reqs §15, §29).
 *
 * Set the answers this question depends on, then watch the pipeline run:
 * every stage, what it dropped and why. This is the tool that answers
 * "why did Apple disappear?" without deploying a test link.
 */

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "");

export function OptionPreview({ q }: { q: Question }) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const [answers, setAnswers] = React.useState<Record<string, (string | number)[]>>({});

  const deps = React.useMemo(
    () =>
      [...questionDependencies(s.def, q)]
        .map((id) => s.def.questions.find((x) => x.id === id))
        .filter((x): x is Question => !!x),
    [s.def, q],
  );

  const trace: OptionPipelineTrace | null = React.useMemo(() => {
    if (!open) return null;
    try {
      const state = createResponseState(s.def, { seed: 42 });
      for (const [qid, codes] of Object.entries(answers)) {
        const src = s.def.questions.find((x) => x.id === qid);
        if (!src || codes.length === 0) continue;
        const single = ["single_select", "dropdown", "numeric", "open_text", "nps", "slider"].includes(src.type);
        state.answers[qid] = single ? codes[0] : codes;
      }
      return explainOptions(q, { def: s.def, state });
    } catch (err) {
      return null;
    }
  }, [open, answers, s.def, q]);

  const issues = React.useMemo(() => lintQuestionLogic(s.def, q), [s.def, q]);

  const toggle = (qid: string, code: string | number) =>
    setAnswers((a) => {
      const cur = a[qid] ?? [];
      return {
        ...a,
        [qid]: cur.some((c) => String(c) === String(code))
          ? cur.filter((c) => String(c) !== String(code))
          : [...cur, code],
      };
    });

  return (
    <div className="option-preview">
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="btn small" data-testid="toggle-option-preview" onClick={() => setOpen((v) => !v)}>
          {open ? "▾ hide option preview" : "🔍 option preview — why is an option shown or hidden?"}
        </button>
        {issues.filter((i) => i.level === "error").length > 0 && (
          <span className="chip warn">{issues.filter((i) => i.level === "error").length} logic error(s)</span>
        )}
      </div>

      {open && (
        <div className="card" style={{ padding: 12 }}>
          {issues.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              {issues.map((i, k) => (
                <div key={k} className={`chip ${i.level === "error" ? "warn" : ""}`} style={{ marginBottom: 4 }}>
                  {i.level === "error" ? "✕" : "!"} {i.path}{i.optionCode ? ` [${i.optionCode}]` : ""} — {i.message}
                </div>
              ))}
            </div>
          )}

          {deps.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>
              This question’s options don’t depend on any earlier answer — the list below is what
              every respondent sees.
            </p>
          ) : (
            <>
              <div className="flabel">Simulate answers</div>
              {deps.map((d) => (
                <div key={d.id} className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
                  <span className="mono" style={{ width: 60, fontSize: 12 }}>{d.code}</span>
                  {d.options.length === 0 && (
                    <input className="input" style={{ width: 160 }} placeholder="value"
                      value={String(answers[d.id]?.[0] ?? "")}
                      onChange={(e) => setAnswers((a) => ({ ...a, [d.id]: e.target.value ? [e.target.value] : [] }))} />
                  )}
                  {d.options.map((o) => (
                    <label key={String(o.code)} className={`vis-pill ${answers[d.id]?.some((c) => String(c) === String(o.code)) ? "on" : ""}`}>
                      <input type="checkbox"
                        checked={!!answers[d.id]?.some((c) => String(c) === String(o.code))}
                        onChange={() => toggle(d.id, o.code)} />
                      {stripHtml(o.label) || String(o.code)}
                    </label>
                  ))}
                </div>
              ))}
            </>
          )}

          {trace && (
            <>
              <div className="flabel" style={{ marginTop: 10 }}>Pipeline</div>
              <table className="pipeline-table">
                <tbody>
                  {trace.stages.filter((st) => st.changed || st.key === "source").map((st, i) => (
                    <tr key={i}>
                      <td className="k">{st.label}</td>
                      <td>
                        <span className="mono" style={{ fontSize: 11 }}>{st.after.join(", ") || "—"}</span>
                        {st.removed.length > 0 && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            removed {st.removed.map((r) => r.code).join(", ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flabel" style={{ marginTop: 10 }}>Options</div>
              <table className="pipeline-table" data-testid="option-status">
                <tbody>
                  {Object.values(trace.byCode).map((st) => (
                    <tr key={st.code}>
                      <td className="k">
                        <span className="mono">{st.code}</span> {st.label}
                      </td>
                      <td>
                        <span className={st.status === "visible" ? "ok-pill" : "hide-pill"}>
                          {st.status === "visible" ? `VISIBLE #${st.position}` : "HIDDEN"}
                        </span>
                        {st.alwaysShow && <span className="chip">always show</span>}
                        {st.pinned && <span className="chip">pinned</span>}
                        {st.moved && <span className="chip">moved {st.moved}</span>}
                        {st.status === "hidden" && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {st.stage}: {st.reason}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
