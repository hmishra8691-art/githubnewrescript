import type { Condition, ProbeConfig, Question, SurveyDefinition } from "@rescript/schema";
import { ProbeConfig as ProbeConfigSchema } from "@rescript/schema";
import { PROBE_TYPES, lintProbeQuestion } from "./probe.js";
import { formatCondition } from "./logicExpression.js";
import type { CondInput } from "./surveyActions.js";

/**
 * THE QUALITATIVE ACTIONS (Research intelligence, 2026-10-17).
 *
 * An interview guide in Rescript is a self-completion survey of open ends
 * whose follow-ups the AI writes at run time (`question.probe`, run by the
 * runtime's probe route, linted by `probe.ts`). The runtime, the Studio
 * editor and the lint already knew probes; the copilot's vocabulary did not,
 * so Intelligent Mode could write the open ends of a guide but never probe
 * them. `set_probe` is that one missing action: it writes `question.probe`
 * on an open-text question and nothing else, through the same condition gate
 * as every other action; `"probe": null` removes it.
 */

export type ResearchAction =
  | { op: "set_probe"; target: string; remove?: boolean; maxProbes?: number; minWords?: number; prompt?: string; instruction?: string; required?: boolean; when?: CondInput | null; stopWhen?: CondInput | null };

export const RESEARCH_ACTION_OPS = ["set_probe"] as const;
const OPS = new Set<string>(RESEARCH_ACTION_OPS);
export const isResearchOp = (op: string): boolean => OPS.has(op);

const str = (v: unknown, max = 600): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : undefined);
const cond = (v: unknown): CondInput | null | undefined => (v === null ? null : typeof v === "string" && v.trim() ? v.trim() : v && typeof v === "object" && !Array.isArray(v) ? (JSON.parse(JSON.stringify(v)) as Condition) : undefined);

/** The gate: the model's JSON as a typed action, a reason, or null when the op is not one of these. */
export function coerceResearchAction(op: string, o: Record<string, unknown>): ResearchAction | string | null {
  if (op !== "set_probe") return null;
  const target = str(o.target ?? o.question, 120);
  if (!target) return "set_probe needs a target (the open-text question)";
  if (o.probe === null || o.remove === true || o.enabled === false) return { op, target, remove: true };
  const maxProbes = int(o.maxProbes ?? o.max ?? o.probes);
  if (maxProbes !== undefined && (maxProbes < 1 || maxProbes > 5)) return "set_probe: maxProbes is 1 to 5";
  const minWords = int(o.minWords);
  if (minWords !== undefined && minWords < 0) return "set_probe: minWords is 0 or more";
  const prompt = str(o.prompt ?? o.wording, 600), instruction = str(o.instruction ?? o.guidance, 600);
  const when = cond(o.when), stopWhen = cond(o.stopWhen);
  return { op, target, ...(maxProbes !== undefined ? { maxProbes } : {}), ...(minWords !== undefined ? { minWords } : {}), ...(prompt ? { prompt } : {}), ...(instruction ? { instruction } : {}), ...(typeof o.required === "boolean" ? { required: o.required } : {}), ...(when !== undefined ? { when } : {}), ...(stopWhen !== undefined ? { stopWhen } : {}) };
}

export interface ResearchEnv {
  question(ref: string): Question | undefined;
  condition(input: CondInput): Condition;
}
export interface ResearchApplied { description: string; destructive?: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };

export function applyResearchAction(def: SurveyDefinition, a: ResearchAction, env: ResearchEnv): ResearchApplied {
  const q = env.question(a.target) ?? fail(`there is no question “${a.target}”`);
  if (a.remove) {
    if (!q.probe) fail(`${q.code} has no follow-up probe`);
    delete (q as { probe?: ProbeConfig }).probe;
    return { description: `Remove the AI follow-up probe from ${q.code}`, destructive: `Removes ${q.code}'s follow-up probe`, warnings: [], touched: [q.id] };
  }
  if (!(PROBE_TYPES as readonly string[]).includes(q.type)) fail(`${q.code} is ${q.type.replace(/_/g, " ")} — a follow-up probe asks about an open answer; put it on an open-text question (open_text or long_text)`);
  const prev: Partial<ProbeConfig> = q.probe ?? {};
  const next: Record<string, unknown> = { ...prev };
  for (const k of ["maxProbes", "minWords", "prompt", "instruction", "required"] as const) if (a[k] !== undefined) next[k] = a[k];
  for (const k of ["when", "stopWhen"] as const) {
    const v = a[k];
    if (v === null) delete next[k];
    else if (v !== undefined) next[k] = env.condition(v);
  }
  const parsed = ProbeConfigSchema.safeParse(next);
  if (!parsed.success) fail(`the probe is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  q.probe = parsed.data!;
  const p = q.probe;
  const warnings = lintProbeQuestion(q).map((m) => `${q.code}: ${m}`);
  const words = [
    `up to ${p.maxProbes} follow-up${p.maxProbes === 1 ? "" : "s"}`,
    p.prompt ? `fixed wording “${p.prompt.slice(0, 60)}”` : p.instruction ? `the AI writes it (“${p.instruction.slice(0, 60)}”)` : "the AI writes it",
    p.minWords ? `answers of ${p.minWords}+ words` : "",
    p.when ? `when ${formatCondition(def, p.when)}` : "",
    p.stopWhen ? `stop when ${formatCondition(def, p.stopWhen)}` : "",
    p.required ? "the follow-up is required" : "",
  ].filter(Boolean).join(", ");
  return { description: `${Object.keys(prev).length ? "Change" : "Add"} the AI follow-up probe on ${q.code}: ${words}`, warnings, touched: [q.id] };
}

export function describeResearchAction(a: ResearchAction): string {
  return a.remove ? `Remove the follow-up probe from ${a.target}` : `AI follow-up probe on ${a.target}${a.maxProbes ? ` (up to ${a.maxProbes})` : ""}`;
}
