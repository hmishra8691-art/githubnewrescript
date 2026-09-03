"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the experimental family.
 *
 *   attention    which option(s) pass, and what failing does
 *   experiment   the arms (A/B and Random Stimulus share the editor)
 *
 * Terminating on a failed attention check is written as an ordinary question
 * `skipLogic` rule — `this question notIn expectedCodes → end/terminated` —
 * rather than as renderer behaviour. That way the flow engine, the logic map,
 * the linter and the QA report all see the termination they already know how
 * to see, and switching back to "flag" removes exactly that rule and nothing
 * else the programmer wrote.
 */

const FAIL_RULE_ID = "attention_fail";

/**
 * "Failed" is `answered AND notIn expected` — not `notIn expected` alone.
 * `notIn` on an unanswered question is vacuously true, so the bare rule would
 * terminate every respondent who skipped a non-required attention check
 * before they ever got it wrong.
 */
function failRule(q: Question) {
  const codes = (q.settings.expectedCodes ?? []).map((c) => String(c));
  return {
    id: FAIL_RULE_ID,
    label: "Attention check failed",
    when: {
      type: "group" as const,
      op: "and" as const,
      children: [
        { type: "rule" as const, source: { kind: "question" as const, ref: q.id }, operator: "answered" as const },
        { type: "rule" as const, source: { kind: "question" as const, ref: q.id }, operator: "notIn" as const, value: codes },
      ],
    },
    target: { kind: "end" as const, status: "terminated" as const },
  };
}

registerVariantSettings("attention", ({ q, patch, patchSettings }) => {
  const expected = (q.settings.expectedCodes ?? []).map(String);
  const onFail = q.settings.onFail ?? "flag";
  const hasRule = q.skipLogic.some((r) => r.id === FAIL_RULE_ID);

  /** Keep settings.onFail and the skip rule in step — one action, both writes. */
  const writeFail = (mode: "flag" | "terminate", codes = expected) => {
    const others = q.skipLogic.filter((r) => r.id !== FAIL_RULE_ID);
    patch({
      settings: { ...q.settings, onFail: mode, expectedCodes: codes },
      skipLogic: mode === "terminate"
        ? [...others, failRule({ ...q, settings: { ...q.settings, expectedCodes: codes } })]
        : others,
    });
  };

  const toggleCode = (code: string) => {
    const next = expected.includes(code) ? expected.filter((c) => c !== code) : [...expected, code];
    if (onFail === "terminate") writeFail("terminate", next);
    else patchSettings({ expectedCodes: next.length ? next : undefined });
  };

  return (
    <>
      <h3 className="sec">Attention check</h3>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Put the trap in the question text (“select Somewhat agree to show you are
        reading”). The respondent sees an ordinary single select — that is the point.
      </div>

      <div className="flabel">Expected answer(s)</div>
      {q.options.length === 0 ? (
        <div className="chip warn" data-testid="attention-needs">Add the options first.</div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {q.options.map((o) => {
            const code = String(o.code);
            return (
              <label key={code} className="row" style={{ gap: 6, fontSize: 12, marginBottom: 3 }}>
                <input type="checkbox" data-testid={`attention-expected-${code}`}
                  checked={expected.includes(code)}
                  onChange={() => toggleCode(code)} />
                <span>{o.label.replace(/<[^>]*>/g, "")}</span>
                <span className="muted mono" style={{ fontSize: 11 }}>{code}</span>
              </label>
            );
          })}
        </div>
      )}

      <label className="f">
        <span>When the check is failed</span>
        <select className="select" data-testid="attention-onfail" value={onFail}
          onChange={(e) => writeFail(e.target.value as "flag" | "terminate")}>
          <option value="flag">Flag it and carry on (exports 0/1)</option>
          <option value="terminate">Terminate the interview</option>
        </select>
      </label>

      {expected.length === 0 && (
        <div className="chip warn" data-testid="attention-nokey">
          Nothing is marked as expected, so every respondent fails.
        </div>
      )}
      {onFail === "terminate" && (
        <div className={hasRule ? "chip on" : "chip warn"} data-testid="attention-rule">
          {hasRule
            ? "Skip logic written: fails → end (terminated). It appears in the logic map like any other termination."
            : "Waiting to write the termination rule…"}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Exports the chosen code plus <span className="mono">{q.variableName}_PASSED</span> (1/0).
      </div>
    </>
  );
});

registerVariantSettings("experiment", ({ q, patchSettings }) => {
  const arms = q.settings.arms ?? [];
  const write = (next: typeof arms) => patchSettings({ arms: next.length ? next : undefined });
  const setAt = (i: number, patch: Partial<NonNullable<typeof arms>[number]>) =>
    write(arms.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const total = arms.reduce((s, a) => s + (a.weight == null ? 1 : Math.max(0, a.weight)), 0);

  return (
    <>
      <h3 className="sec">Experiment arms</h3>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        One arm is assigned per respondent from their seed, so the same
        respondent always sees the same arm and the assignment is reproducible.
        A weight of 0 parks an arm without deleting it.
      </div>

      {arms.map((a, i) => (
        <div key={i} data-testid={`arm-${i}`}
          style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input mono" style={{ width: 70 }} placeholder="code"
              data-testid={`arm-code-${i}`}
              value={String(a.code ?? "")}
              onChange={(e) => setAt(i, { code: e.target.value })} />
            <input className="input grow" placeholder="label (Control, Treatment…)"
              data-testid={`arm-label-${i}`}
              value={a.label ?? ""}
              onChange={(e) => setAt(i, { label: e.target.value })} />
            <CountInput data-testid={`arm-weight-${i}`} min={0} width={64}
              title="weight"
              value={a.weight}
              onChange={(v) => setAt(i, { weight: v })} />
            <button className="btn small danger" data-testid={`arm-remove-${i}`}
              onClick={() => write(arms.filter((_, j) => j !== i))}>×</button>
          </div>
          <label className="f" style={{ marginBottom: 6 }}>
            <span>Media URL (image or video)</span>
            <input className="input" data-testid={`arm-media-${i}`}
              placeholder="https://…"
              value={a.mediaUrl ?? ""}
              onChange={(e) => setAt(i, { mediaUrl: e.target.value || undefined })} />
          </label>
          <label className="f" style={{ marginBottom: 0 }}>
            <span>HTML shown for this arm</span>
            <textarea className="ta" style={{ minHeight: 60 }} data-testid={`arm-html-${i}`}
              value={a.html ?? ""}
              onChange={(e) => setAt(i, { html: e.target.value || undefined })} />
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {total > 0
              ? `${Math.round(((a.weight == null ? 1 : Math.max(0, a.weight)) / total) * 100)}% of respondents`
              : "no positive weights — the arms split evenly"}
          </div>
        </div>
      ))}

      <button className="btn small" data-testid="arm-add"
        onClick={() => write([...arms, {
          code: String.fromCharCode(65 + arms.length),
          label: `Arm ${arms.length + 1}`,
          weight: 1,
        }])}>
        + add arm
      </button>
      {arms.length === 0 && (
        <div className="chip warn" data-testid="experiment-noarms" style={{ marginLeft: 8 }}>
          No arms — the question has nothing to assign.
        </div>
      )}
    </>
  );
});
