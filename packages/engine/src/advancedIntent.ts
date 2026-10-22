import type { PlannedTest, Question, SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import { resolveQuestionRange, resolveQuestionRef, type TargetContext } from "./nlTargets.js";
import { resolveConcept } from "./nlSemantics.js";
import { structuredHypotheses, constructFor } from "./hypotheses.js";
import { isScaleLike, measurementOf } from "./analysisFramework.js";
import { gaborGrangerPattern, semModelFromDesign } from "./advancedMethods.js";

/**
 * ADVANCED MODELS BY SENTENCE (2026-10-22) — the engine's deterministic reading
 * of a request for HB, latent class, SEM, a bootstrapped mediation, McDonald's
 * ω or Gabor–Granger, turned into the same analysis actions the model writes
 * (add_analysis_test / update_analysis_test, plus a mean-score derived
 * variable a mediation of multi-item constructs needs). They go through the
 * same gate and preview as every action: the design-level suitability rules
 * refuse an item the design cannot carry, with the reason, and nothing changes.
 *
 *   "run HB on the conjoint", "estimate hierarchical Bayes utilities for the MaxDiff"
 *   "segment respondents with latent class using Q5–Q12 (with 2 to 6 classes)"
 *   "test H2 as a mediation through trust"
 *   "check reliability with omega", "compute McDonald's omega for trust"
 *   "test H1 and H2 with a structural equation model", "run a CFA of the constructs"
 *   "plan a Gabor–Granger demand curve"
 *
 * Null when the sentence is not one of these (the next recogniser, or the
 * model, reads it).
 */
export type AdvancedRead =
  | { kind: "actions"; understood: string; /** the request in a line — what a refusal says was understood */ short: string; actions: SurveyAction[]; detected: { what: string; value: string }[] }
  | { kind: "refused"; understood: string; reason: string; detected: { what: string; value: string }[]; noop?: boolean }
  | { kind: "clarify"; understood: string; question: string; choices: { label: string; text: string }[]; detected: { what: string; value: string }[] };

const det = (what: string, value: string) => ({ what, value });
const code = (q: Question) => String(q.code);
const planTests = (def: SurveyDefinition): PlannedTest[] => def.research?.analysisPlan?.tests ?? [];
const stem = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "SCORE";
const labels = (s: string) => [...new Set((s.match(/\bH\d+\b/gi) ?? []).map((h) => h.toUpperCase()))];

const HB = String.raw`(?:hb|hierarchical\s+bayes(?:ian)?(?:\s+(?:model|estimation|analysis))?|individual[\s-]level\s+(?:utilit(?:y|ies)|estimation|scores))`;
const LCA = String.raw`(?:latent[\s-]class(?:\s+analysis|\s+model|\s+segmentation)?|lca)`;
const SEM = String.raw`(?:structural\s+equation\s+model(?:l?ing)?|sem|path\s+(?:model|analysis)|cfa|confirmatory\s+factor\s+analysis)`;
const VERB = String.raw`(?:run|estimate|fit|do|add|plan|compute|get|perform|use|apply)`;

/** the exercise a phrase names: "the conjoint", "the CBC", "the MaxDiff", or a question */
function exerciseOf(def: SurveyDefinition, phrase: string, ctx: TargetContext): { q: Question } | { reason: string } | { choices: Question[] } {
  const p = phrase.trim().replace(/^(?:the|our|my)\s+/i, "").replace(/\s+(?:question|exercise|task|tasks|data|study)$/i, "").trim();
  const kind = /^(?:conjoint|cbc|choice(?:[\s-]based)?(?:\s+conjoint)?|choice\s+tasks?|discrete\s+choice|acbc|adaptive\s+(?:cbc|conjoint)|menu(?:[\s-]based)?)$/i.test(p) ? "conjoint" : /^(?:max[\s-]?diff|best[\s-]?worst)$/i.test(p) ? "maxdiff" : null;
  if (kind) {
    const qs = def.questions.filter((q) => (kind === "maxdiff" ? q.type === "maxdiff_task" : q.type === "conjoint_task" || q.type === "acbc_task"));
    if (!qs.length) return { reason: `This survey has no ${kind === "maxdiff" ? "MaxDiff" : "conjoint"} exercise — create it first (create_${kind === "maxdiff" ? "maxdiff" : "conjoint"}).` };
    return qs.length === 1 ? { q: qs[0] } : { choices: qs };
  }
  const r = resolveQuestionRef(def, p, ctx);
  return r.ok ? { q: r.question } : { reason: r.reason };
}

/** a hypothesis side as a variable a regression can read: one question, or the mean score of a construct's items (planned, or to be planned) */
function sideOf(def: SurveyDefinition, construct: { name: string; questionIds: string[] } | undefined, phrase: string | undefined, ctx: TargetContext): { name: string; derived?: SurveyAction } | { reason: string } {
  if (construct) {
    const qs = construct.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
    if (!qs.length) return { reason: `construct “${construct.name}” has no question measuring it` };
    if (qs.length === 1) return { name: qs[0].variableName };
    const names = qs.map((q) => q.variableName);
    const have = (def.research?.analysisPlan?.derived ?? []).find((d) => d.kind === "mean_score" && d.from.length === names.length && names.every((n) => d.from.includes(n)));
    if (have) return { name: have.name };
    const name = `${stem(construct.name)}_SCORE`;
    return { name, derived: { op: "add_derived_variable", name, kind: "mean_score", from: names, reason: `${construct.name}: the mean of its ${names.length} items` } as SurveyAction };
  }
  if (!phrase) return { reason: "a side of the hypothesis is not named" };
  const c = resolveConcept(def, phrase, ctx);
  return c.ok ? { name: c.question.variableName } : { reason: c.reason };
}

export function readAdvancedRequest(def: SurveyDefinition, raw: string, ctx: TargetContext = {}): AdvancedRead | null {
  const t = raw.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").replace(/^(?:please|can you|could you|i want to|i'd like to|let's|lets)\s+/i, "").trim();
  let m: RegExpExecArray | null;

  /* ---- hierarchical Bayes on an exercise */
  if ((m = new RegExp(String.raw`^${VERB}\s+(?:an?\s+|the\s+)?${HB}(?:\s+(?:utilities|analysis|model))?\s+(?:on|for|of|from|with)\s+(.+)$`, "i").exec(t))
    || (m = new RegExp(String.raw`^(?:individual|hb|respondent[\s-]level)\s+utilities\s+(?:for|from|of)\s+(.+)$`, "i").exec(t))) {
    const understood = `Plan hierarchical Bayes (individual utilities) on ${m[1]}.`;
    const ex = exerciseOf(def, m[1], ctx);
    if ("reason" in ex) return { kind: "refused", understood, reason: ex.reason, detected: [det("method", "hb")] };
    if ("choices" in ex) return { kind: "clarify", understood, question: "Which exercise should HB estimate?", choices: ex.choices.map((q) => ({ label: `${code(q)} — ${q.text.replace(/<[^>]+>/g, "").slice(0, 50)}`, text: `run HB on ${code(q)}` })), detected: [det("method", "hb")] };
    const q = ex.q;
    if (planTests(def).some((x) => x.method === "hb" && x.variables.includes(q.variableName))) return { kind: "refused", understood, reason: `Hierarchical Bayes on ${code(q)} is already in the analysis plan — it runs as a background job when the plan is applied.`, detected: [det("method", "hb")], noop: true };
    return { kind: "actions", short: understood, understood: `Plan hierarchical Bayes on ${code(q)} (${q.variableName}): individual utilities, importances and the simulator on individual utilities, with convergence diagnostics. It runs as a background job with progress when the plan is applied.`, actions: [{ op: "add_analysis_test", method: "hb", variables: [q.variableName], priority: 2, reason: `asked for in Intelligent mode: individual utilities for ${code(q)}`, options: { chains: 2, burnIn: 5000, draws: 5000, seed: 1 } } as SurveyAction], detected: [det("method", "hb"), det("question", code(q))] };
  }

  /* ---- latent class on indicators */
  if ((m = new RegExp(String.raw`^(?:segment|cluster|group|classify|split)\s+(?:the\s+)?(?:respondents|people|buyers|customers|users|sample|them)?\s*(?:with|using|by|via|into)\s+(?:a\s+|an\s+)?${LCA}\s+(?:using|on|with|from|of|based\s+on)\s+(.+)$`, "i").exec(t))
    || (m = new RegExp(String.raw`^${VERB}\s+(?:a\s+|an\s+|the\s+)?${LCA}\s+(?:on|of|using|with|from|across)\s+(.+)$`, "i").exec(t))) {
    let rest = m[1];
    const opts: Record<string, unknown> = { starts: 20, seed: 1 };
    let k: RegExpExecArray | null;
    if ((k = /[,\s]+(?:with|for|and|controlling\s+for)\s+(.+?)\s+as\s+(?:a\s+)?covariates?$/i.exec(rest))) { opts.covariates = k[1].split(/\s*(?:,|\band\b)\s*/i).filter(Boolean); rest = rest.slice(0, k.index); }
    if ((k = /[,\s]+(?:with|for|testing|comparing|from)\s+(\d)\s*(?:to|-|–|through)\s*(\d)\s+classes$/i.exec(rest))) { opts.minClasses = Number(k[1]); opts.maxClasses = Number(k[2]); rest = rest.slice(0, k.index); }
    else if ((k = /[,\s]+(?:with|into)\s+(\d)\s+classes$/i.exec(rest))) { opts.minClasses = 1; opts.maxClasses = Math.max(Number(k[1]), 2); opts.classes = Number(k[1]); rest = rest.slice(0, k.index); }
    else { opts.minClasses = 1; opts.maxClasses = 5; }
    const understood = `Plan a latent class analysis of ${rest}.`;
    const range = resolveQuestionRange(def, rest, ctx);
    if (!range.ok) return { kind: "refused", understood, reason: range.reason, detected: [det("method", "latent_class")] };
    const vars = range.questions.map((q) => q.variableName);
    return { kind: "actions", short: understood, understood: `Plan a latent class analysis of ${range.questions.map(code).join(", ")}: ${String(opts.minClasses)}–${String(opts.maxClasses)} classes compared by BIC (AIC, SABIC and entropy beside it), class sizes, profiles and each respondent's class.`, actions: [{ op: "add_analysis_test", method: "latent_class", variables: vars, priority: 1, reason: "asked for in Intelligent mode: segments by latent class", options: opts } as SurveyAction], detected: [det("method", "latent_class"), det("indicators", range.questions.map(code).join(", "))] };
  }

  /* ---- a hypothesis as a mediation, bootstrapped */
  if ((m = /^(?:test|run|plan|check|model|analy[sz]e)\s+(H\d+)\s+(?:as|with|using)\s+(?:a\s+)?(?:bootstrapped\s+)?mediation(?:\s+(?:analysis|model|test))?\s+(?:through|via|by|with)\s+(.+?)(?:,?\s+(?:with|using)\s+(?:a\s+)?(?:bootstrap(?:ped)?|bca)(?:\s+(?:ci|cis|intervals?|confidence\s+intervals?))?)?$/i.exec(t))) {
    const label = m[1].toUpperCase(), phrase = m[2];
    const understood = `Test ${label} as a mediation through ${phrase}, with a bootstrapped indirect effect.`;
    const hs = structuredHypotheses(def);
    const h = hs.find((x) => x.label === label);
    if (!h) return { kind: "refused", understood, reason: `${label} is not a hypothesis of the research design (it has ${hs.length}).`, detected: [det("hypothesis", label)] };
    const mc = constructFor(def, phrase);
    const iv = sideOf(def, h.constructs.independent, h.independent, ctx), dv = sideOf(def, h.constructs.dependent, h.dependent, ctx), med = sideOf(def, mc, phrase, ctx);
    for (const [s, what] of [[iv, "its predictor"], [dv, "its outcome"], [med, "the mediator"]] as const) if ("reason" in s) return { kind: "refused", understood, reason: `${label}'s ${what} cannot be read: ${s.reason}.`, detected: [det("hypothesis", label)] };
    const x = iv as { name: string; derived?: SurveyAction }, y = dv as typeof x, mm = med as typeof x;
    if (new Set([x.name, y.name, mm.name]).size < 3) return { kind: "refused", understood, reason: `${label}'s predictor, outcome and the mediator must be three different variables (${x.name}, ${mm.name}, ${y.name}).`, detected: [det("hypothesis", label)] };
    const derived = [x, y, mm].map((s) => s.derived).filter((a): a is SurveyAction => !!a);
    return { kind: "actions", short: understood, understood: `Test ${label} (“${h.text}”) as a mediation: ${x.name} → ${mm.name} → ${y.name}, the indirect effect with 95% percentile and BCa intervals from 5,000 seeded bootstrap resamples${derived.length ? `; ${derived.length} mean score${derived.length === 1 ? "" : "s"} planned for the multi-item construct${derived.length === 1 ? "" : "s"}` : ""}.`,
      actions: [...derived, { op: "add_analysis_test", method: "regression", outcome: y.name, variables: [x.name], mediator: mm.name, hypotheses: [label], priority: 1, reason: `${label}: does ${mm.name} carry the effect of ${x.name} on ${y.name}?`, options: { bootstrap: 5000, seed: 1 } } as SurveyAction],
      detected: [det("hypothesis", label), det("mediator", mm.name)] };
  }

  /* ---- McDonald's ω */
  if ((m = /^(?:check|compute|run|add|report|calculate|estimate|test|assess)\s+(?:the\s+)?(?:scale\s+)?(?:reliability|internal\s+consistency)(?:\s+of\s+(.+?))?\s+(?:with|using|by|via)\s+(?:mcdonald'?s\s+)?(?:omega|ω)(?:\s+(?:too|as\s+well|beside\s+alpha))?$/i.exec(t))
    || (m = /^(?:compute|add|report|calculate|estimate|check|run)\s+(?:mcdonald'?s\s+)?(?:omega|ω)(?:\s+(?:reliability|coefficient))?(?:\s+(?:for|of|on)\s+(.+))?$/i.exec(t))) {
    const target = m[1]?.trim();
    const understood = `Report McDonald's ω${target ? ` for ${target}` : " for the multi-item scales"}.`;
    const scales: { name: string; vars: string[] }[] = [];
    if (target) {
      const c = constructFor(def, target);
      if (c) scales.push({ name: c.name, vars: c.questionIds.map((id) => def.questions.find((q) => q.id === id)?.variableName).filter((v): v is string => !!v) });
      else { const r = resolveQuestionRange(def, target, ctx); if (!r.ok) return { kind: "refused", understood, reason: r.reason, detected: [det("method", "omega")] }; scales.push({ name: target, vars: r.questions.map((q) => q.variableName) }); }
    } else {
      for (const c of def.research?.constructs ?? []) { const vars = c.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && isScaleLike(measurementOf(q))).map((q) => q.variableName); if (vars.length >= 2) scales.push({ name: c.name, vars }); }
      for (const r of planTests(def).filter((x) => x.method === "reliability")) if (!scales.some((s) => s.vars.join("|") === r.variables.join("|"))) scales.push({ name: r.reason ?? r.id, vars: r.variables });
      if (!scales.length) return { kind: "refused", understood, reason: "No multi-item scale is recorded (no construct with two or more rating items, no planned reliability) — name the items: “compute omega for Q8 to Q11”.", detected: [det("method", "omega")] };
    }
    const actions: SurveyAction[] = scales.map((s) => {
      const have = planTests(def).find((x) => x.method === "reliability" && x.variables.length === s.vars.length && s.vars.every((v) => x.variables.includes(v)));
      return (have ? { op: "update_analysis_test", id: have.id, options: { omega: true } } : { op: "add_analysis_test", method: "reliability", variables: s.vars, priority: 2, reason: `${s.name}: reliability (α and McDonald's ω)`, options: { omega: true } }) as SurveyAction;
    });
    return { kind: "actions", short: understood, understood: `Report McDonald's ω beside Cronbach's α for ${scales.map((s) => `${s.name} (${s.vars.length} items)`).join(", ")} — ω from a one-factor model, which does not assume the items load equally.`, actions, detected: [det("method", "omega"), ...scales.map((s) => det("scale", s.name))] };
  }

  /* ---- SEM / CFA from the research design */
  if ((m = new RegExp(String.raw`^(?:test|run|fit|estimate|plan|model|check|validate)\s+(?:(H\d+(?:\s*(?:,|and|&)\s*H\d+)*)\s+(?:with|as|in|using|by)\s+)?(?:a\s+|an\s+|the\s+)?${SEM}(?:\s+(?:for|of|on)\s+(.+))?$`, "i").exec(t))) {
    const hs = labels(`${m[1] ?? ""} ${m[2] ?? ""}`);
    const cfa = /\bcfa\b|confirmatory/i.test(t) && !hs.length;
    const understood = cfa ? "Plan a confirmatory factor analysis of the constructs." : `Plan a structural equation model${hs.length ? ` of ${hs.join(", ")}` : " of the hypotheses"}.`;
    if (cfa) {
      const target = m[2]?.replace(/^(?:the\s+)?/i, "").trim();
      const cs = (def.research?.constructs ?? []).filter((c) => !target || /^(?:constructs?|scales?|measurement\s+model)$/i.test(target) || target.toLowerCase().includes(c.name.toLowerCase()));
      const factors = cs.map((c) => ({ name: stem(c.name), items: c.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && isScaleLike(measurementOf(q))).map((q) => q.variableName) })).filter((f) => f.items.length >= 2);
      if (!factors.length) return { kind: "refused", understood, reason: "No construct has two or more rating-scale items, so there is no measurement model to confirm — record the constructs with their questions first.", detected: [det("method", "sem")] };
      const syntax = ["# confirmatory factor analysis: each construct by its items", ...factors.map((f) => `${f.name} =~ ${f.items.join(" + ")}`)].join("\n");
      return { kind: "actions", short: understood, understood: `Plan a confirmatory factor analysis of ${factors.map((f) => `${f.name} (${f.items.length} items)`).join(", ")}: loadings, fit indices (CFI, TLI, RMSEA, SRMR) and ω per factor.`, actions: [{ op: "add_analysis_test", method: "sem", variables: factors.flatMap((f) => f.items), priority: 2, reason: "asked for in Intelligent mode: the measurement model", options: { syntax, scaling: "marker" } } as SurveyAction], detected: [det("method", "sem")] };
    }
    const model = semModelFromDesign(def, { only: hs });
    if ("error" in model) return { kind: "refused", understood, reason: `No structural model can be built: ${model.error}.`, detected: [det("method", "sem")] };
    if (planTests(def).some((x) => x.method === "sem" && model.hypotheses.every((h) => x.hypotheses.includes(h)))) return { kind: "refused", understood, reason: `A structural equation model of ${model.hypotheses.join(", ")} is already in the analysis plan.`, detected: [det("method", "sem")], noop: true };
    const skipped = model.skipped.length ? ` Not in the model: ${model.skipped.map((s) => s.reason).join("; ")}.` : "";
    return { kind: "actions", short: understood, understood: `Plan a structural equation model of ${model.hypotheses.join(", ")}: ${model.latents.map((l) => `${l.name} measured by ${l.items.length} items`).join(", ")}; ${Object.entries(model.hypothesisPaths).map(([h, p]) => `${h} read from ${p.startsWith(":=") ? `the indirect effect ${p.slice(2)}` : p}`).join("; ")}.${skipped}`,
      actions: [{ op: "add_analysis_test", method: "sem", hypotheses: model.hypotheses, priority: 1, reason: `asked for in Intelligent mode: ${model.hypotheses.join(", ")} with their constructs' measurement error accounted for` } as SurveyAction], detected: [det("method", "sem"), ...model.hypotheses.map((h) => det("hypothesis", h))] };
  }

  /* ---- Gabor–Granger */
  if ((m = /^(?:run|plan|add|do|compute|create|analy[sz]e)\s+(?:a\s+|the\s+)?gabor[\s\-–]granger(?:\s+(?:analysis|demand(?:\s+curve)?|pricing|curve))?(?:\s+(?:on|for|of|using|from)\s+(.+))?$/i.exec(t))) {
    const understood = `Plan a Gabor–Granger demand curve${m[1] ? ` of ${m[1]}` : ""}.`;
    let vars: string[] | null = null, prices: number[] | undefined;
    if (m[1]) { const r = resolveQuestionRange(def, m[1], ctx); if (!r.ok) return { kind: "refused", understood, reason: r.reason, detected: [det("method", "gabor_granger")] }; vars = r.questions.map((q) => q.variableName); }
    const ladder = gaborGrangerPattern(def);
    if (!vars) { if (!ladder) return { kind: "refused", understood, reason: "No purchase-intent questions at a ladder of prices were found (two or more single-choice questions with the same answer scale, each naming one price) — name them: “plan a Gabor–Granger on P1 to P5”.", detected: [det("method", "gabor_granger")] }; vars = ladder.questions; prices = ladder.prices; }
    return { kind: "actions", short: understood, understood: `Plan a Gabor–Granger demand curve over ${vars.join(", ")}${prices ? ` at ${prices.join(", ")}` : ""}: the share who would buy at each price, the revenue index and the revenue-maximising price.`, actions: [{ op: "add_analysis_test", method: "pricing", variables: vars, priority: 1, reason: "asked for in Intelligent mode: demand at the price points", options: { method: "gabor_granger", ...(prices ? { prices } : {}) } } as SurveyAction], detected: [det("method", "gabor_granger")] };
  }
  return null;
}
