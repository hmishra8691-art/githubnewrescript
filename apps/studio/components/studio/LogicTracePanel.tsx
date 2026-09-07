"use client";
import React from "react";
import type { Condition, Question } from "@rescript/schema";
import type { TraceNode } from "@rescript/engine";
import {
  traceCondition, tracePunches, formatTrace,
  createResponseState, setAnswer, conditionSummary,
} from "@rescript/engine";
import { useStudio } from "./store";

/**
 * THE LOGIC TRACE, IN THE STUDIO (§32, §33).
 *
 * There was a trace before this, and it lived in the test runtime's debug
 * panel — which means a programmer had to launch a session, answer their way
 * to the question, and read a flat list of leaf comparisons with no group
 * structure. Logic is written here, so this is where the "why did that
 * happen" question gets asked.
 *
 * ## WHAT MAKES IT USEFUL RATHER THAN DECORATIVE
 *
 * IT IS HYPOTHETICAL. The answers are typed in, not collected. A programmer
 * debugging "why does Q10 punch Medium for a three-brand respondent" wants to
 * try three brands, then four, then none — in three seconds, not three
 * sessions.
 *
 * IT SHOWS THE STRUCTURE. Every AND / OR / NOT is a node with its children
 * indented under it, so which side of an OR failed is visible rather than
 * inferred.
 *
 * IT DISTINGUISHES SKIPPED FROM FALSE. A branch an earlier condition
 * short-circuited past is marked as not evaluated, because "we never looked"
 * and "we looked and it was false" send you to different places.
 *
 * The trace calls the real evaluator for every node, so it can be incomplete
 * but it cannot disagree with what a respondent would get.
 */
export function LogicTracePanel() {
  const s = useStudio();
  const questions: Question[] = s.def.questions;
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [target, setTarget] = React.useState<string>("");

  /** The hypothetical state: typed answers, parsed the way the runtime would. */
  const ctx = React.useMemo(() => {
    const state = createResponseState(s.def, { seed: 1 });
    for (const q of questions) {
      const raw = answers[q.id];
      if (raw === undefined || raw === "") continue;
      /*
       * A multi-select is a list of codes; everything else is a scalar. Typed
       * as comma-separated text because a full answer widget here would be a
       * second renderer to keep in step with the real one.
       */
      const many = q.type.includes("multi") || q.type.includes("rank");
      const value: unknown = many
        ? raw.split(",").map((x) => x.trim()).filter(Boolean)
        : /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw.trim();
      setAnswer(s.def, state, q.id, value);
    }
    return { def: s.def, state, loop: null };
  }, [s.def, questions, answers]);

  /** Everything in the survey worth tracing, as one list. */
  const targets = React.useMemo(() => {
    const out: { id: string; label: string; when?: Condition; punchFor?: string }[] = [];
    for (const q of questions) {
      if (q.displayLogic) out.push({ id: `dl:${q.id}`, label: `${q.code} — display logic`, when: q.displayLogic });
      for (const [i, sk] of (q.skipLogic ?? []).entries()) {
        out.push({ id: `sk:${sk.id}`, label: `${q.code} — skip rule ${i + 1}`, when: sk.when });
      }
      if ((q.punches ?? []).length) {
        out.push({ id: `pu:${q.id}`, label: `${q.code} — auto punch (${q.punches.length} rules)`, punchFor: q.id });
      }
      if (q.mask?.when) out.push({ id: `mk:${q.id}`, label: `${q.code} — mask condition`, when: q.mask.when });
    }
    for (const r of s.def.displayRules ?? []) {
      out.push({ id: `dr:${r.id}`, label: `display rule — ${r.label ?? r.id}`, when: r.when });
    }
    for (const e of s.def.namedExpressions ?? []) {
      out.push({ id: `ne:${e.id}`, label: `named expression — ${e.name}`, when: e.when });
    }
    for (const quota of s.def.quotas ?? []) {
      for (const cell of quota.cells) {
        out.push({ id: `qc:${cell.id}`, label: `quota ${quota.name} / ${cell.label}`, when: cell.when });
      }
    }
    return out;
  }, [questions, s.def]);

  const chosen = targets.find((t) => t.id === target) ?? targets[0];

  const trace = React.useMemo(() => {
    if (!chosen) return null;
    if (chosen.punchFor) return null;
    return traceCondition(chosen.when, ctx as never);
  }, [chosen, ctx]);

  const punch = React.useMemo(() => {
    if (!chosen?.punchFor) return null;
    return tracePunches(s.def, chosen.punchFor, ctx as never);
  }, [chosen, ctx, s.def]);

  const copy = () => {
    const text = punch
      ? [`AUTO PUNCH TRACE — ${punch.questionCode}`, "",
        ...punch.rules.map((r) =>
          `${r.mode.toUpperCase().replace("_", " ")}  ${r.label}: `
          + (r.reached ? (r.held ? "TRUE" : "false") : "not reached")
          + (r.trace ? `\n${formatTrace(r.trace, 1)}` : "")),
        "", punch.outcome].join("\n")
      : trace ? `LOGIC TRACE\n\n${formatTrace(trace)}` : "";
    try { void navigator.clipboard?.writeText(text); s.toast("Trace copied"); } catch { /* no clipboard */ }
  };

  if (!targets.length) {
    return (
      <p className="muted" style={{ fontSize: 13 }} data-testid="trace-empty">
        Nothing to trace yet. Add display logic, a skip rule, an auto punch rule or a named
        expression and it will appear here.
      </p>
    );
  }

  return (
    <div data-testid="logic-trace">
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px", lineHeight: 1.55 }}>
        Type answers, pick a rule, and see exactly how it was decided — every AND and OR, the
        value at each step, and which branches were never looked at. Nothing here touches a
        respondent; it is the real evaluator run against answers you invent.
      </p>

      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <select className="select grow" data-testid="trace-target"
          value={chosen?.id ?? ""} onChange={(e) => setTarget(e.target.value)}
          aria-label="What to trace">
          {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <button className="btn small" data-testid="trace-copy" onClick={copy}>copy</button>
        <button className="btn small" data-testid="trace-clear"
          onClick={() => setAnswers({})}>clear answers</button>
      </div>

      {/* ------------------------------------------------- the answers */}
      <details className="card" style={{ padding: "8px 12px", marginBottom: 8 }} open
        data-testid="trace-answers">
        <summary style={{ cursor: "pointer", fontSize: 13 }}>Answers to test with</summary>
        <div style={{ marginTop: 6 }}>
          {questions.map((q) => (
            <div className="row" key={q.id} style={{ gap: 6, marginBottom: 4, fontSize: 13 }}>
              <span className="mono muted" style={{ minWidth: 60 }}>{q.code}</span>
              <input
                className="input grow" data-testid={`trace-answer-${q.id}`}
                value={answers[q.id] ?? ""}
                placeholder={q.type.includes("multi") ? "codes, comma separated" : "a value"}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
              {(q.options ?? []).length > 0 && (
                <span className="muted mono" style={{ fontSize: 11.5 }}>
                  {q.options.slice(0, 6).map((o) => String(o.code)).join(" ")}
                </span>
              )}
            </div>
          ))}
        </div>
      </details>

      {/* ------------------------------------------------ the punch trace */}
      {punch && (
        <div className="card" style={{ padding: "8px 12px" }} data-testid="punch-trace">
          <div className="row" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>Auto punch — {punch.questionCode}</strong>
            <span className="grow" />
            <span className={`qd-state ${punch.rules.some((r) => r.applied) ? "active" : "inactive"}`}
              data-testid="punch-outcome">{punch.outcome}</span>
          </div>
          {punch.rules.map((r) => (
            <div key={r.ruleId} className="trace-rule" data-testid="punch-trace-rule"
              data-applied={String(r.applied)} data-reached={String(r.reached)}
              style={{ marginBottom: 6, opacity: r.reached ? 1 : 0.55 }}>
              <div className="row" style={{ gap: 6, fontSize: 13 }}>
                <span className="chip mono">{r.mode.toUpperCase().replace("_", " ")}</span>
                <strong>{r.label}</strong>
                <span className={r.applied ? "true" : "false"}>
                  {r.reached ? (r.held ? "TRUE" : "false") : "not reached"}
                </span>
              </div>
              {r.trace && <TraceTree node={r.trace} />}
              {!r.reached && (
                <div className="muted" style={{ fontSize: 12, marginLeft: 14 }}>
                  An earlier branch of this chain already matched.
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------------------------- the condition trace */}
      {trace && (
        <div className="card" style={{ padding: "8px 12px" }} data-testid="condition-trace">
          <div className="row" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>{chosen?.label}</strong>
            <span className="grow" />
            <span className={`qd-state ${trace.result ? "active" : "full"}`} data-testid="trace-result">
              {trace.result ? "TRUE" : "FALSE"}
            </span>
          </div>
          <TraceTree node={trace} />
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            {chosen?.when ? conditionSummary(s.def, chosen.when) : ""}
          </p>
        </div>
      )}
    </div>
  );
}

/** One node and its children, indented. */
function TraceTree({ node, depth = 0 }: { node: TraceNode; depth?: number }) {
  const mark = node.shortCircuited ? "–" : node.result ? "✓" : "✗";
  const cls = node.shortCircuited ? "muted" : node.result ? "true" : "false";
  return (
    <div className="trace-node" data-testid="trace-node"
      data-result={String(node.result)} data-skipped={String(!!node.shortCircuited)}
      style={{ marginLeft: depth * 14, fontSize: 12.5, lineHeight: 1.6 }}>
      <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
        <span className={cls} style={{ width: 12 }}>{mark}</span>
        <span className="mono">{node.text || node.kind}</span>
        {node.left !== undefined && !node.children.length && (
          <span className="muted">→ {display(node.left)}</span>
        )}
      </div>
      {node.children.map((c, i) => <TraceTree key={i} node={c} depth={depth + 1} />)}
      <div className="muted" style={{ marginLeft: 18, fontSize: 11.5 }}>{node.because}</div>
    </div>
  );
}

function display(v: unknown): string {
  if (v === null || v === undefined) return "(no answer)";
  if (Array.isArray(v)) return v.length ? `[${v.map(String).join(", ")}]` : "(nothing selected)";
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  if (v === "") return "(empty)";
  return String(v);
}
