"use client";
import React from "react";
import type { ConditionRule } from "@rescript/schema";
import { CALC_FUNCTIONS, parseExprCall, formatExprCall, stripHtmlText } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * THE FUNCTION-CALL HALF OF A CONDITION ROW — SUM/AVG/MIN/MAX/etc.
 *
 * CountEditor's sibling for `kind: "expr"` sources. An `expr` source stores
 * the whole call as one opaque calc-expression string (`source.ref`, e.g.
 * `"SUM(Q1_VAR, Q2_VAR, Q3_VAR)"`) — the same text the Expression editor
 * reads and writes, evaluated by the calculation engine
 * (`packages/engine/src/logicExpression.ts`'s `CALC_FUNCTIONS`/`calc.ts`).
 * Before this component existed, `RuleEditor` had no branch for this source
 * kind at all: it fell into the generic "Other" `<optgroup>`, showing the
 * entire call as literal text squeezed into the same `.ref-select` sized for
 * a short token like `q:Q3` — which is what made it look broken rather than
 * merely unbuilt.
 *
 * `parseExprCall`/`formatExprCall` do the actual text decomposition and
 * reassembly (reusing the engine's own function list and reference
 * resolution — nothing here re-implements that). This component is just
 * Function + one row per Argument + Add/Remove, wired to those two.
 *
 * A call this component cannot parse — bare arithmetic (`Q5 + Q6`), a
 * combination (`SUM(Q1,Q2) + 1`), or anything else `parseExprCall` declines —
 * is shown read-only here (still editable in the Expression/text tab) rather
 * than guessed at or silently rewritten.
 */
export function ExprEditor({
  rule, onChange,
}: {
  rule: ConditionRule;
  onChange(r: ConditionRule): void;
}) {
  const s = useStudio();
  const ref = rule.source.ref ?? "";
  const parsed = parseExprCall(ref);

  if (!parsed) {
    return (
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", minWidth: 0 }} data-testid="expr-editor-readonly">
        <span className="muted" style={{ fontSize: 12.5 }}>function</span>
        <span className="chip mono" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
          title="Edit this in the Expression (text) tab — it isn't a single function call this builder can take apart.">
          {ref || "(empty)"}
        </span>
      </div>
    );
  }

  const { fn, args } = parsed;
  const functions = React.useMemo(() => Array.from(CALC_FUNCTIONS).sort(), []);
  const questions = s.def.questions;

  const commit = (nextFn: string, nextArgs: string[]) =>
    onChange({ ...rule, source: { ...rule.source, ref: formatExprCall(s.def, nextFn, nextArgs) } });

  const setArg = (i: number, value: string) => commit(fn, args.map((a, k) => (k === i ? value : a)));
  const addArg = () => commit(fn, [...args, ""]);
  const removeArg = (i: number) => commit(fn, args.filter((_, k) => k !== i));

  return (
    <div className="expr-editor" data-testid="expr-editor" style={{ minWidth: 0 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>function</span>
        <select
          className="select" data-testid="expr-fn" aria-label="Function"
          value={fn} onChange={(e) => commit(e.target.value, args)}
        >
          {!functions.includes(fn) && <option value={fn}>{fn.toUpperCase()}</option>}
          {functions.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, minWidth: 0 }}>
        {args.map((a, i) => (
          <div key={i} className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center", minWidth: 0 }}
            data-testid={`expr-arg-row-${i}`}>
            <input
              className="input mono" style={{ flex: "1 1 140px", minWidth: 0 }}
              data-testid={`expr-arg-${i}`}
              value={a}
              placeholder="question, number, or text"
              onChange={(e) => setArg(i, e.target.value)}
            />
            <select
              className="select" style={{ flex: "0 1 170px", minWidth: 0 }}
              aria-label={`Insert a question reference into argument ${i + 1}`}
              data-testid={`expr-arg-pick-${i}`}
              value=""
              onChange={(e) => { if (e.target.value) setArg(i, e.target.value); }}
            >
              <option value="">insert question…</option>
              {questions.map((q) => (
                <option key={q.id} value={q.variableName}>
                  {q.code} — {stripHtmlText(q.text).slice(0, 40) || q.variableName}
                </option>
              ))}
            </select>
            <button type="button" className="btn small danger" title="Remove this argument"
              data-testid={`expr-arg-remove-${i}`} onClick={() => removeArg(i)}>×</button>
          </div>
        ))}
        <button type="button" className="btn small" data-testid="expr-add-arg" onClick={addArg}
          style={{ alignSelf: "flex-start" }}>
          + Add Argument
        </button>
      </div>

      <div className="muted mono" style={{ fontSize: 12, marginTop: 4, wordBreak: "break-word" }} data-testid="expr-reading">
        {fn.toUpperCase()}({args.filter((a) => a.trim() !== "").join(", ") || "…"})
      </div>
    </div>
  );
}
