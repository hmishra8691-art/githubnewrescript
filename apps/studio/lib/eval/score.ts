import type { EvalTurn, ReplyLanguage, TurnExpect } from "./cases.ts";

/**
 * SCORING ONE TURN (AI evaluation harness). Pure: the turn's expectations, what
 * the route answered and what the meter recorded in, a list of named checks
 * out. Nothing here knows which provider answered.
 */

/** one metered model call of a turn, from the usage event the meter wrote */
export interface CallMetric {
  operation: string;
  model: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** HTTP requests inside the logical call (continuations, the JSON re-ask): 1 = parsed at the first answer */
  requests: number;
  providerCostUsd: number;
  chargeUsd: number;
  latencyMs: number;
  /** the user's own provider answered (BYOK) */
  byok?: boolean;
}

export interface TurnOutcome {
  status: number;
  body: Record<string, unknown> | null;
  latencyMs: number;
  calls: CallMetric[];
  /** the route answered as an NDJSON stream */
  streamed?: boolean;
  /** a transport or harness error (no JSON answer) */
  error?: string;
}

export interface Check { name: string; ok: boolean; detail?: string }

/** the gate's high-risk detector and its "did the researcher ask for it" rule — @rescript/engine's provenance module, injected */
export interface RiskRules {
  highRisk(def: unknown, actions: readonly unknown[]): { kind: string; op: string; why: string }[];
  asked(kind: string, researcherText: string): boolean;
}

/* ------------------------------------------------------------ what a response says */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

export interface TurnFacts {
  replyText: string;
  kind: string | null;
  actions: Record<string, unknown>[];
  ops: string[];
  applied: number;
  refused: number;
  valid: boolean | null;
  modelCalled: boolean;
  mode: string | null;
  scope: string | null;
  stage: string;
  planItems: number;
  repairRan: boolean;
  repaired: boolean;
  /** every call parsed at its first answer (requests ≤ 1) */
  oneShotParse: boolean;
  clarify: boolean;
}

export function factsOf(out: TurnOutcome): TurnFacts {
  const b = obj(out.body);
  const reply = obj(b.reply);
  const ctx = obj(b.context);
  const actions = Array.isArray(reply.actions) ? (reply.actions as unknown[]).map(obj) : [];
  const results = Array.isArray(obj(b.validation).results) ? (obj(b.validation).results as unknown[]).map(obj) : [];
  const repair = b.context && ctx.repair ? obj(ctx.repair) : null;
  const ctxCalls = Array.isArray(ctx.calls) ? ctx.calls.length : 0;
  const plan = obj(b.plan);
  const kind = typeof reply.kind === "string" ? reply.kind : null;
  const replyText = typeof reply.reply === "string" ? reply.reply : typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : "";
  return {
    replyText, kind, actions, ops: actions.map((a) => String(a.op ?? "")),
    applied: results.filter((r) => r.ok === true).length, refused: results.filter((r) => r.ok === false).length,
    valid: b.validation && typeof obj(b.validation).valid === "boolean" ? obj(b.validation).valid as boolean : null,
    modelCalled: ctx.modelCalled === false ? false : out.calls.length > 0 || ctxCalls > 0,
    mode: typeof ctx.mode === "string" ? ctx.mode : null, scope: typeof ctx.scope === "string" ? ctx.scope : null,
    stage: typeof b.stage === "string" ? b.stage : "none",
    planItems: Array.isArray(plan.items) ? plan.items.length : 0,
    repairRan: !!repair && repair.skipped !== "policy", repaired: !!repair && repair.fixed === true,
    oneShotParse: out.calls.every((c) => c.requests <= 1),
    clarify: kind === "clarify",
  };
}

/** the names an action points at: its target, source, destinations, code, ref, the question it is placed after */
export function actionTargets(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) out.push(v.trim()); else if (Array.isArray(v)) v.forEach(push); else if (v && typeof v === "object") { const o = v as Record<string, unknown>; push(o.question ?? o.code ?? o.id); } };
  for (const k of ["target", "from", "to", "code", "ref", "name", "source", "destinations", "question", "rows", "columns", "after", "language"]) push(a[k]);
  return out;
}
const touches = (names: string[], want: string) => names.some((n) => n === want || n.startsWith(`${want}.`) || n.startsWith(`${want}:`) || n.toUpperCase() === want.toUpperCase());

/* ------------------------------------------------------------ language and claims */

const HINGLISH = /\b(?:hai|hain|karo|kar|karna|nahi|nahin|aap|aapka|ka|ki|ko|ke|se|pe|par|rahega|rahegi|dikhega|dikhegi|lag|gayi|gaya|theek|thik|mein|kya|aur|bhi|hoga|diya|dijiye|wala|wali)\b/gi;
const MARATHI = /आहे|आहेत|केले|केली|करा|जोडली|जोडले|च्या|मध्ये|नाही|आणि|तुम्ही|झाले|आता/g;
const HINDI = /है|हैं|गया|गई|दिया|दी गई|करें|में|और|नहीं|आप|कर दिया|जोड़/g;

/** the language a reply is written in, by script and a few function words (codes like Q5 and quoted labels do not decide it) */
export function detectLanguage(text: string): ReplyLanguage {
  const t = String(text ?? "").replace(/\b[A-Z]{1,6}\d+[A-Z0-9_.:]*\b/g, " ");
  const deva = (t.match(/[ऀ-ॿ]/g) ?? []).length;
  const arab = (t.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  const letters = deva + arab + latin || 1;
  if (arab / letters > 0.3) return "ur";
  if (deva / letters > 0.3) return (t.match(MARATHI) ?? []).length > (t.match(HINDI) ?? []).length ? "mr" : "hi";
  const words = (t.match(/[A-Za-z]+/g) ?? []).length || 1;
  const markers = new Set((t.match(HINGLISH) ?? []).map((w) => w.toLowerCase()));
  return markers.size >= 3 && markers.size / words >= 0.08 ? "hinglish" : "en";
}

/** "I've attached the file", "download the PDF", "here is your Excel" — a file the copilot never produces in a turn */
const FILE_CLAIM = /\b(?:i(?:'ve| have)?\s+(?:attached|uploaded|exported|saved)\b|(?:i(?:'ve| have)?\s+)?(?:created|generated|prepared)\s+(?:a|an|the|your)\s+(?:pdf|excel|spreadsheet|csv|xlsx|docx|word|pptx|powerpoint|zip)\b(?:\s+file)?|(?:see|find|open)\s+the\s+attach(?:ed|ment)|download\s+(?:it|the\s+(?:file|attachment|pdf|spreadsheet|report))|here\s+is\s+(?:the|your)\s+(?:pdf|excel|csv|file|spreadsheet|download)|attached\s+(?:is|are|file|document|pdf))\b|फ़ाइल संलग्न|फाइल संलग्न|डाउनलोड कर/i;
export function claimsAFile(text: string): boolean { return FILE_CLAIM.test(String(text ?? "")); }

/* ------------------------------------------------------------ the checks */

const anyOf = (want: string | string[] | undefined, got: string | null) => want === undefined || (Array.isArray(want) ? want.includes(String(got)) : want === got);

export function scoreTurn(turn: EvalTurn, out: TurnOutcome, ctx: { defBefore: unknown; risk?: RiskRules }): { checks: Check[]; facts: TurnFacts } {
  const e: TurnExpect = turn.expect ?? {};
  const f = factsOf(out);
  const checks: Check[] = [];
  const c = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(ok || !detail ? {} : { detail }) });
  const want = e.status ?? 200;
  c("status", out.status === want, `HTTP ${out.status}${out.error ? ` (${out.error})` : ""}, expected ${want}`);
  if (e.modelCalled !== undefined) c("model_called", f.modelCalled === e.modelCalled, `model ${f.modelCalled ? "was" : "was not"} called`);
  if (e.mode !== undefined) c("mode", anyOf(e.mode, f.mode), `mode ${f.mode}, expected ${[e.mode].flat().join("|")}`);
  if (e.scope !== undefined) c("scope", f.scope === e.scope, `scope ${f.scope}, expected ${e.scope}`);
  if (e.kind !== undefined) c("kind", anyOf(e.kind, f.kind), `reply kind ${f.kind}, expected ${[e.kind].flat().join("|")}`);
  if (e.stage !== undefined) c("stage", f.stage === e.stage, `stage ${f.stage}, expected ${e.stage}`);
  for (const op of e.opsPresent ?? []) c(`op_present:${op}`, f.ops.includes(op), `no ${op} in [${f.ops.join(", ")}]`);
  for (const op of e.opsAbsent ?? []) c(`op_absent:${op}`, !f.ops.includes(op), `${op} was proposed`);
  if (e.targets?.length) {
    const names = f.actions.flatMap(actionTargets);
    for (const t of e.targets) c(`target:${t}`, touches(names, t), `nothing targets ${t} (targets: ${[...new Set(names)].slice(0, 12).join(", ")})`);
  }
  if (e.appliedMin !== undefined) c("applied_min", f.applied >= e.appliedMin, `${f.applied} applied (${f.refused} refused), expected ≥ ${e.appliedMin}`);
  if (e.appliedExactly !== undefined) c("applied_exactly", f.applied === e.appliedExactly, `${f.applied} applied, expected ${e.appliedExactly}`);
  if (e.valid !== undefined) c("valid", f.valid === e.valid, `validation.valid = ${f.valid}`);
  if (e.planItemsMin !== undefined) c("plan_items", f.planItems >= e.planItemsMin, `${f.planItems} plan items, expected ≥ ${e.planItemsMin}`);
  if (e.clarify === "forbidden") c("no_clarify", !f.clarify, "asked a question instead of acting");
  if (e.clarify === "required") c("clarify", f.clarify, "did not ask");
  if (e.parse === "clean") c("parse_clean", f.oneShotParse && !f.repairRan, f.repairRan ? "needed the repair pass" : "a call needed a continuation or a re-ask");
  if (e.parse === "repaired") c("parse_repaired", f.repairRan && f.repaired, f.repairRan ? "the repair pass did not fix it" : "no repair pass ran");
  if (e.context) {
    const got = obj(obj(out.body).context);
    for (const [k, v] of Object.entries(e.context)) c(`context:${k}`, typeof v === "boolean" ? !!got[k] === v : got[k] === v, `context.${k} = ${JSON.stringify(got[k])}, expected ${JSON.stringify(v)}`);
  }
  if (e.itemGuides || e.guideMisses !== undefined || e.methodFixesMin !== undefined) {
    const got = obj(obj(out.body).context);
    const per = obj(got.itemGuides);
    for (const [id, want] of Object.entries(e.itemGuides ?? {})) {
      const sentTo = Array.isArray(obj(per[id]).guides) ? (obj(per[id]).guides as unknown[]).map(String) : null;
      for (const g of want.has ?? []) c(`item_guide:${id}+${g}`, !!sentTo?.includes(g), sentTo ? `item ${id} was sent [${sentTo.join(", ")}], not ${g}` : `no guides reported for item ${id}`);
      for (const g of want.not ?? []) c(`item_guide:${id}-${g}`, !!sentTo && !sentTo.includes(g), sentTo ? `item ${id} was sent ${g} (it needs only [${sentTo.join(", ")}])` : `no guides reported for item ${id}`);
    }
    const misses = Array.isArray(got.guideMisses) ? got.guideMisses.length : 0;
    if (e.guideMisses !== undefined) c("guide_misses", misses === e.guideMisses, `${misses} item(s) proposed an action whose guide was not sent, expected ${e.guideMisses}`);
    const fixes = Array.isArray(got.methodFixes) ? got.methodFixes.length : 0;
    if (e.methodFixesMin !== undefined) c("method_fixes", fixes >= e.methodFixesMin, `${fixes} design correction(s) by the Studio, expected ≥ ${e.methodFixesMin}`);
  }
  if (e.noHighRisk !== false && ctx.risk && f.actions.length) {
    const found = ctx.risk.highRisk(ctx.defBefore, f.actions).filter((h) => !ctx.risk!.asked(h.kind, turn.message));
    c("no_high_risk", !found.length, found.map((h) => `${h.op}: ${h.why}`).join("; "));
  }
  for (const re of e.replyMatches ?? []) c(`reply_matches:${re}`, new RegExp(re, "i").test(f.replyText), `reply: ${f.replyText.slice(0, 160)}`);
  for (const re of e.replyNotMatches ?? []) c(`reply_not_matches:${re}`, !new RegExp(re, "i").test(f.replyText), `reply: ${f.replyText.slice(0, 160)}`);
  if (e.noFileClaim !== false && f.replyText) c("no_file_claim", !claimsAFile(f.replyText), `reply claims a file: ${f.replyText.slice(0, 160)}`);
  if (e.language && f.replyText) { const got = detectLanguage(f.replyText); c("language", got === e.language, `reply is ${got}, expected ${e.language}`); }
  return { checks, facts: f };
}
