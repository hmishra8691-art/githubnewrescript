"use client";
import React from "react";
import type { AttentionCheck, Question, Severity } from "@rescript/schema";
import { useStudio } from "./store";

/**
 * "Attention check" on a question. The question stays an ordinary question —
 * respondents see nothing different — but the quality engine grades the
 * answer against `expected` and explains a miss:
 *
 *   explicit      "select Strongly agree for this row"  → expected codes
 *   instruction   "please choose the third option"       → expected codes
 *   trap          an impossible option ("I have used none of these, including this one") → codes that FAIL
 *   reverse       reverse-worded item — expected codes are the sincere ones
 *   repeat        must agree with an earlier question    → paired question
 *   knowledge     a fact question; paired with the "how expert are you" question
 */
const KINDS: { value: AttentionCheck["kind"]; label: string; hint: string }[] = [
  { value: "explicit", label: "Explicit attention check", hint: "The text tells the respondent exactly what to select." },
  { value: "instruction", label: "Instruction-following", hint: "An instruction hidden in the question or a row (\"choose the third option\")." },
  { value: "trap", label: "Trap / impossible option", hint: "Selecting any of the listed options is the failure." },
  { value: "reverse", label: "Reverse-worded item", hint: "The sincere answer is the opposite pole; list the acceptable codes." },
  { value: "repeat", label: "Repeated question", hint: "Must agree with the paired earlier question." },
  { value: "knowledge", label: "Knowledge test", hint: "A fact with a right answer; pair with the expertise claim to detect gaps." },
];
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

export function AttentionCheckEditor({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const ac = q.attentionCheck;
  const setAc = (p: Partial<AttentionCheck>) => {
    s.labelNextEdit?.("edit attention check");
    patch({ attentionCheck: { kind: "explicit", expected: [], severity: "high", riskPoints: 25, qualityPenalty: 20, ...(ac ?? {}), ...p } });
  };
  const others = s.def.questions.filter((x) => x.id !== q.id);
  const hasOptions = q.options.length > 0;

  return (
    <div data-testid="attention-check">
      <label className="row" style={{ gap: 6, fontSize: 12, marginBottom: 6 }}>
        <input type="checkbox" data-testid="attention-toggle" checked={!!ac}
          onChange={(e) => { s.labelNextEdit?.(e.target.checked ? "mark as attention check" : "unmark attention check"); patch({ attentionCheck: e.target.checked ? { kind: "explicit", expected: [], severity: "high", riskPoints: 25, qualityPenalty: 20 } : undefined }); }} />
        <strong>Attention check</strong>
        <span className="muted">— graded by the quality engine; respondents see an ordinary question</span>
      </label>
      {ac && (
        <div className="card" style={{ padding: 10 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <label className="f" style={{ minWidth: 220 }}><span>Kind</span>
              <select className="select" data-testid="attention-kind" value={ac.kind} onChange={(e) => setAc({ kind: e.target.value as AttentionCheck["kind"] })}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 11 }}>{KINDS.find((k) => k.value === ac.kind)?.hint}</span></label>
            <label className="f" style={{ width: 110 }}><span>Severity</span>
              <select className="select" value={ac.severity} onChange={(e) => setAc({ severity: e.target.value as Severity })}>{SEVERITIES.map((sv) => <option key={sv}>{sv}</option>)}</select></label>
            <label className="f" style={{ width: 110 }}><span>Fraud risk points</span>
              <input className="input" type="number" min={0} max={100} data-testid="attention-risk" value={ac.riskPoints} onChange={(e) => setAc({ riskPoints: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} /></label>
            <label className="f" style={{ width: 110 }}><span>Quality penalty</span>
              <input className="input" type="number" min={0} max={100} value={ac.qualityPenalty} onChange={(e) => setAc({ qualityPenalty: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} /></label>
          </div>

          {ac.kind === "repeat" || ac.kind === "knowledge" ? (
            <label className="f"><span>{ac.kind === "repeat" ? "Must agree with" : "Paired expertise question (optional)"}</span>
              <select className="select" data-testid="attention-paired" value={ac.pairedQuestionId ?? ""} onChange={(e) => setAc({ pairedQuestionId: e.target.value || undefined })}>
                <option value="">— choose a question —</option>
                {others.map((o) => <option key={o.id} value={o.id}>{o.code} · {o.text.replace(/<[^>]*>/g, "").slice(0, 50)}</option>)}
              </select></label>
          ) : null}

          {ac.kind !== "repeat" && (
            <div className="f">
              <span>{ac.kind === "trap" ? "Options that FAIL the check" : "Passing answer" + (hasOptions ? "(s)" : "")}</span>
              {hasOptions ? (
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }} data-testid="attention-expected">
                  {q.options.map((o) => {
                    const on = ac.expected.map(String).includes(String(o.code));
                    return (
                      <label key={String(o.code)} className={`chip ${on ? "on" : ""}`} style={{ cursor: "pointer" }}>
                        <input type="checkbox" checked={on} onChange={(e) => setAc({ expected: e.target.checked ? [...ac.expected, o.code] : ac.expected.filter((c) => String(c) !== String(o.code)) })} />
                        {" "}{o.code}: {o.label.replace(/<[^>]*>/g, "").slice(0, 30)}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <input className="input" data-testid="attention-expected-text" value={ac.expected.map(String).join(" / ")}
                  placeholder="accepted answers, separated by /"
                  onChange={(e) => setAc({ expected: e.target.value.split("/").map((x) => x.trim()).filter(Boolean) })} />
              )}
              {!ac.expected.length && <span className="chip warn" style={{ marginTop: 4 }}>Pick at least one — otherwise every answer {ac.kind === "trap" ? "passes" : "fails"}.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
