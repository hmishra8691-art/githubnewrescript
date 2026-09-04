import type { QualityConfig, QualityClass, Severity, Strictness, SurveyDefinition } from "@rescript/schema";
import { QualityConfig as QualityConfigSchema } from "@rescript/schema";
import { evaluateCondition } from "@rescript/engine";
import type {
  Benchmarks, FlagDraft, HistoryRecord, PeerRecord, QualityAssessment, QualityInput, ResponseRecord, ResponseTelemetry,
  RuleContext, SystemVars,
} from "./types.js";
import { RULE_BY_ID } from "./catalogue.js";
import { computeBenchmarks, pageSeconds, questionSeconds, totalBenchmark, totalSeconds } from "./benchmarks.js";
import { timingRules } from "./rules/timing.js";
import { matrixRules, matrixSignature } from "./rules/matrix.js";
import { patternRules } from "./rules/pattern.js";
import { attentionRules, attentionResult, consistencyRules, stateFor } from "./rules/attention.js";
import { openEndRules, openEndHash, openEnds } from "./rules/openEnd.js";
import { behaviourRules, navigationFingerprint } from "./rules/behaviour.js";
import { similarityRules, clusterSurvey } from "./similarity.js";
import { categoryScores, classify, CLASS_ORDER, finalizeFlags, qualityScore, reasons, recommendation, riskScore } from "./score.js";
import { isMatrix } from "./survey.js";

/**
 * The engine: one response in, one assessment out.
 *
 *   resolve config (strictness preset + overrides)
 *     → benchmarks from peers (or the definition's estimate)
 *     → built-in rules, by category, each returning explained drafts
 *     → similarity vs peers (duplicates, clusters)
 *     → SYSTEM_* variables (also what custom rules test against)
 *     → custom rules (ordinary Conditions over calc.SYSTEM_*)
 *     → points, scores, classification, reasons
 *
 * Pure: no I/O. The runtime save route and the Studio recompute both call
 * `assess()`; `assessSurvey()` runs it for every response of a survey with
 * final cluster ids.
 */

export function resolveConfig(def: SurveyDefinition): QualityConfig {
  return QualityConfigSchema.parse(def.quality ?? {});
}

function presetLevel(s: Strictness): Exclude<Strictness, "custom"> {
  return s === "custom" ? "standard" : s;
}

export function makeContext(input: QualityInput, config: QualityConfig, bench: Benchmarks): RuleContext {
  const level = presetLevel(config.strictness);
  const telemetry = input.response.telemetry ?? null;
  const disabled = new Set<string>(telemetry?.disabled ?? []);
  for (const [k, v] of Object.entries(config.telemetry)) if (v === false) disabled.add(k);
  if (!telemetry) for (const k of ["timing", "focus", "clipboard", "navigation", "interaction", "device"]) disabled.add(k);
  return {
    def: input.def, config, strictness: config.strictness,
    response: input.response, telemetry, peers: input.peers, history: input.history ?? [], bench,
    now: input.now ?? Date.now(),
    param<T = number>(ruleId: string, key: string): T {
      const override = config.rules[ruleId]?.params?.[key];
      if (override !== undefined) return override as unknown as T;
      const def = RULE_BY_ID[ruleId]?.params.find((p) => p.key === key);
      return (def?.defaults[level] ?? 0) as unknown as T;
    },
    severity(ruleId: string): Severity {
      return config.rules[ruleId]?.severity ?? RULE_BY_ID[ruleId]?.defaultSeverity ?? "medium";
    },
    enabled(ruleId: string): boolean {
      const rule = RULE_BY_ID[ruleId];
      if (!rule) return false;
      const setting = config.rules[ruleId];
      const on = setting?.enabled ?? rule.enabledIn[level];
      if (!on) return false;
      // a rule that needs telemetry the survey does not record is skipped, never failed
      for (const need of rule.needs ?? []) {
        if (need === "peers") continue;
        if (disabled.has(need)) return false;
      }
      return true;
    },
    applies(ruleId: string, questionId: string): boolean {
      const ids = config.rules[ruleId]?.questionIds;
      return !ids?.length || ids.includes(questionId);
    },
    disabledTelemetry: disabled,
  };
}

/** The SYSTEM_* record, before scores are known. */
function systemVars(ctx: RuleContext, t: ResponseTelemetry | null, bench: Benchmarks): SystemVars {
  const r = ctx.response;
  const total = totalSeconds(t, r.startedAt, r.completedAt);
  const tb = totalBenchmark(bench);
  const ps = pageSeconds(t);
  const qs = questionSeconds(t);
  const matrixTime: Record<string, number> = {};
  const matrixSig: Record<string, string> = {};
  for (const q of ctx.def.questions) {
    if (!isMatrix(q)) continue;
    if (qs[q.id] !== undefined) matrixTime[q.id] = Math.round(qs[q.id] * 10) / 10;
    const sig = matrixSignature(q, r.answers[q.id]);
    if (sig) matrixSig[q.id] = sig;
  }
  const oeHashes: Record<string, string> = {};
  for (const e of openEnds(ctx.def.questions, r.answers)) { const h = openEndHash(e.text); if (h) oeHashes[e.q.id] = h; }
  let passed = 0, failed = 0;
  for (const q of ctx.def.questions) {
    if (!q.attentionCheck) continue;
    const res = attentionResult(q, r.answers);
    if (res) { if (res.passed) passed++; else failed++; }
  }
  const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  const d = t?.device;
  return {
    SYSTEM_RESPONSE_ID: r.sessionId,
    SYSTEM_SESSION_ID: r.sessionId,
    SYSTEM_START_TIMESTAMP: r.startedAt,
    SYSTEM_END_TIMESTAMP: r.completedAt,
    SYSTEM_TOTAL_DURATION: total === null ? null : Math.round(total),
    SYSTEM_MEDIAN_DURATION: tb.seconds ? Math.round(tb.seconds) : null,
    SYSTEM_DURATION_RATIO: total !== null && tb.seconds ? Math.round((total / tb.seconds) * 100) / 100 : null,
    SYSTEM_TAB_SWITCH_COUNT: t && !ctx.disabledTelemetry.has("focus") ? t.focus.blurs : null,
    SYSTEM_TOTAL_OUT_OF_FOCUS_TIME: t && !ctx.disabledTelemetry.has("focus") ? Math.round(t.focus.totalOutOfFocusMs / 1000) : null,
    SYSTEM_COPY_COUNT: t && !ctx.disabledTelemetry.has("clipboard") ? t.clipboard.copies : null,
    SYSTEM_PASTE_COUNT: t && !ctx.disabledTelemetry.has("clipboard") ? t.clipboard.pastes : null,
    SYSTEM_PASTE_CHARS: t && !ctx.disabledTelemetry.has("clipboard") ? t.clipboard.pasteChars : null,
    SYSTEM_PAGE_TIME: round(ps),
    SYSTEM_QUESTION_TIME: round(qs),
    SYSTEM_MATRIX_TIME: matrixTime,
    SYSTEM_BACK_COUNT: t && !ctx.disabledTelemetry.has("navigation") ? t.navigation.back : null,
    SYSTEM_RELOAD_COUNT: t && !ctx.disabledTelemetry.has("navigation") ? t.navigation.reloads : null,
    SYSTEM_NAV_FINGERPRINT: ctx.disabledTelemetry.has("navigation") ? null : navigationFingerprint(t),
    SYSTEM_DEVICE_TYPE: d?.type ?? null,
    SYSTEM_BROWSER: d?.browser ?? null,
    SYSTEM_OS: d?.os ?? null,
    SYSTEM_SCREEN_SIZE: d?.screen ?? null,
    SYSTEM_TIMEZONE: d?.timezone ?? null,
    SYSTEM_LOCALE: d?.locale ?? null,
    SYSTEM_DEVICE_HASH: r.deviceHash ?? null,
    SYSTEM_IP_HASH: r.ipHash ?? null,
    SYSTEM_NETWORK_RISK: typeof (r.calculated as any)?.SYSTEM_NETWORK_RISK === "number" ? (r.calculated as any).SYSTEM_NETWORK_RISK : null,
    SYSTEM_MATRIX_SIGNATURE: matrixSig,
    SYSTEM_OPENEND_HASHES: oeHashes,
    SYSTEM_ANSWER_SIGNATURE: null,
    SYSTEM_ATTENTION_FAILED: failed,
    SYSTEM_ATTENTION_PASSED: passed,
    SYSTEM_SPEEDER_SCORE: 0, SYSTEM_STRAIGHTLINE_SCORE: 0, SYSTEM_ATTENTION_SCORE: 0, SYSTEM_CONSISTENCY_SCORE: 0,
    SYSTEM_OPENEND_SCORE: 0, SYSTEM_NAVIGATION_SCORE: 0, SYSTEM_BOT_SCORE: 0, SYSTEM_DUPLICATE_SCORE: 0,
    SYSTEM_PATTERN_SCORE: 0, SYSTEM_CLUSTER_SCORE: 0, SYSTEM_DEVICE_SCORE: 0, SYSTEM_INTERACTION_SCORE: 0, SYSTEM_SCREENER_SCORE: 0,
    SYSTEM_QUALITY_SCORE: 100, SYSTEM_FRAUD_RISK_SCORE: 0, SYSTEM_QUALITY_STATUS: "CLEAN",
    SYSTEM_SIMILARITY_SCORE: null, SYSTEM_SIMILAR_RESPONDENT_IDS: [], SYSTEM_CLUSTER_ID: null, SYSTEM_CLUSTER_RISK_SCORE: null,
    SYSTEM_FLAG_COUNT: 0, SYSTEM_HIGH_SEVERITY_FLAGS: 0,
  };
}

/** Run the researcher's custom rules: ordinary Conditions over answers + calc.SYSTEM_*. */
function customRules(ctx: RuleContext, sys: SystemVars): { drafts: FlagDraft[]; floor?: QualityClass } {
  const drafts: FlagDraft[] = [];
  let floor: QualityClass | undefined;
  const calculated: Record<string, unknown> = { ...(ctx.response.calculated ?? {}) };
  for (const [k, v] of Object.entries(sys)) if (typeof v === "number" || typeof v === "string" || v === null) calculated[k] = v;
  const state = stateFor(ctx.def, ctx.response.answers, ctx.response.embedded, calculated);
  const ectx = { def: ctx.def, state, loop: null, quotaCounts: {} };
  for (const rule of ctx.config.customRules) {
    if (!rule.enabled) continue;
    let fired = false;
    try { fired = evaluateCondition(rule.when, ectx); } catch { fired = false; }
    if (!fired) continue;
    drafts.push({
      ruleId: `custom.${rule.id}`,
      title: rule.name,
      observed: describeCondition(rule.when, calculated, ctx),
      explanation: rule.explanation || `Custom rule “${rule.name}” matched.`,
      questionIds: rule.questionIds,
      severity: rule.severity,
      intensity: 1,
    });
    if (rule.minClass && (!floor || CLASS_ORDER[rule.minClass] > CLASS_ORDER[floor])) floor = rule.minClass;
  }
  return { drafts, floor };
}

function describeCondition(c: any, calculated: Record<string, unknown>, ctx: RuleContext): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === "rule") {
      const ref = n.source?.ref;
      const val = n.source?.kind === "calculation" ? calculated[ref] : ctx.response.answers[ctx.def.questions.find((q) => q.code === ref || q.id === ref || q.variableName === ref)?.id ?? ref];
      parts.push(`${ref} = ${val === undefined ? "—" : JSON.stringify(val)}`);
      return;
    }
    for (const ch of n.children ?? []) walk(ch);
  };
  walk(c);
  return parts.slice(0, 6).join(", ");
}

/** Points from custom rules are the rule's own, not the catalogue's. */
function applyCustomPoints(flags: ReturnType<typeof finalizeFlags>, config: QualityConfig) {
  for (const f of flags) {
    if (!f.ruleId.startsWith("custom.")) continue;
    const rule = config.customRules.find((r) => `custom.${r.id}` === f.ruleId);
    if (!rule) continue;
    f.riskPoints = Math.round(rule.riskPoints);
    f.qualityPenalty = Math.round(rule.qualityPenalty);
    f.category = "custom";
  }
}

export function assess(input: QualityInput): QualityAssessment {
  const config = resolveConfig(input.def);
  const now = new Date(input.now ?? Date.now()).toISOString();
  const bench = computeBenchmarks(input.def, input.peers);
  const ctx = makeContext(input, config, bench);
  const t = ctx.telemetry;
  const sys = systemVars(ctx, t, bench);

  const drafts: FlagDraft[] = [];
  if (config.enabled) {
    drafts.push(...timingRules(ctx));
    drafts.push(...matrixRules(ctx));
    drafts.push(...patternRules(ctx));
    drafts.push(...attentionRules(ctx));
    drafts.push(...consistencyRules(ctx));
    drafts.push(...openEndRules(ctx));
    drafts.push(...behaviourRules(ctx));
  }
  const sim = config.enabled ? similarityRules(ctx, sys) : { flags: [], cluster: { clusterId: null, similarityScore: 0, similarSessionIds: [], clusterRisk: 0, size: 1, sharedSignals: [] }, similarityScore: 0, similarIds: [], answerSignature: null };
  drafts.push(...sim.flags);
  sys.SYSTEM_ANSWER_SIGNATURE = sim.answerSignature;
  sys.SYSTEM_SIMILARITY_SCORE = sim.similarityScore;
  sys.SYSTEM_SIMILAR_RESPONDENT_IDS = sim.cluster.similarSessionIds;
  sys.SYSTEM_CLUSTER_ID = sim.cluster.clusterId;
  sys.SYSTEM_CLUSTER_RISK_SCORE = sim.cluster.clusterId ? sim.cluster.clusterRisk : null;

  // provisional scores so custom rules can test calc.SYSTEM_*_SCORE
  let flags = finalizeFlags(drafts, config, now);
  fillScores(sys, flags, config);
  const custom = config.enabled ? customRules(ctx, sys) : { drafts: [] as FlagDraft[] };
  if (custom.drafts.length) {
    flags = finalizeFlags([...drafts, ...custom.drafts], config, now);
    applyCustomPoints(flags, config);
    fillScores(sys, flags, config, custom.floor);
  }

  const cats = categoryScores(flags);
  const cls = sys.SYSTEM_QUALITY_STATUS;
  const notMeasured = [...ctx.disabledTelemetry];
  return {
    version: 1,
    computedAt: now,
    strictness: config.strictness,
    enabled: config.enabled,
    qualityScore: sys.SYSTEM_QUALITY_SCORE,
    riskScore: sys.SYSTEM_FRAUD_RISK_SCORE,
    classification: cls,
    categories: cats,
    flags,
    system: sys,
    cluster: sim.cluster,
    reasons: reasons(flags),
    recommendation: recommendation(cls, sys.SYSTEM_QUALITY_SCORE),
    notMeasured,
    benchmarks: { peers: bench.peers, medianDurationSec: bench.medianDurationSec },
  };
}

function fillScores(sys: SystemVars, flags: ReturnType<typeof finalizeFlags>, config: QualityConfig, floor?: QualityClass) {
  const cats = categoryScores(flags);
  sys.SYSTEM_SPEEDER_SCORE = cats.timing;
  sys.SYSTEM_STRAIGHTLINE_SCORE = cats.matrix;
  sys.SYSTEM_ATTENTION_SCORE = cats.attention;
  sys.SYSTEM_CONSISTENCY_SCORE = cats.consistency;
  sys.SYSTEM_OPENEND_SCORE = cats.open_end;
  sys.SYSTEM_NAVIGATION_SCORE = cats.navigation;
  sys.SYSTEM_BOT_SCORE = cats.bot;
  sys.SYSTEM_DUPLICATE_SCORE = cats.duplicate;
  sys.SYSTEM_PATTERN_SCORE = cats.pattern;
  sys.SYSTEM_CLUSTER_SCORE = cats.cluster;
  sys.SYSTEM_DEVICE_SCORE = Math.max(cats.device, cats.network);
  sys.SYSTEM_INTERACTION_SCORE = cats.interaction;
  sys.SYSTEM_SCREENER_SCORE = cats.screener;
  sys.SYSTEM_FRAUD_RISK_SCORE = riskScore(flags);
  sys.SYSTEM_QUALITY_SCORE = qualityScore(flags);
  sys.SYSTEM_QUALITY_STATUS = classify(sys.SYSTEM_FRAUD_RISK_SCORE, config, floor);
  sys.SYSTEM_FLAG_COUNT = flags.length;
  sys.SYSTEM_HIGH_SEVERITY_FLAGS = flags.filter((f) => f.severity === "high" || f.severity === "critical").length;
}

/* ============================================================ survey-wide */

export interface SurveyAssessment {
  bySession: Map<string, QualityAssessment>;
  clusters: Map<string, { clusterId: string; size: number; members: string[] }>;
}

/**
 * Assess every response of a survey against every other, then close the
 * pairwise links into final clusters and stamp SYSTEM_CLUSTER_ID on each
 * member. Used by the Studio's recompute (after settings change) — the live
 * path assesses one response at a time against stored peers.
 */
export function assessSurvey(def: SurveyDefinition, responses: ResponseRecord[], history?: Map<string, HistoryRecord[]>, now?: number): SurveyAssessment {
  const peers: PeerRecord[] = responses.map((r) => ({
    sessionId: r.sessionId, respondentId: r.respondentId, externalId: r.externalId, status: r.status, answers: r.answers,
    startedAt: r.startedAt, completedAt: r.completedAt, ipHash: r.ipHash, deviceHash: r.deviceHash, system: null,
  }));
  // first pass: system vars for every response (signatures, timings) so peers carry them
  const config = resolveConfig(def);
  const bench0 = computeBenchmarks(def, peers);
  for (const p of peers) {
    const r = responses.find((x) => x.sessionId === p.sessionId)!;
    const ctx = makeContext({ def, response: r, peers: [], now }, config, bench0);
    p.system = systemVars(ctx, ctx.telemetry, bench0);
  }
  const bySession = new Map<string, QualityAssessment>();
  for (const r of responses) {
    if (r.status === "in_progress") continue;
    const a = assess({ def, response: r, peers, history: history?.get(r.externalId ?? "") ?? [], now });
    bySession.set(r.sessionId, a);
  }
  // final clusters
  const links = [...bySession.entries()].map(([sessionId, a]) => ({ sessionId, similarIds: a.cluster.similarSessionIds }));
  const clusters = clusterSurvey(links);
  for (const [sid, a] of bySession) {
    const c = clusters.get(sid);
    if (c) {
      a.cluster.clusterId = c.clusterId;
      a.cluster.size = c.size;
      a.cluster.similarSessionIds = c.members.filter((m) => m !== sid);
      a.system.SYSTEM_CLUSTER_ID = c.clusterId;
      a.system.SYSTEM_SIMILAR_RESPONDENT_IDS = a.cluster.similarSessionIds;
    }
  }
  return { bySession, clusters };
}
