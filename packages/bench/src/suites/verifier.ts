import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "@rescript/engine";
import { validationSurvey } from "@rescript/quality";
import { verifySurvey, type Observation, type SimExpectation } from "@rescript/templates";
import { pct, type CaseResult, type Suite } from "../core.js";

/**
 * THE VERIFIER (roadmap A5) — surveys with a defect planted in them. For each, the verifier has to report the
 * right KIND of observation on the right QUESTION, with the condition and simulated respondents where the kind has
 * them. Two surveys have no defect: anything reported on them above a note is a false alarm.
 */
interface Planted { id: string; build: () => { def: SurveyDefinition; expectations?: SimExpectation[] }; found: (o: Observation[]) => boolean; evidence?: (o: Observation[]) => boolean }
const act = (...actions: Record<string, unknown>[]): SurveyDefinition => { const r = applySurveyActions(validationSurvey(), actions as unknown as SurveyAction[]); if (r.errors.length) throw new Error(r.errors.join("; ")); return r.def; };
const raw = (mutate: (d: SurveyDefinition) => void): SurveyDefinition => { const d = validationSurvey(); mutate(d); return SurveyDefinition.parse(d); };
const on = (o: Observation[], kind: Observation["kind"], code: string) => o.find((x) => x.kind === kind && x.where.codes.includes(code));

export const PLANTED: Planted[] = [
  { id: "condition_cannot_be_true", build: () => ({ def: raw((d) => { (d.questions.find((q) => q.code === "Q6") as { displayLogic?: unknown }).displayLogic = { type: "rule", source: { kind: "question", ref: "freq" }, operator: "eq", value: "hourly" }; }) }),
    found: (o) => !!on(o, "never_shown", "Q6"), evidence: (o) => { const x = on(o, "never_shown", "Q6")!; return x.condition?.reads.join() === "Q2" && x.respondents.length > 0 && x.respondents.every((r) => "Q2" in r.answers); } },
  { id: "screened_before_the_question", build: () => ({ def: act({ op: "set_display_logic", target: "Q6", expression: "Q2 = Never" }, { op: "add_skip", from: "Q2", when: "Q2 = Never", to: "screened" }) }),
    found: (o) => !!on(o, "never_shown", "Q6"), evidence: (o) => { const x = on(o, "never_shown", "Q6")!; return /should show, and never reached it/.test(x.message) && x.respondents.every((r) => r.answers.Q2 === "never" && r.endStatus === "screened"); } },
  { id: "everyone_screened_out", build: () => ({ def: act({ op: "add_skip", from: "S1", when: "S1 = y", to: "screened" }, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" }) }),
    found: (o) => o.some((x) => x.kind === "nobody_completes"), evidence: (o) => { const x = o.find((y) => y.kind === "nobody_completes")!; return x.where.pageId === "p1" && x.where.codes.includes("S1") && x.respondents.every((r) => "S1" in r.answers); } },
  { id: "expectation_contradicted", build: () => ({ def: act({ op: "set_display_logic", target: "Q1", expression: "S1 = No" }), expectations: [{ id: "owners", question: "brand", expect: "shown", when: { type: "rule", source: { kind: "question", ref: "own" }, operator: "eq", value: "y" } }] }),
    found: (o) => !!on(o, "expectation_broken", "Q1"), evidence: (o) => { const x = on(o, "expectation_broken", "Q1")!; return x.respondents.length > 0 && x.respondents.every((r) => r.answers.S1 === "y") && !!x.condition; } },
  { id: "skipped_past_by_everyone", build: () => ({ def: act({ op: "add_skip", from: "S1", when: "S1 = y", to: "Q5" }, { op: "add_skip", from: "S1", when: "S1 = n", to: "Q5" }) }),
    found: (o) => ["Q1", "Q2", "Q3", "Q4"].every((c) => !!on(o, "never_shown", c)) },
  { id: "question_without_options", build: () => ({ def: raw((d) => { (d.questions.find((q) => q.code === "Q1") as { options: unknown[] }).options = []; }) }),
    found: (o) => o.some((x) => x.severity === "blocker" && x.where.codes.includes("Q1")) },
  { id: "hidden_behind_two_conditions", build: () => ({ def: act({ op: "set_display_logic", target: "Q7", expression: "S1 = No" }, { op: "add_skip", from: "S1", when: "S1 = n", to: "screened" }) }),
    found: (o) => !!on(o, "never_shown", "Q7"), evidence: (o) => /S1/.test(on(o, "never_shown", "Q7")!.look) },
];
export const SOUND: { id: string; build: () => SurveyDefinition }[] = [
  { id: "sound_plain", build: () => validationSurvey() },
  { id: "sound_with_logic", build: () => act({ op: "set_display_logic", target: "Q1", expression: "S1 = Yes" }, { op: "add_skip", from: "Q2", when: "Q2 = Never", to: "Q5" }) },
];

export const verifierPlanted: Suite = {
  id: "ai_agents.verifier", area: "ai_agents", title: "The verifier on surveys with a planted defect",
  run() {
    const cases: CaseResult[] = [];
    let found = 0, withEvidence = 0, wantsEvidence = 0, ms = 0;
    for (const p of PLANTED) {
      const b = p.build();
      const t = performance.now();
      const v = verifySurvey(b.def, { count: 60, seed: 11, ...(b.expectations ? { expectations: b.expectations } : {}) });
      ms += performance.now() - t;
      const hit = p.found(v.observations);
      let ev = true;
      if (p.evidence) { wantsEvidence++; try { ev = hit && p.evidence(v.observations); } catch { ev = false; } if (ev) withEvidence++; }
      if (hit) found++;
      cases.push({ id: p.id, group: "planted", pass: hit && ev, detail: hit ? (ev ? "found, with its condition and respondents" : "found, without the evidence expected") : `not found; saw ${v.observations.map((o) => `${o.kind}@${o.where.codes.join("+") || "-"}`).join(", ") || "nothing"}` });
    }
    let alarms = 0;
    for (const s of SOUND) {
      const v = verifySurvey(s.build(), { count: 60, seed: 11 });
      const loud = v.observations.filter((o) => o.severity !== "note");
      alarms += loud.length;
      cases.push({ id: s.id, group: "sound", pass: loud.length === 0, detail: loud.length ? `false alarm: ${loud.map((o) => o.message).join(" | ").slice(0, 200)}` : "nothing reported" });
    }
    return {
      status: "measured",
      caveat: "seven planted defects on one 14-question survey, 60 simulated respondents each. A defect that needs a rare combination of answers, a quota, a script or a loop is not in this set.",
      metrics: [
        { id: "found", label: "Planted defects reported on the right question", value: pct(found, PLANTED.length), unit: "%", better: "higher", target: 99 },
        { id: "evidence", label: "Of those that should carry them: reported with the condition and the simulated respondents", value: pct(withEvidence, wantsEvidence), unit: "%", better: "higher", target: 99 },
        { id: "false_alarms", label: "Problems reported on sound surveys", value: alarms, unit: "count", better: "lower", target: 0, tolerance: 0 },
        { id: "verify_ms", label: "One verification (60 simulated respondents, 14 questions)", value: Math.round(ms / PLANTED.length), unit: "ms", better: "lower", target: 2000, machineDependent: true },
      ],
      cases,
    };
  },
};
