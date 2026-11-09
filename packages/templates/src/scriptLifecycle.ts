import { codeGate } from "@rescript/engine";
import type { CustomScript, SurveyDefinition } from "@rescript/schema";
import { generatePopulation } from "./generate.js";
import { simulateRespondent } from "./simulate.js";
import { checkExpectations, outcomeOf, staleReferences, type TestCase } from "./testCases.js";

/**
 * GENERATED ≠ EXECUTED ≠ VALIDATED (2026-11-09, Rapid Studio phase 4).
 *
 * A logic script written by the AI (or a person, or an import) has only been WRITTEN. Whether it ever runs depends on
 * its event, scope and guard meeting a respondent; whether it does the right thing depends on someone having stated
 * what right is. Three statuses, each from evidence produced here, deterministically:
 *
 *   generated   the code exists and passes the logic-script gate (who wrote it: origin)
 *   executed    it actually ran when simulated respondents walked the survey through the real engine — how many ran it,
 *               how many times it threw. Never claimed for an on_complete script: the walk ends before it would run.
 *   validated   it ran inside a test case whose expectations PASS and cover what the script writes (a variable it
 *               sets); a script that writes nothing is validated by a passing case it ran in, said so
 *
 * A later stage is never claimed without the earlier one: a refused script is not generated, a script that threw in
 * every run is "failing", not executed.
 */
export type ScriptStage = "empty" | "refused" | "generated" | "not_reached" | "failing" | "executed" | "validated";
export interface ScriptStatus {
  id: string;
  name: string;
  origin: "person" | "ai" | "import" | "unknown";
  enabled: boolean;
  stage: ScriptStage;
  generated: { ok: boolean; problem?: string };
  executed: { respondents: number; of: number; runs: number; failures: number; messages: string[]; simulated: boolean };
  validated: { cases: { id: string; name: string; covers: string[] }[]; failingCases: { id: string; name: string; failures: string[] }[] };
  /** variables the code writes (set / setCalc / setEmbedded / flag targets, as named in the code) */
  writes: string[];
  /** one sentence: what the stage rests on, and what would move it on */
  summary: string;
}
export interface ScriptCheck { scripts: ScriptStatus[]; simulated: number; casesRun: number; counts: Record<ScriptStage, number> }

const WRITE = /\b(?:ctx\.)?(set|setCalc|setEmbedded|flag)\s*\(\s*(["'`])([^"'`]{1,80})\2/g;
export function scriptWrites(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(WRITE)) out.add(m[3].trim());
  return [...out];
}

/** the exported names a write target can appear under in a test case's expected variables */
function exportedNames(def: SurveyDefinition, ref: string): string[] {
  const r = ref.toLowerCase();
  const q = def.questions.find((x) => x.id.toLowerCase() === r || x.code?.toLowerCase() === r || x.variableName?.toLowerCase() === r);
  return [...new Set([ref, ...(q ? [q.variableName, q.code, q.id].filter(Boolean) as string[] : [])].map((x) => x.toLowerCase()))];
}

export function checkScripts(def: SurveyDefinition, opts: { count?: number; seed?: number; cases?: TestCase[] } = {}): ScriptCheck {
  const scripts = def.scripts ?? [];
  const count = Math.max(0, Math.min(500, opts.count ?? 100));
  const runs: Record<string, { respondents: number; runs: number; failures: number; messages: string[] }> = {};
  if (scripts.length && count) {
    const pop = generatePopulation(def, { count, seed: opts.seed ?? 20261109 });
    for (const p of pop.respondents) {
      for (const [id, t] of Object.entries(p.sim.scriptRuns ?? {})) {
        const r = (runs[id] ??= { respondents: 0, runs: 0, failures: 0, messages: [] });
        if (t.runs) r.respondents++;
        r.runs += t.runs; r.failures += t.failures;
        for (const m of t.messages) if (r.messages.length < 3 && !r.messages.includes(m)) r.messages.push(m);
      }
    }
  }
  const caseRuns: { c: TestCase; ran: Set<string>; failures: string[]; stale: boolean }[] = [];
  for (const c of (opts.cases ?? []).filter((x) => x.enabled !== false)) {
    const sim = simulateRespondent(def, { answers: c.input.answers ?? {}, seed: c.input.seed ?? 1, embedded: c.input.embedded ?? {}, quotaCounts: c.input.quotaCounts ?? {}, listFillCounts: c.input.listFillCounts ?? {} });
    const outcome = outcomeOf(def, sim);
    caseRuns.push({ c, ran: new Set(Object.entries(sim.scriptRuns).filter(([, t]) => t.runs > t.failures).map(([id]) => id)), failures: checkExpectations(def, outcome, c.expectations), stale: staleReferences(def, c.input).length > 0 });
  }

  const out: ScriptStatus[] = scripts.map((sc: CustomScript) => {
    const origin = ((sc as { origin?: string }).origin as ScriptStatus["origin"]) ?? "unknown";
    const writes = scriptWrites(sc.code ?? "");
    const gate = sc.code?.trim() ? codeGate(sc.code, "logic") : null;
    const generated = { ok: !!gate?.ok, ...(gate && !gate.ok ? { problem: gate.errors[0] ?? "refused by the logic-script check" } : {}) };
    const r = runs[sc.id] ?? { respondents: 0, runs: 0, failures: 0, messages: [] };
    const simulable = sc.event !== "on_complete";
    const executed = { ...r, of: count, simulated: simulable && count > 0 };
    const cases: ScriptStatus["validated"]["cases"] = [], failingCases: ScriptStatus["validated"]["failingCases"] = [];
    for (const cr of caseRuns) {
      if (!cr.ran.has(sc.id)) continue;
      const expected = Object.keys(cr.c.expectations?.variables ?? {}).map((k) => k.toLowerCase());
      const covers = writes.filter((w) => exportedNames(def, w).some((n) => expected.includes(n)));
      const hasExpectations = !!cr.c.expectations && Object.values(cr.c.expectations).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0) && (typeof v !== "object" || Array.isArray(v) || Object.keys(v as object).length > 0));
      if (cr.failures.length || cr.stale) { if (covers.length || !writes.length) failingCases.push({ id: cr.c.id, name: cr.c.name, failures: cr.stale ? ["out of date: answers questions that no longer exist"] : cr.failures }); continue; }
      if (covers.length || (!writes.length && hasExpectations)) cases.push({ id: cr.c.id, name: cr.c.name, covers });
    }
    let stage: ScriptStage, summary: string;
    const who = origin === "ai" ? "Written by the AI" : origin === "import" ? "Imported" : origin === "person" ? "Written by a person" : "Written";
    if (!sc.code?.trim()) { stage = "empty"; summary = "No code yet."; }
    else if (!generated.ok) { stage = "refused"; summary = `${who}, but refused by the logic-script check: ${generated.problem}. It will not run.`; }
    else if (failingCases.length && !cases.length) { stage = "failing"; summary = `Ran in test case “${failingCases[0].name}”, which fails: ${failingCases[0].failures[0]}.`; }
    else if (r.runs && r.failures === r.runs) { stage = "failing"; summary = `Threw an error every time it ran (${r.failures} runs): ${r.messages[0] ?? "error"}.`; }
    else if (cases.length) { stage = "validated"; summary = `Checked by ${cases.length} passing test case${cases.length === 1 ? "" : "s"} (${cases.map((c) => `“${c.name}”`).join(", ")})${cases.some((c) => c.covers.length) ? `, expecting ${[...new Set(cases.flatMap((c) => c.covers))].join(", ")}` : " — it writes no variable, so the cases' other expectations are the check"}.${r.failures ? ` It still threw in ${r.failures} of ${r.runs} simulated runs.` : ""}`; }
    else if (r.runs) { stage = "executed"; summary = `Ran for ${r.respondents} of ${count} simulated respondents${r.failures ? `, threw in ${r.failures} of ${r.runs} runs (${r.messages[0]})` : " without errors"} — not validated: no passing test case checks ${writes.length ? writes.join(", ") : "its effect"}.`; }
    else if (!sc.enabled) { stage = "generated"; summary = `${who} and passes the check, but switched off — it does not run.`; }
    else if (!simulable) { stage = "generated"; summary = `${who} and passes the check. on_complete scripts run at the end of a live interview; the simulation cannot execute them — test them with a test link.`; }
    else if (count) { stage = "not_reached"; summary = `${who} and passes the check, but never ran for any of ${count} simulated respondents — its event, scope or “run only when” condition is never met.`; }
    else { stage = "generated"; summary = `${who} and passes the check; not run yet.`; }
    return { id: sc.id, name: sc.name, origin, enabled: sc.enabled, stage, generated, executed, validated: { cases, failingCases }, writes, summary };
  });
  const counts = { empty: 0, refused: 0, generated: 0, not_reached: 0, failing: 0, executed: 0, validated: 0 } as Record<ScriptStage, number>;
  for (const s of out) counts[s.stage]++;
  return { scripts: out, simulated: scripts.length ? count : 0, casesRun: caseRuns.length, counts };
}
