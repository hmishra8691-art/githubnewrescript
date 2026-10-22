"use client";
import React from "react";
import { conjointMethodOf, cvaTasksFor, dualKey, dualPrompt } from "@rescript/engine";
import type { SurveyDefinition, Question } from "@rescript/schema";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * THE CONJOINT SUITE'S RESPONDENT TASKS (F4, 2026-10-22).
 *
 * RATING-BASED CONJOINT (CVA) — `conjoint_task` with a `cva` design. Each task is one full profile
 * (or a pair, side by side) with a rating scale of buttons from the design's minimum to its maximum
 * and the end labels under it. The answer is `{ "<task>": rating }`, the tasks in the respondent's
 * version (designRowsFor via cvaTasksFor), so what was shown is what the analysis regresses on.
 *
 * DUAL-RESPONSE NONE — under each CBC task of a dual-response design, once the forced choice is
 * made: "Would you actually buy the option you chose?" Yes / No, stored as `<task>_buy` in the same
 * answer object (the engine's `dualKey`), exported as VAR_T<n>_BUY.
 *
 * Both are pure renderers of the answer: no local state, so a reload resumes exactly.
 */

export function CvaTasks(p: QRProps) {
  const design = p.def.designs.find((d) => d.id === p.q.settings.designRef);
  if (!design?.file?.rows?.length) return <div className="rs-error-msg">Design “{p.q.settings.designRef ?? "(none)"}” not generated yet — create a Rating-based conjoint (CVA) design in Design Generators and pick it here.</div>;
  if (design.kind !== "cva") return <div className="rs-error-msg">This question needs a Rating-based conjoint (CVA) design; “{design.name}” is a {design.kind} design.</div>;
  const info = conjointMethodOf(p.def, p.q)!;
  const scale = info.cva!;
  const tasks = cvaTasksFor(p.def, p.q, p.state.seed);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const readOnly = !!p.q.settings.readOnly;
  const paired = scale.mode === "paired";
  const points = Array.from({ length: Math.max(0, Math.round(scale.max - scale.min)) + 1 }, (_, k) => scale.min + k);
  const minLabel = scale.minLabel ?? (paired ? "Strongly prefer the left" : "Definitely would not buy");
  const maxLabel = scale.maxLabel ?? (paired ? "Strongly prefer the right" : "Definitely would buy");
  const attrs = tasks[0] ? Object.keys(tasks[0].profiles[0].levels) : [];
  return (
    <div className="rs-cva-tasks" data-testid="rs-cva-tasks" data-mode={scale.mode} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {tasks.map((t, ti) => (
        <div key={t.task} className="rs-card rs-cva-task" style={{ margin: 0 }} data-testid={`cva-task-${t.task}`} data-task={t.task}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>{paired ? "Pair" : "Product"} {ti + 1} of {tasks.length}</div>
          <div className="rs-cva-profiles" style={{ display: "grid", gridTemplateColumns: paired ? "repeat(auto-fit, minmax(180px, 1fr))" : "1fr", gap: 12 }}>
            {t.profiles.map((pr, k) => (
              <table key={pr.alt} className="rs-matrix rs-cva-profile" data-testid="cva-profile" data-alt={pr.alt}>
                {paired && <caption style={{ fontWeight: 600, textAlign: "left" }}>{k === 0 ? "Left" : "Right"}</caption>}
                <tbody>
                  {attrs.map((a) => <tr key={a}><th className="rowlabel" scope="row">{a}</th><td data-label={a}>{pr.levels[a] || "—"}</td></tr>)}
                </tbody>
              </table>
            ))}
          </div>
          <div className="rs-cva-scale" role="radiogroup" aria-label={paired ? "Which do you prefer, and how strongly?" : "How likely would you be to buy it?"} style={{ marginTop: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {points.map((v) => {
                const on = vals[t.task] != null && vals[t.task] !== "" && Number(vals[t.task]) === v;
                return (
                  <label key={v} className={`rs-scale-btn${on ? " selected" : ""}`} style={{ minWidth: 36, textAlign: "center" }}>
                    <input type="radio" name={`${p.q.id}_${t.task}`} value={v} checked={on} disabled={readOnly}
                      data-testid={`cva-rate-${t.task}-${v}`} aria-label={`${v}`}
                      onChange={() => p.onChange({ ...vals, [t.task]: v })} />
                    <span>{v}</span>
                  </label>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85em", opacity: 0.8, marginTop: 4 }}>
              <span data-testid="cva-min-label">{minLabel}</span><span data-testid="cva-max-label">{maxLabel}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

registerVariantRenderer("cvatasks", CvaTasks);

/** the "would you actually buy it?" follow-up of a dual-response CBC task — shown once the task has a choice */
export function DualResponseFollowUp({ def, q, task, value, onChange, readOnly }: { def: SurveyDefinition; q: Question; task: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; readOnly?: boolean }) {
  const info = conjointMethodOf(def, q);
  if (!info?.dualResponse) return null;
  const chosen = value[task];
  if (chosen == null || chosen === "") return null;
  const k = dualKey(task);
  const prompt = dualPrompt(info.design);
  return (
    <div className="rs-cbc-dual" role="radiogroup" aria-label={prompt} data-testid={`cbc-dual-${task}`} style={{ marginTop: 12 }}>
      <div style={{ marginBottom: 6 }}>{prompt}</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {(["yes", "no"] as const).map((v) => (
          <label key={v} className="rs-anchor-choice" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="radio" name={`${q.id}_${task}_buy`} value={v} checked={value[k] === v} disabled={readOnly}
              data-testid={`cbc-buy-${task}-${v}`} onChange={() => onChange({ ...value, [k]: v })} />
            <span>{v === "yes" ? "Yes, I would buy it" : "No, I would not buy it"}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
