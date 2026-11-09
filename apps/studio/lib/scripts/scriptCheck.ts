import { checkScripts, type ScriptCheck, type ScriptStage, type TestCase } from "@rescript/templates";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * THE SCRIPT LIFECYCLE CHECK IN THE STUDIO (2026-11-09, phase 4). One run, shared by the Scripts panel (Manual) and
 * Intelligent Mode: 100 simulated respondents through the real engine, plus the project's test cases (fetched from
 * /api/surveys/[id]/tests; none in the sandbox or before migration 0018). The result is kept for the session and marked
 * stale as soon as the survey changes — a status is never shown for code it was not computed on.
 */
export const STAGE_WORDS: Record<ScriptStage, string> = {
  empty: "Empty", refused: "Refused", generated: "Generated", not_reached: "Never ran", failing: "Failing", executed: "Executed", validated: "Validated",
};
export interface ScriptCheckRun { check: ScriptCheck; defKey: string; at: number; casesNote: string | null }

let last: ScriptCheckRun | null = null;
const listeners = new Set<() => void>();
export const defKey = (def: SurveyDefinition) => JSON.stringify([def.scripts, def.flow, def.questions.map((q) => [q.id, q.type, q.displayLogic ?? null]), def.calculations ?? []]);
export function lastScriptCheck(def: SurveyDefinition): (ScriptCheckRun & { stale: boolean }) | null { return last ? { ...last, stale: last.defKey !== defKey(def) } : null; }
export function subscribeScriptCheck(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

interface CaseRow { id: string; name: string; enabled: boolean; input: TestCase["input"]; expectations?: TestCase["expectations"] }
export async function loadCases(surveyId: string): Promise<{ cases: TestCase[]; note: string | null }> {
  if (surveyId === "sandbox") return { cases: [], note: "The sandbox has no test cases, so nothing can be validated here — in a saved project, add a test case in Research tools → Tests that expects the variable the script writes." };
  try {
    const r = await fetch(`/api/surveys/${encodeURIComponent(surveyId)}/tests`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { cases: [], note: j.migration ? `Test cases need migration ${j.migration}; without them nothing can be validated.` : "The test cases could not be read; nothing was validated." };
    return { cases: ((j.cases ?? []) as CaseRow[]).map((c) => ({ id: c.id, name: c.name, enabled: c.enabled, input: c.input ?? { answers: {} }, expectations: c.expectations ?? undefined })), note: null };
  } catch { return { cases: [], note: "The test cases could not be read; nothing was validated." }; }
}

export async function runScriptCheck(def: SurveyDefinition, surveyId: string): Promise<ScriptCheckRun> {
  const { cases, note } = await loadCases(surveyId);
  const check = checkScripts(def, { count: 100, cases });
  last = { check, defKey: defKey(def), at: Date.now(), casesNote: note };
  for (const l of listeners) l();
  return last;
}

/** Intelligent Mode: a question about the scripts' status */
const ASKS = /\b(?:scripts?|js|javascript|code)\b.{0,60}\b(?:status|validated|verified|tested|executed|ran|run|working|work|checked|check)\b|\b(?:check|test|validate|verify)\b.{0,20}\b(?:the |my |all )?(?:logic )?(?:scripts?|javascript|js code)\b|\bdid (?:the |my |your )?(?:ai(?:'s)? )?scripts? (?:run|work)\b/i;
const EDIT = /\b(?:write|create|add|make|generate|rename|delete|remove|update|change|fix)\b.{0,30}\bscripts?\b/i;
export function scriptStatusQuestion(text: string): boolean { return ASKS.test(text) && !EDIT.test(text); }

export function scriptStatusAnswer(run: ScriptCheckRun): { answer: string; sections: { title: string; items: { label: string; detail?: string }[] }[] } {
  const c = run.check;
  if (!c.scripts.length) return { answer: "This survey has no logic scripts.", sections: [] };
  const order: ScriptStage[] = ["failing", "refused", "not_reached", "generated", "executed", "validated", "empty"];
  const parts = order.filter((s) => c.counts[s]).map((s) => `${c.counts[s]} ${STAGE_WORDS[s].toLowerCase()}`);
  return {
    answer: `${c.scripts.length} logic script${c.scripts.length === 1 ? "" : "s"}, checked against ${c.simulated} simulated respondents${c.casesRun ? ` and ${c.casesRun} test case${c.casesRun === 1 ? "" : "s"}` : ""}: ${parts.join(", ")}. Written is not the same as run, and run is not the same as right — only “validated” means a passing test case checked what the script produces.${run.casesNote ? ` ${run.casesNote}` : ""} Details are in Research tools → Scripts.`,
    sections: order.filter((s) => c.counts[s]).map((s) => ({ title: STAGE_WORDS[s], items: c.scripts.filter((x) => x.stage === s).map((x) => ({ label: x.name, detail: x.summary })) })),
  };
}
