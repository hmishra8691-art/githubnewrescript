import { SURVEY_TEMPLATES } from "@rescript/templates";
import { applySurveyActions, getQuestionByCodeOrVar, highRiskActions, researcherAsked, type HighRiskKind, type SurveyAction } from "@rescript/engine";
import { SurveyDefinition } from "@rescript/schema";
import { memoryFrom } from "../copilot/client.ts";
import type { CopilotReply } from "../copilot/prompt.ts";
import { NDJSON, readTurnResponse } from "../copilot/stream.ts";
import { newSurveyDefinition } from "../defaults.ts";
import type { RiskRules } from "./score.ts";
import type { RunnerDeps, UsageLike } from "./runner.ts";

/**
 * THE IN-PROCESS WIRING (AI evaluation harness): everything the runner needs
 * from the Studio, given the turn handler and the sandbox meter. Used by the CLI
 * (`scripts/eval-ai.mjs`, which loads the real route in plain Node) and by the
 * /platform admin run (inside Next) — one wiring, so both drive the same
 * pipeline the same way.
 */

/** a survey of one block built from question specs, as E3's production-intents test builds its corpus survey */
export function surveyFromSpec(spec: readonly { ref: string; type: string; text: string; options?: string[] }[]): SurveyDefinition {
  const empty = SurveyDefinition.parse({ meta: { id: "eval-spec", code: "EVAL", title: "Production intents" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
  let n = 0;
  const a = applySurveyActions(empty, [{ op: "create_block", title: "Main" }, ...spec.map((q) => ({ op: "create_question", ref: q.ref, type: q.type, text: q.text, ...(q.options ? { options: q.options } : {}) }))] as never, { ids: (p: string) => `${p}_${++n}` });
  if (!a.valid) throw new Error(`the fixture survey does not build: ${a.errors.slice(0, 3).join("; ")}`);
  return a.def;
}

export function fixtureOf(key: string, spec?: readonly { ref: string; type: string; text: string; options?: string[] }[]): SurveyDefinition {
  if (key === "spec") { if (!spec?.length) throw new Error("fixture \"spec\" needs the case's fixtureSpec"); return surveyFromSpec(spec); }
  if (key === "blank") return newSurveyDefinition("eval-blank", "EVAL", "Evaluation survey");
  const t = SURVEY_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`unknown fixture ${key}; one of blank, ${SURVEY_TEMPLATES.map((x) => x.key).join(", ")}`);
  return t.build(`eval-${key}`);
}

export const riskRules: RiskRules = {
  highRisk: (def, actions) => highRiskActions(def as SurveyDefinition, actions as SurveyAction[]).map((h) => ({ kind: h.kind, op: h.op, why: h.why })),
  asked: (kind, text) => researcherAsked(kind as HighRiskKind, text),
};

export function injectInto(def: unknown, target: string, text: string): unknown {
  const d = structuredClone(def) as SurveyDefinition;
  const q = getQuestionByCodeOrVar(d, target);
  if (q) (q as { text?: string }).text = `${(q as { text?: string }).text ?? ""}\n\n${text}`;
  return d;
}

/** the sandbox meter's usage list, as the runner reads it */
export interface UsageStore { usage: UsageLike[] }

export function inProcessDeps(o: {
  /** call the turn handler with a request carrying this body (and, streamed, the NDJSON accept header) */
  call(body: Record<string, unknown>, headers: Record<string, string>): Promise<Response>;
  store: () => UsageStore;
  fake: boolean;
  stream?: boolean;
}): RunnerDeps {
  return {
    post: (body, { stream }) => o.call(body, { "content-type": "application/json", ...(stream ? { accept: `${NDJSON}, application/json` } : {}) }),
    read: async (res) => { const r = await readTurnResponse(res); return { status: r.status, d: r.d, streamed: r.streamed }; },
    mark: () => o.store().usage.length,
    usageSince: (m) => o.store().usage.slice(m),
    fixture: fixtureOf,
    apply: (def, actions) => { const a = applySurveyActions(def as SurveyDefinition, actions as SurveyAction[]); return { def: a.def, valid: a.valid }; },
    memoryFrom: (turns) => memoryFrom(turns.map((t) => ({ user: t.user, reply: (t.reply && typeof t.reply === "object" && Array.isArray((t.reply as { actions?: unknown }).actions) ? t.reply : null) as CopilotReply | null }))),
    inject: injectInto,
    risk: riskRules,
    fake: o.fake,
    stream: o.stream,
  };
}
