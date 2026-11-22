import type { SurveyDefinition } from "@rescript/schema";
import { runAgentLoop, type LoopResult, type Planner, type PlannerTurn } from "@rescript/engine";
import { validationSurvey } from "@rescript/quality";
import { verifySurvey } from "@rescript/templates";
import { pct, type CaseResult, type Suite } from "../core.js";

/**
 * THE AGENT LOOP WITH A SCRIPTED PLANNER (roadmap A3, A4, A6, A15). The planner here is a script, not a model: it
 * returns a fixed plan per attempt. The verifier is the real one (simulated respondents and the rule review). What
 * this measures is the LOOP: that it hands back what verification saw, stops when it should, asks before it
 * builds, raises the approval a plan needs, and never changes the survey it was given. It says nothing about how
 * good a model's plans are.
 */
const s = (tool: string, input: Record<string, unknown>, why = "The study needs it, as the brief describes.") => ({ tool, input, why });
const verifier = (def: SurveyDefinition) => verifySurvey(def, { count: 60, seed: 11 }).observations;
interface Scenario { id: string; planner: Planner; limits?: Record<string, number>; answers?: Record<string, string>; want: (r: LoopResult, turns: PlannerTurn[]) => boolean }
const cost = (c: number) => ({ tier: "large" as const, cost: c });

const SCENARIOS: Scenario[] = [
  { id: "verifies_first_time", planner: () => ({ plan: { steps: [s("survey.update_question", { target: "Q1", required: true })] }, usage: cost(0.01) }),
    want: (r) => r.stop === "verified" && r.attempts.length === 1 && r.approval === "confirm" },
  { id: "defect_seen_and_repaired", planner: (t) => ({ usage: cost(0.01), plan: t.attempt === 1
      ? { steps: [s("survey.set_display_logic", { target: "Q6", expression: "Q2 = Never" }), s("survey.add_skip", { from: "Q2", when: "Q2 = Never", to: "screened" })] }
      : { steps: [s("survey.set_display_logic", { target: "Q6", expression: "Q2 = Never" }, "Verification saw the people who should see Q6 were screened out first, so the screen-out is dropped.")] } }),
    want: (r, turns) => r.stop === "verified" && r.attempts.length === 2 && turns[1]!.previous!.observations.some((o) => o.kind === "never_shown" && (o.respondents ?? []).some((x) => x.answers.Q2 === "never")) },
  { id: "engine_refusal_handed_back", planner: (t) => ({ plan: { steps: [s("survey.update_question", { target: t.attempt === 1 ? "Q99" : "Q1", required: true })] }, usage: cost(0.01) }),
    want: (r, turns) => r.stop === "verified" && r.attempts.length === 2 && /was refused/.test(turns[1]!.previous!.observations[0]!.message) },
  { id: "unknown_tool_handed_back", planner: (t) => ({ plan: { steps: [s(t.attempt === 1 ? "survey.make_required" : "survey.update_question", { target: "Q1", required: true })] }, usage: cost(0.01) }),
    want: (r, turns) => r.stop === "verified" && r.attempts.length === 2 && /no tool called/.test(turns[1]!.previous!.observations[0]!.message) },
  { id: "never_repaired_stops", planner: () => ({ plan: { steps: [s("survey.add_skip", { from: "S1", when: "S1 = y", to: "screened" }), s("survey.add_skip", { from: "S1", when: "S1 = n", to: "screened" })] }, usage: cost(0.01) }),
    want: (r) => r.stop === "no_progress" && !r.verified && r.attempts.length === 3 && r.remaining.some((o) => o.kind === "nobody_completes") && !!r.after },
  { id: "cost_ceiling", planner: () => ({ plan: { steps: [s("survey.add_skip", { from: "S1", when: "S1 = y", to: "screened" }), s("survey.add_skip", { from: "S1", when: "S1 = n", to: "screened" })] }, usage: cost(0.4) }), limits: { costCeiling: 0.5 },
    want: (r) => r.stop === "cost" && r.attempts.length === 2 && r.spent === 0.8 },
  { id: "attempt_limit", planner: (t) => ({ plan: { steps: [s("survey.add_skip", { from: "S1", when: "S1 = y", to: "screened" }), s("survey.add_skip", { from: "S1", when: "S1 = n", to: "screened" }), ...(t.attempt > 1 ? [] : [s("survey.update_question", { target: "Q99", required: true })])] }, usage: cost(0.01) }), limits: { maxAttempts: 2 },
    want: (r) => r.stop === "attempts" && r.attempts.length === 2 },
  { id: "deletion_needs_explicit_approval", planner: () => ({ plan: { steps: [s("survey.delete_question", { target: "Q7" })] }, usage: cost(0.01) }),
    want: (r) => r.stop === "verified" && r.approval === "explicit" && r.destroys.length > 0 },
  { id: "asks_before_building", planner: () => ({ plan: { steps: [s("survey.update_question", { target: "Q1", required: true })], questions: [{ ask: "Which markets?", changes: ["audience"] }, { ask: "How many completes?", changes: ["sample"], default: { value: "400 completes", because: "±4.9 points is enough for a first read" } }, { ask: "Preferred font?", changes: [] }] }, usage: cost(0.01) }),
    want: (r) => r.stop === "needs_answers" && r.stepsRun === 0 && r.ask.length === 1 && r.ask[0]!.ask === "Which markets?" && r.assumptions.some((a) => a.text === "400 completes") },
  { id: "builds_once_answered", answers: { "Which markets?": "India and the US" }, planner: () => ({ plan: { steps: [s("survey.update_question", { target: "Q1", required: true })], questions: [{ ask: "Which markets?", changes: ["audience"] }] }, usage: cost(0.01) }),
    want: (r) => r.stop === "verified" && r.stepsRun === 1 },
  { id: "step_without_a_reason_is_refused", planner: (t) => ({ plan: { steps: [{ tool: "survey.update_question", input: { target: "Q1", required: true }, why: t.attempt === 1 ? "" : "The brand question must not be skipped; the analysis is by brand." }] }, usage: cost(0.01) }),
    want: (r, turns) => r.stop === "verified" && r.attempts.length === 2 && /gives no reason/.test(turns[1]!.previous!.observations[0]!.message) },
  { id: "planner_down", planner: () => { throw new Error("provider unavailable"); },
    want: (r) => r.stop === "planner_failed" && r.after === null && /provider unavailable/.test(r.because) },
];

export const agentLoopScripted: Suite = {
  id: "ai_agents.loop_scripted", area: "ai_agents", title: "The agent loop, with a scripted planner and the real verifier",
  async run() {
    const cases: CaseResult[] = [];
    let untouched = 0;
    for (const sc of SCENARIOS) {
      const def = validationSurvey();
      const before = JSON.stringify(def);
      const turns: PlannerTurn[] = [];
      const r = await runAgentLoop({ goal: sc.id, def, verifier, planner: (t) => { turns.push(t); return sc.planner(t); }, ...(sc.limits ? { limits: sc.limits } : {}), ...(sc.answers ? { answers: sc.answers } : {}) });
      const same = JSON.stringify(def) === before;
      if (same) untouched++;
      let ok = false; try { ok = sc.want(r, turns); } catch { ok = false; }
      cases.push({ id: sc.id, pass: ok && same, detail: `${r.stop} after ${r.attempts.length} attempt${r.attempts.length === 1 ? "" : "s"}${same ? "" : "; THE INPUT SURVEY WAS CHANGED"}` });
    }
    return {
      status: "measured",
      caveat: "the planner is a script. This shows the loop's control (hand back, stop, ask, approve, never write), not the quality of a model's plans, which needs a model key.",
      metrics: [
        { id: "behaves", label: "Scenarios where the loop did what it should", value: pct(cases.filter((c) => c.pass).length, cases.length), unit: "%", better: "higher", target: 100, tolerance: 0 },
        { id: "input_untouched", label: "Runs that left the survey they were given unchanged", value: pct(untouched, SCENARIOS.length), unit: "%", better: "higher", target: 100, tolerance: 0 },
      ],
      cases,
    };
  },
};
