import type { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, describeAction, diffSurveys, SURVEY_ACTION_OPS, type SurveyAction } from "./surveyActions.js";

/**
 * THE TOOL REGISTRY (audit 2026-11-17, P3-01) — every engine action as a typed tool an agent (or a person, or a
 * script) can call, under one set of rules:
 *
 *   RISK       what the call can change: read · draft (the editable questionnaire) · destructive_draft (removes or
 *              rewrites draft content) · data (response data) · destructive_data (irreversible erasure) · publish
 *              (what respondents see) · external (sends something out of the platform) · spend (metered: AI, panel)
 *   APPROVAL   what a person must do before it runs: none (reads only) · confirm (one click after seeing the dry
 *              run) · explicit (the person reads the impact and confirms it — publish, data, external, spend,
 *              anything destructive). The dry run can only RAISE the level: a draft change that turns out to remove
 *              content is explicit.
 *   DRY RUN    every questionnaire tool can be run against a copy: the outcome (what it would do, in words), the
 *              diff, what it destroys, whether the result is still a valid survey — and nothing is written.
 *   AUDIT      every call — dry run, refusal, approval, execution — produces a `ToolCallRecord` the caller stores.
 *
 * Questionnaire tools are generated from SURVEY_ACTION_OPS (one tool per op, named `survey.<op>`), so an op added
 * to the action layer is a tool at once and the contract test fails if it is not classified. Tools whose engine
 * lives behind a Studio route (analytics, quality, data, deployment, translation, recruitment) are declared with
 * that route, their parameters and their policy.
 *
 * The registry is the boundary the audit asks for "before any autonomous step": nothing here lets a model act
 * without the dry run and the approval its risk demands, and nothing happens without a record.
 */

export type ToolRisk = "read" | "draft" | "destructive_draft" | "data" | "destructive_data" | "publish" | "external" | "spend";
export type ToolApproval = "none" | "confirm" | "explicit";
export type ToolEngine = "survey" | "analytics" | "quality" | "data" | "deployment" | "translation" | "recruitment";
export interface ToolParam { name: string; type: "string" | "number" | "boolean" | "object" | "array"; required?: boolean; description: string }
export interface ToolSpec {
  name: string;
  engine: ToolEngine;
  summary: string;
  risk: ToolRisk;
  approval: ToolApproval;
  /** can the effect be undone from inside the platform (draft history, a restore, a re-run)? */
  reversible: boolean;
  /** survey_action: run through applySurveyActions (dry run available); route: a Studio endpoint */
  executor: "survey_action" | "route";
  op?: string;
  route?: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string };
  /** the project capability the caller needs (the same check the route makes) */
  capability: string;
  params: ToolParam[];
}

const APPROVAL_FOR: Record<ToolRisk, ToolApproval> = {
  read: "none", draft: "confirm", destructive_draft: "explicit", data: "explicit", destructive_data: "explicit", publish: "explicit", external: "explicit", spend: "explicit",
};
const RANK: Record<ToolApproval, number> = { none: 0, confirm: 1, explicit: 2 };

/** how a questionnaire op is classified; every op must land somewhere (the contract test enumerates them) */
export function surveyOpRisk(op: string): ToolRisk {
  if (/^(?:delete|remove|clear|disconnect)_/.test(op)) return "destructive_draft";
  if (/^(?:connect_panel|add_vendor|configure_alerts)$/.test(op)) return "external";
  if (/^simulate_/.test(op)) return "read";
  return "draft";
}

const SURVEY_TOOLS: ToolSpec[] = SURVEY_ACTION_OPS.map((op) => {
  const risk = surveyOpRisk(op);
  return {
    name: `survey.${op}`, engine: "survey", op, executor: "survey_action", risk, approval: APPROVAL_FOR[risk],
    reversible: true, /* every draft change is in the draft's history and can be restored */
    summary: `Questionnaire action ${op.replace(/_/g, " ")} (the copilot's action; input is the action without "op")`,
    capability: "survey.edit",
    params: [{ name: "…", type: "object", required: true, description: `the fields of the ${op} action, as the action layer reads them (coerceSurveyActions is the contract)` }],
  };
});

const ROUTE_TOOLS: ToolSpec[] = [
  { name: "analytics.run", engine: "analytics", summary: "Compute one analysis (crosstab, test, model, NPS …) on the dataset", risk: "read", approval: "none", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/analytics/run" }, capability: "analytics.read", params: [{ name: "definition", type: "object", required: true, description: "an AnalysisDefinition: kind, variables, dataset, options" }] },
  { name: "analytics.plan_apply", engine: "analytics", summary: "Save the analysis plan's items as analyses and run them", risk: "draft", approval: "confirm", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/analytics/plan/apply" }, capability: "analytics.edit", params: [{ name: "items", type: "array", description: "plan item ids (all when absent)" }] },
  { name: "analytics.model_start", engine: "analytics", summary: "Start a chunked model run (HB, latent class, SEM)", risk: "read", approval: "confirm", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/analytics/models" }, capability: "analytics.read", params: [{ name: "definition", type: "object", required: true, description: "the model's AnalysisDefinition" }] },
  { name: "quality.recompute", engine: "quality", summary: "Re-assess every finished response with the current quality settings", risk: "data", approval: "explicit", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/quality/recompute" }, capability: "responses.manage", params: [{ name: "include", type: "string", description: "live (default) | test | all" }] },
  { name: "quality.review", engine: "quality", summary: "Mark responses keep / remove / review later, with a reason", risk: "data", approval: "explicit", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/quality/bulk" }, capability: "responses.manage", params: [{ name: "sessionIds", type: "array", required: true, description: "the responses" }, { name: "decision", type: "string", required: true, description: "KEEP | REMOVE | REVIEW_LATER" }, { name: "reason", type: "string", required: true, description: "why" }] },
  { name: "data.export", engine: "data", summary: "Export response data (CSV, Excel, SPSS, SAS, Stata, JSON)", risk: "external", approval: "explicit", reversible: false, executor: "route", route: { method: "GET", path: "/api/surveys/{id}/responses" }, capability: "responses.export", params: [{ name: "format", type: "string", required: true, description: "csv | xlsx | sav | sas | dta | json" }, { name: "dataset", type: "string", description: "all | clean" }] },
  { name: "data.delete", engine: "data", summary: "Move responses to the recycle bin (restorable)", risk: "data", approval: "explicit", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/data/delete" }, capability: "responses.manage", params: [{ name: "ids", type: "array", required: true, description: "response ids" }, { name: "reason", type: "string", required: true, description: "why" }] },
  { name: "data.erase_person", engine: "data", summary: "Erase one respondent everywhere in the project (data-subject request)", risk: "destructive_data", approval: "explicit", reversible: false, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/erasure" }, capability: "responses.manage", params: [{ name: "identifier", type: "object", required: true, description: "{ kind: email | respondent_code | panel_id | session_id, value }" }] },
  { name: "deployment.save_version", engine: "deployment", summary: "Save the draft as a new numbered version (what a deployment can serve)", risk: "draft", approval: "confirm", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/versions" }, capability: "survey.save_version", params: [{ name: "note", type: "string", description: "the version's note" }] },
  { name: "deployment.deploy_version", engine: "deployment", summary: "Put a version on the live or test link respondents open", risk: "publish", approval: "explicit", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/deploy" }, capability: "deploy.manage", params: [{ name: "versionId", type: "string", required: true, description: "the version" }, { name: "mode", type: "string", required: true, description: "live | test" }, { name: "clientSlug", type: "string", required: true, description: "the link's client part" }, { name: "studySlug", type: "string", required: true, description: "the link's study part" }] },
  { name: "translation.translate", engine: "translation", summary: "Machine-translate survey strings (metered)", risk: "spend", approval: "explicit", reversible: true, executor: "route", route: { method: "POST", path: "/api/ai/translate" }, capability: "survey.edit", params: [{ name: "targetLanguage", type: "string", required: true, description: "BCP-47" }, { name: "items", type: "array", required: true, description: "[{ key, text }]" }] },
  { name: "translation.back_check", engine: "translation", summary: "Back-translate and compare meaning (metered)", risk: "spend", approval: "explicit", reversible: true, executor: "route", route: { method: "POST", path: "/api/ai/back-translate" }, capability: "survey.edit", params: [{ name: "targetLanguage", type: "string", required: true, description: "BCP-47" }, { name: "items", type: "array", required: true, description: "[{ key, source, translation }]" }] },
  { name: "recruitment.plan", engine: "recruitment", summary: "Plan sample across vendors: feasibility, cost, allocation (no order placed)", risk: "read", approval: "none", reversible: true, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/recruitment" }, capability: "deploy.manage", params: [{ name: "action", type: "string", required: true, description: "plan | compare | markets" }] },
  { name: "recruitment.order", engine: "recruitment", summary: "Place or change a sample order with a vendor (spends money)", risk: "spend", approval: "explicit", reversible: false, executor: "route", route: { method: "POST", path: "/api/surveys/{id}/recruitment" }, capability: "deploy.manage", params: [{ name: "action", type: "string", required: true, description: "authorize | order | reallocate" }] },
];

export const TOOLS: readonly ToolSpec[] = [...SURVEY_TOOLS, ...ROUTE_TOOLS];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const toolByName = (name: string): ToolSpec | null => BY_NAME.get(name) ?? null;

/* ---------------------------------------------------------------- dry run */

export interface ToolDryRun {
  ok: boolean;
  tool: string;
  /** the action as the layer read it (after coercion), when it could be read */
  action?: SurveyAction;
  refused?: string;
  /** what it would do, in words */
  description: string[];
  /** what it would remove or rewrite */
  destructive: string[];
  warnings: string[];
  diff: { added: number; removed: number; changed: number; summary: string[] };
  /** would the result still be a valid survey? */
  valid: boolean;
  /** the approval this call needs, after seeing what it does */
  approval: ToolApproval;
  /** the survey after the call — only for the executor, never stored by a dry run */
  after?: SurveyDefinition;
}

/** run a questionnaire tool against a copy of the survey: nothing is written */
export function dryRunTool(def: SurveyDefinition, name: string, input: unknown): ToolDryRun {
  const tool = toolByName(name);
  const empty = { description: [], destructive: [], warnings: [], diff: { added: 0, removed: 0, changed: 0, summary: [] }, valid: false };
  if (!tool) return { ok: false, tool: name, refused: `There is no tool called ${name}.`, approval: "explicit", ...empty };
  if (tool.executor !== "survey_action") return { ok: false, tool: name, refused: `${name} runs through ${tool.route?.method} ${tool.route?.path}; it has no dry run here.`, approval: tool.approval, ...empty };
  const raw = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>), op: tool.op } : null;
  if (!raw) return { ok: false, tool: name, refused: "The input must be an object with the action's fields.", approval: tool.approval, ...empty };
  const { actions, rejected } = coerceSurveyActions([raw], 1);
  if (!actions.length) return { ok: false, tool: name, refused: rejected[0]?.reason ?? "The action could not be read.", approval: tool.approval, ...empty };
  const out = applySurveyActions(def, actions);
  const r = out.results[0];
  const d = diffSurveys(def, out.def);
  const removed = d.questionsRemoved.length + d.blocksRemoved.length, added = d.questionsAdded.length + d.blocksAdded.length, changed = d.questionsModified.length + d.questionsMoved.length + d.blocksRenamed.length;
  const destructive = [...out.destructive, ...(r?.destructive ? [r.destructive] : [])].filter((x, i, a) => a.indexOf(x) === i);
  let approval = tool.approval;
  if (destructive.length && RANK[approval] < RANK.explicit) approval = "explicit";
  return {
    ok: !!r?.ok && out.valid, tool: name, action: actions[0],
    ...(r && !r.ok ? { refused: r.error ?? out.errors.join(" ") } : !out.valid ? { refused: "The result would not be a valid survey, so it is refused." } : {}),
    description: r ? [r.description || describeAction(actions[0])] : [describeAction(actions[0])],
    destructive, warnings: out.warnings.slice(0, 20),
    diff: { added, removed, changed, summary: d.summary.slice(0, 30) },
    valid: out.valid, approval, after: out.valid ? out.def : undefined,
  };
}

/* ---------------------------------------------------------------- approval + record */

export interface ToolApprovalGiven { by: string; level: ToolApproval; at: string; /** for explicit: the impact the person confirmed, in their words or as shown */ acknowledged?: string }

/** may this call run, given what the person approved? */
export function approvalSatisfied(required: ToolApproval, given: ToolApprovalGiven | null | undefined): { ok: boolean; reason?: string } {
  if (required === "none") return { ok: true };
  if (!given) return { ok: false, reason: required === "confirm" ? "A person must confirm this after seeing the dry run." : "A person must read the impact and confirm it explicitly." };
  if (RANK[given.level] < RANK[required]) return { ok: false, reason: `This needs ${required} approval; ${given.level} was given.` };
  if (required === "explicit" && !given.acknowledged?.trim()) return { ok: false, reason: "An explicit approval must say what was acknowledged." };
  return { ok: true };
}

export interface ToolCallRecord {
  tool: string;
  engine: ToolEngine;
  risk: ToolRisk;
  phase: "dry_run" | "refused" | "executed" | "failed";
  /** who asked: a person, or an agent acting for one */
  caller: { kind: "person" | "agent"; userId: string; agent?: string };
  approval: ToolApprovalGiven | null;
  /** a stable hash of the input, and the input itself when it carries no personal data (questionnaire actions) */
  inputHash: string;
  input?: unknown;
  outcome: { ok: boolean; description: string[]; destructive: string[]; refused?: string; diff?: ToolDryRun["diff"] };
  at: string;
}

/** a 64-bit FNV-1a of the canonical input: the same call, the same hash */
export function inputHash(input: unknown): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  const s = JSON.stringify(canon(input) ?? null);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0; }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function toolCallRecord(tool: ToolSpec, phase: ToolCallRecord["phase"], caller: ToolCallRecord["caller"], input: unknown, outcome: ToolCallRecord["outcome"], approval: ToolApprovalGiven | null = null, now = new Date().toISOString()): ToolCallRecord {
  return {
    tool: tool.name, engine: tool.engine, risk: tool.risk, phase, caller, approval, inputHash: inputHash(input),
    /* questionnaire actions are wording and structure, not personal data; route tools may carry identifiers (an email to erase), so only the hash is kept */
    ...(tool.executor === "survey_action" ? { input } : {}),
    outcome, at: now,
  };
}
