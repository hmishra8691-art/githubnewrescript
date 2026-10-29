/**
 * THE FALLBACK PLANNER AND ITS STEPS (K1, 2026-10-25) — used when no specialised planner (K2 generation, K3
 * translation, K4 assessment) claims a non-trivial request. It subsumes the old staged build for whatever is left:
 * the request is cut into batches by the deterministic estimate (questions to write, questions to rework), each batch
 * is one small model call that sees only the persisted summary, its own range and the codes already built (never
 * the whole brief again), and a deterministic check closes the plan.
 *
 *   copilot.generate   write questions [from..to] with fixed codes Q<from>..Q<to> (ids stable across batches)
 *   copilot.rework     apply the request to the listed questions only (explanations, rewording, per-question edits)
 *   copilot.turn       one bounded call for a request that cannot be batched (a multi-deliverable remainder)
 *   copilot.check      deterministic: the draft has the requested count, every code is unique, the actions applied
 *
 * Every step validates its own actions on the draft before it returns `completed`; a cut-off answer is split in two;
 * an answer in words is retried once with a targeted instruction.
 */
import { applySurveyActions, coerceSurveyActions, estimateTaskSize, type SurveyAction } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { neutralizeUntrusted } from "@rescript/ai";
import { COPILOT_REPLY_SCHEMA } from "../../copilot/replySchema.ts";
import { registerStepHandler, registerTaskPlanner } from "../registry.ts";
import { registerFakeResponder } from "../fakeResponders.ts";
import { resultForFailure } from "../failures.ts";
import { summaryFromMessage as summaryOf } from "../engine.ts";
import type { StepContext, StepResult, TaskPlanner, TaskStepSpec } from "../types.ts";

const BATCH_GENERATE = 10;
const BATCH_REWORK = 10;

type Def = SurveyDefinition;
const questionsOf = (d: unknown): Def["questions"] => (d && typeof d === "object" && Array.isArray((d as Def).questions) ? (d as Def).questions : []);

/** the spec line every batch prompt carries (and the fake provider's stand-in reads) */
export const SPEC_TAG = "BATCH_SPEC:";
const specLine = (o: Record<string, unknown>) => `${SPEC_TAG} ${JSON.stringify(o)}`;

export const genericPlanner: TaskPlanner = {
  id: "copilot.generic",
  matches: () => 0.05,
  async plan({ message, survey, summary }) {
    const qs = questionsOf(survey);
    const e = estimateTaskSize({ message, survey: survey as { questions?: unknown[] } });
    const goal = summary?.goal ? summary : summaryOf(message, e.deliverables, e.language);
    const steps: TaskStepSpec[] = [];
    const completion: string[] = [];
    if (e.kind === "generate" || e.kind === "brief") {
      const total = Math.max(1, e.units);
      const start = qs.length + 1;
      for (let i = 0; i < total; i += BATCH_GENERATE) {
        const from = start + i, to = start + Math.min(total, i + BATCH_GENERATE) - 1;
        steps.push({ id: `gen_${from}_${to}`, kind: "copilot.generate", title: `Write questions ${from}–${to}`, dependsOn: [], input: { from, to, units: to - from + 1, range: { from, to }, total: start + total - 1 }, parallelGroup: "batches", modelTier: "standard", estimate: { inputTokens: 3000, outputTokens: (to - from + 1) * 200, usd: 0 } });
      }
      completion.push(`questions>=${qs.length + total}`, "unique_codes");
    } else if (e.kind === "per_question" || e.kind === "rework_all" || e.kind === "translate") {
      const scope = e.range ? qs.slice(e.range.from - 1, e.range.to) : qs;
      for (let i = 0; i < scope.length; i += BATCH_REWORK) {
        const batch = scope.slice(i, i + BATCH_REWORK);
        const from = (e.range?.from ?? 1) + i, to = from + batch.length - 1;
        steps.push({ id: `rework_${from}_${to}`, kind: "copilot.rework", title: `Questions ${from}–${to}: ${goal.goal.slice(0, 60)}`, dependsOn: [], input: { codes: batch.map((q) => q.code), units: batch.length, range: { from, to } }, parallelGroup: "batches", modelTier: "standard" });
      }
      completion.push("unique_codes");
    }
    if (!steps.length) steps.push({ id: "turn", kind: "copilot.turn", title: goal.goal.slice(0, 120) || "Do the request", dependsOn: [], input: {}, modelTier: "strong" });
    steps.push({ id: "check", kind: "copilot.check", title: "Check the result", dependsOn: steps.map((s) => s.id), input: { minQuestions: e.kind === "generate" || e.kind === "brief" ? qs.length + Math.max(1, e.units) : 0 } });
    return { summary: goal, steps, completion };
  },
};

/** the actions of a model reply, refused ones dropped, checked on the draft */
function actionsChecked(value: unknown, draft: unknown): { actions: SurveyAction[]; errors: string[]; rejected: number } {
  const raw = value && typeof value === "object" ? (value as { actions?: unknown }).actions : null;
  const { actions, rejected } = coerceSurveyActions(raw);
  if (!actions.length) return { actions, errors: [], rejected: rejected.length };
  const applied = applySurveyActions(draft as Def, actions);
  const okIdx = new Set(applied.results.filter((r) => r.ok).map((r) => r.index));
  return { actions: actions.filter((_, i) => okIdx.has(i)), errors: applied.results.filter((r) => !r.ok).map((r) => `${r.description}: ${r.error ?? "refused"}`), rejected: rejected.length };
}

const outlineOf = (qs: Def["questions"]) => qs.map((q) => `${q.code} [${q.type}] ${neutralizeUntrusted(String(q.text ?? ""), { maxChars: 300 }).replace(/\s+/g, " ")}${Array.isArray((q as { options?: unknown[] }).options) ? ` | ${((q as { options: { code?: unknown; label?: unknown }[] }).options).slice(0, 12).map((o) => `${o.code}=${neutralizeUntrusted(String(o.label ?? ""), { maxChars: 80 })}`).join("; ")}` : ""}`).join("\n");

function summaryText(ctx: StepContext): string {
  const s = ctx.summary;
  return [`GOAL: ${s.goal}`, s.deliverables.length ? `DELIVERABLES: ${s.deliverables.join(", ")}` : "", s.constraints.length ? `CONSTRAINTS: ${s.constraints.join("; ")}` : "", s.decisions.length ? `DECISIONS: ${s.decisions.join("; ")}` : "", s.language ? `LANGUAGE: ${s.language}` : ""].filter(Boolean).join("\n");
}

/** one batch call with the default recovery: split on a cut-off, one targeted retry for an answer in words */
async function batchCall(ctx: StepContext, purpose: string, prompt: string, maxTokens: number, splitInto: () => TaskStepSpec[] | null): Promise<{ value: unknown } | StepResult> {
  const r = await ctx.ai({ purpose, prompt, schema: COPILOT_REPLY_SCHEMA, maxTokens, tier: ctx.step.modelTier ?? "standard" });
  if (r.ok) return { value: r.value };
  if ((r.kind === "output_limit" || r.kind === "context_limit") ) { const parts = splitInto(); if (parts) return { status: "split", replaceWith: parts, reason: `${r.kind}: ${r.message}` }; }
  if (r.kind === "invalid_output" && ctx.attempt < 2) return { status: "retry", reason: `invalid_output: ${r.message}`, retryAfterMs: 500 };
  return resultForFailure(r);
}

function halves(ctx: StepContext, make: (from: number, to: number, suffix: string) => TaskStepSpec): TaskStepSpec[] | null {
  const r = ctx.step.input.range as { from: number; to: number } | undefined;
  if (!r || r.to - r.from < 1) return null;
  const mid = Math.floor((r.from + r.to) / 2);
  return [make(r.from, mid, "a"), make(mid + 1, r.to, "b")];
}

export const generateHandler = {
  kind: "copilot.generate",
  async run(ctx: StepContext): Promise<StepResult> {
    const { from, to, total } = ctx.step.input as { from: number; to: number; total: number };
    const qs = questionsOf(ctx.draft);
    const have = new Set(qs.map((q) => q.code));
    const codes = Array.from({ length: to - from + 1 }, (_, i) => `Q${from + i}`).filter((c) => !have.has(c));
    if (!codes.length) return { status: "completed", output: { actions: [], validation: { ok: true, errors: [], warnings: ["already built"] } } };
    const prompt = [
      summaryText(ctx),
      `YOU ARE WRITING PART OF A LARGER QUESTIONNAIRE (${total} questions in all). Write ONLY questions ${from}–${to} as create_question actions, with exactly these codes, in order: ${codes.join(", ")}.`,
      `Codes already in the survey (do not repeat or renumber): ${[...have].slice(-60).join(", ") || "none"}.`,
      "Answer in the JSON shape asked for: kind \"proposal\", a one-sentence reply, and the actions.",
      specLine({ op: "generate", codes }),
    ].join("\n\n");
    const r = await batchCall(ctx, "copilot.generate", prompt, Math.max(4000, codes.length * 450), () => halves(ctx, (a, b, s) => ({ id: `${ctx.step.id}${s}`, kind: "copilot.generate", title: `Write questions ${a}–${b}`, dependsOn: ctx.step.dependsOn, input: { ...ctx.step.input, from: a, to: b, units: b - a + 1, range: { from: a, to: b } }, parallelGroup: ctx.step.parallelGroup, modelTier: ctx.step.modelTier })));
    if (!("value" in r)) return r;
    const c = actionsChecked(r.value, ctx.draft);
    const made = new Set(c.actions.map((a) => (a as { code?: string }).code).filter(Boolean));
    const missing = codes.filter((x) => !made.has(x));
    if (!c.actions.length) return ctx.attempt < 2 ? { status: "retry", reason: "invalid_output: the answer had no usable question", retryAfterMs: 500 } : { status: "failed", reason: `invalid_output: no usable question for ${codes[0]}–${codes.at(-1)} (${c.errors.slice(0, 2).join("; ")})`, permanent: false };
    return { status: "completed", output: { actions: c.actions, validation: { ok: missing.length === 0, errors: missing.length ? [`missing ${missing.join(", ")}`] : [], warnings: c.errors.slice(0, 5) } } };
  },
};

export const reworkHandler = {
  kind: "copilot.rework",
  async run(ctx: StepContext): Promise<StepResult> {
    const codes = (ctx.step.input.codes as string[]) ?? [];
    const qs = questionsOf(ctx.draft).filter((q) => codes.includes(q.code));
    if (!qs.length) return { status: "completed", output: { actions: [], validation: { ok: true, errors: [], warnings: ["no questions in this batch any more"] } } };
    const prompt = [
      summaryText(ctx),
      `APPLY THE REQUEST TO THESE ${qs.length} QUESTIONS ONLY (target each by its code; change nothing else):`,
      outlineOf(qs),
      "Answer in the JSON shape asked for: kind \"proposal\", a one-sentence reply, and the actions (update_question and the other actions the request needs, one per question at least).",
      specLine({ op: "rework", codes: qs.map((q) => q.code) }),
    ].join("\n\n");
    const r = await batchCall(ctx, "copilot.rework", prompt, Math.max(3000, qs.length * 500), () => {
      if (codes.length < 2) return null;
      const mid = Math.ceil(codes.length / 2);
      const range = ctx.step.input.range as { from: number; to: number } | undefined;
      return [codes.slice(0, mid), codes.slice(mid)].map((cs, i) => ({ id: `${ctx.step.id}${i ? "b" : "a"}`, kind: "copilot.rework", title: `${ctx.step.title} (${i + 1}/2)`, dependsOn: ctx.step.dependsOn, input: { codes: cs, units: cs.length, ...(range ? { range: i ? { from: range.from + mid, to: range.to } : { from: range.from, to: range.from + mid - 1 } } : {}) }, parallelGroup: ctx.step.parallelGroup, modelTier: ctx.step.modelTier }));
    });
    if (!("value" in r)) return r;
    const c = actionsChecked(r.value, ctx.draft);
    if (!c.actions.length) return ctx.attempt < 2 ? { status: "retry", reason: "invalid_output: the model answered in words, not changes", retryAfterMs: 500 } : { status: "failed", reason: "invalid_output: the model answered in words, not changes", permanent: false };
    const touched = new Set(c.actions.map((a) => String((a as { target?: unknown; code?: unknown }).target ?? (a as { code?: unknown }).code ?? "")));
    const untouched = qs.map((q) => q.code).filter((x) => !touched.has(x));
    return { status: "completed", output: { actions: c.actions, validation: { ok: true, errors: [], warnings: [...(untouched.length ? [`not changed: ${untouched.join(", ")}`] : []), ...c.errors.slice(0, 5)] } } };
  },
};

export const turnHandler = {
  kind: "copilot.turn",
  async run(ctx: StepContext): Promise<StepResult> {
    const prompt = [summaryText(ctx), `THE SURVEY (${questionsOf(ctx.draft).length} questions):`, outlineOf(questionsOf(ctx.draft).slice(0, 80)), "Answer in the JSON shape asked for.", specLine({ op: "turn" })].join("\n\n");
    const r = await batchCall(ctx, "copilot.turn", prompt, 12_000, () => null);
    if (!("value" in r)) return r;
    const c = actionsChecked(r.value, ctx.draft);
    const reply = r.value && typeof r.value === "object" ? String((r.value as { reply?: unknown }).reply ?? "") : "";
    return { status: "completed", output: { actions: c.actions, data: { reply: reply.slice(0, 4000) }, validation: { ok: true, errors: [], warnings: c.errors.slice(0, 5) } } };
  },
};

export const checkHandler = {
  kind: "copilot.check",
  async run(ctx: StepContext): Promise<StepResult> {
    const qs = questionsOf(ctx.draft);
    const errors: string[] = [];
    const min = Number(ctx.step.input.minQuestions ?? 0);
    if (min && qs.length < min) errors.push(`expected at least ${min} questions, the draft has ${qs.length}`);
    const seen = new Set<string>();
    for (const q of qs) { if (seen.has(q.code)) errors.push(`duplicate code ${q.code}`); seen.add(q.code); }
    return { status: "completed", output: { data: { questions: qs.length }, validation: { ok: !errors.length, errors, warnings: [] } } };
  },
};

/* TEST SEAM (fake provider only): the stand-in "model" for the fallback's batches — reads the spec line */
export function genericFakeResponder(call: { purpose: string; prompt: string }) {
  const line = call.prompt.split("\n").find((l) => l.startsWith(SPEC_TAG));
  if (!line) return undefined;
  const spec = JSON.parse(line.slice(SPEC_TAG.length)) as { op: string; codes?: string[] };
  if (spec.op === "generate") return { value: { kind: "proposal", reply: `Wrote ${spec.codes!.length} questions.`, plan: [], actions: spec.codes!.map((code) => ({ op: "create_question", type: "single_select", code, text: `Fake question ${code}: which statement is correct?`, options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }] })), rejected: [], findings: [], assumptions: [], questions: [], sources: [] } };
  if (spec.op === "rework") return { value: { kind: "proposal", reply: `Updated ${spec.codes!.length} questions.`, plan: [], actions: spec.codes!.map((code) => ({ op: "update_question", target: code, instruction: `Explanation for ${code} (fake).` })), rejected: [], findings: [], assumptions: [], questions: [], sources: [] } };
  return { value: { kind: "answer", reply: "Done (fake).", plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] } };
}

export function registerGenericTasks(): void {
  registerTaskPlanner(genericPlanner);
  registerStepHandler(generateHandler);
  registerStepHandler(reworkHandler);
  registerStepHandler(turnHandler);
  registerStepHandler(checkHandler);
  registerFakeResponder("copilot.", genericFakeResponder);
}
