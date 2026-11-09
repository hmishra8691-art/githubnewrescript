import type { Question, SurveyDefinition } from "@rescript/schema";
import type { FlagDraft, RuleContext } from "../types.js";
import { normalizeText } from "../metrics.js";
import { isMulti, isSingle } from "../survey.js";

/**
 * LOGICAL CONTRADICTIONS BETWEEN ANSWERS (2026-11-09, Rapid Studio phase 4).
 *
 * The consistency family already caught an answer given where its gate hides it, an undeclared repeat answered two
 * ways, "never" beside a positive quantity, and a changed piped answer. These are the contradictions a cleaning
 * analyst checks by hand next, read from the questionnaire's own structure and wording — never from a model:
 *
 *   consistency.exclusive_combined  an exclusive answer ("None of these", "Don't know") chosen together with others
 *                                   in a multi-select — impossible live (the runtime clears them), common in imports
 *   consistency.funnel              a brand used / considered / preferred that the respondent said they had never
 *                                   heard of: later funnel stages must be within earlier ones (matched by label)
 *   consistency.part_whole          a count that is part of an earlier count is larger than it ("children under 18" >
 *                                   "people in your household"; "how many of them …" > the number asked before)
 *   consistency.age_years           years of something (working, living here, using the brand) greater than the
 *                                   respondent's age
 *
 * Each flag names both questions and both answers, so the reviewer sees the contradiction itself. Nothing is removed
 * automatically: a flag is evidence for review, the same as every other rule.
 */
const strip = (s: string) => normalizeText(String(s ?? "").replace(/<[^>]*>/g, " "));
const codesOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === "" ? [] : [String(v)]);
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const isNumeric = (q: Question) => q.type === "numeric" || q.type === "slider";
const label = (q: Question, code: string) => q.options.find((o) => String(o.code) === code)?.label.replace(/<[^>]*>/g, "").trim() ?? code;

const EXCLUSIVE_WORDS = /^(none of (?:the above|these|them)|none|nothing|no one|neither|don t know|dont know|do not know|not sure|prefer not to (?:say|answer)|not applicable|n a)\b/;
export const isExclusiveOption = (o: Question["options"][number]) => (o.flags ?? []).includes("exclusive") || EXCLUSIVE_WORDS.test(strip(o.label));

/** the funnel stage a question's wording asks about; lower comes first */
export function funnelStage(q: Question): number | null {
  const t = strip(`${q.text} ${q.variableName ?? ""}`);
  if (/\b(?:aware|heard of|have you heard|familiar with|know of|recogni[sz]e|seen or heard)\b/.test(t)) return 1;
  if (/\b(?:consider|would you consider|shortlist)\b/.test(t)) return 2;
  if (/\b(?:used|use|bought|buy|purchased|purchase|own|tried|customer of|currently use)\b/.test(t)) return 3;
  if (/\b(?:prefer|favou?rite|use most|most often|main brand|first choice)\b/.test(t)) return 4;
  return null;
}

const HOUSEHOLD = /\b(?:household|live with you|living with you|people (?:live|living) in your home|in your home|family members?|people in your (?:home|house|family))\b/;
const CHILD = /\b(?:child(?:ren)?|kids?|under (?:18|16|12)|aged (?:0|under)|minors?|teenagers?)\b/;
const OF_THEM = /\b(?:of (?:them|these|those|which)|how many of)\b/;
const AGE = /\b(?:how old|your age|what is your age|age in years|current age)\b/;
const YEARS = /\b(?:how many years|for how long|years (?:have you|has it|did you)|number of years)\b/;

export function logicRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const { def } = ctx;
  const a = ctx.response.answers;
  const has = (id: string) => codesOf(a[id]).length > 0;

  if (ctx.enabled("consistency.exclusive_combined")) {
    for (const q of def.questions) {
      if (!isMulti(q) || !has(q.id) || !ctx.applies("consistency.exclusive_combined", q.id)) continue;
      const chosen = codesOf(a[q.id]);
      if (chosen.length < 2) continue;
      const exclusive = chosen.filter((c) => { const o = q.options.find((x) => String(x.code) === c); return !!o && isExclusiveOption(o); });
      if (!exclusive.length) continue;
      const others = chosen.filter((c) => !exclusive.includes(c));
      if (!others.length && exclusive.length < 2) continue;
      out.push({
        ruleId: "consistency.exclusive_combined",
        title: `Exclusive answer combined with others (${q.code})`,
        observed: `${q.code}: "${exclusive.map((c) => label(q, c)).join('", "')}" together with "${(others.length ? others : exclusive.slice(1)).map((c) => label(q, c)).join('", "')}"`,
        expected: `"${label(q, exclusive[0])}" alone`,
        explanation: `"${label(q, exclusive[0])}" excludes every other answer, yet others were selected too.`,
        questionIds: [q.id],
        intensity: 1,
      });
    }
  }

  if (ctx.enabled("consistency.funnel")) {
    const staged = def.questions.filter((q) => (isMulti(q) || isSingle(q)) && q.options.length >= 3 && has(q.id)).map((q) => ({ q, stage: funnelStage(q) })).filter((x): x is { q: Question; stage: number } => x.stage !== null);
    const brands = (q: Question) => new Map(q.options.filter((o) => !isExclusiveOption(o) && !(o.flags ?? []).includes("other_specify")).map((o) => [strip(o.label), String(o.code)]));
    const seen = new Set<string>();
    for (const later of staged) {
      const lb = brands(later.q);
      for (const earlier of staged) {
        if (earlier.stage >= later.stage || earlier.q.id === later.q.id) continue;
        if (!ctx.applies("consistency.funnel", later.q.id)) continue;
        const eb = brands(earlier.q);
        const shared = [...lb.keys()].filter((k) => eb.has(k));
        if (shared.length < Math.min(3, lb.size) || shared.length < lb.size * 0.6) continue;
        const earlierChosen = new Set(codesOf(a[earlier.q.id]));
        const missing = codesOf(a[later.q.id]).map((c) => later.q.options.find((o) => String(o.code) === c)).filter((o): o is NonNullable<typeof o> => !!o && eb.has(strip(o.label)) && !earlierChosen.has(eb.get(strip(o.label))!));
        if (!missing.length) continue;
        const key = `${later.q.id}|${earlier.q.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const names = missing.map((o) => o.label.replace(/<[^>]*>/g, "").trim());
        out.push({
          ruleId: "consistency.funnel",
          title: `Brand funnel contradiction (${earlier.q.code} → ${later.q.code})`,
          observed: `${later.q.code} names ${names.map((n) => `"${n}"`).join(", ")}, not chosen at ${earlier.q.code}`,
          expected: `every brand at ${later.q.code} also at ${earlier.q.code}`,
          explanation: `${later.q.code} (a later funnel stage) selects ${names.length === 1 ? "a brand" : "brands"} the respondent did not select at ${earlier.q.code} — e.g. using a brand they say they have never heard of.`,
          questionIds: [earlier.q.id, later.q.id],
          intensity: Math.min(1, 0.6 + missing.length * 0.2),
        });
      }
    }
  }

  const numerics = def.questions.filter((q) => isNumeric(q) && num(a[q.id]) !== null);

  if (ctx.enabled("consistency.part_whole")) {
    for (let i = 0; i < numerics.length; i++) {
      const part = numerics[i];
      const pt = strip(part.text);
      let whole: Question | null = null;
      if (OF_THEM.test(pt) && i > 0) whole = numerics[i - 1];
      else if (CHILD.test(pt)) whole = numerics.find((w) => w.id !== part.id && HOUSEHOLD.test(strip(w.text)) && !CHILD.test(strip(w.text))) ?? null;
      if (!whole || !ctx.applies("consistency.part_whole", part.id)) continue;
      const pv = num(a[part.id])!, wv = num(a[whole.id])!;
      const includesSelf = /\b(?:including yourself|including you|incl\w* yourself)\b/.test(strip(whole.text));
      const bad = CHILD.test(pt) && HOUSEHOLD.test(strip(whole.text)) ? (includesSelf ? pv >= wv : pv > wv) : pv > wv;
      if (!bad) continue;
      out.push({
        ruleId: "consistency.part_whole",
        title: `Part larger than its whole (${part.code} vs ${whole.code})`,
        observed: `${part.code} = ${pv} but ${whole.code} = ${wv}`,
        expected: `${part.code} ${includesSelf && CHILD.test(pt) ? "<" : "≤"} ${whole.code}`,
        explanation: `${part.code} counts part of what ${whole.code} counts${includesSelf && CHILD.test(pt) ? " (which includes the respondent)" : ""}, yet it is larger.`,
        questionIds: [whole.id, part.id],
        intensity: 1,
      });
    }
  }

  if (ctx.enabled("consistency.age_years")) {
    const age = numerics.find((q) => AGE.test(strip(q.text)) || /^age$/i.test(q.variableName ?? q.code));
    if (age) {
      const av = num(a[age.id])!;
      for (const q of numerics) {
        if (q.id === age.id || !YEARS.test(strip(q.text)) || !ctx.applies("consistency.age_years", q.id)) continue;
        const v = num(a[q.id])!;
        if (v <= av) continue;
        out.push({
          ruleId: "consistency.age_years",
          title: `More years than the respondent's age (${q.code})`,
          observed: `${q.code} = ${v} years but ${age.code} (age) = ${av}`,
          expected: `${q.code} ≤ ${av}`,
          explanation: `${q.code} asks how many years, and the answer is more than the respondent's age at ${age.code}.`,
          questionIds: [age.id, q.id],
          intensity: 1,
        });
      }
    }
  }
  return out;
}

/** the contradiction checks this questionnaire can support — shown in the Studio before any data exists */
export function logicChecksFor(def: SurveyDefinition): { ruleId: string; questions: string[]; what: string }[] {
  const out: { ruleId: string; questions: string[]; what: string }[] = [];
  for (const q of def.questions) if (isMulti(q) && q.options.some(isExclusiveOption)) out.push({ ruleId: "consistency.exclusive_combined", questions: [q.code], what: `"${q.options.filter(isExclusiveOption).map((o) => o.label.replace(/<[^>]*>/g, "").trim()).join('", "')}" alone at ${q.code}` });
  const staged = def.questions.filter((q) => (isMulti(q) || isSingle(q)) && q.options.length >= 3).map((q) => ({ q, s: funnelStage(q) })).filter((x) => x.s !== null);
  for (const l of staged) for (const e of staged) if (e.s! < l.s! && l.q.options.filter((o) => e.q.options.some((x) => strip(x.label) === strip(o.label))).length >= Math.min(3, l.q.options.length)) out.push({ ruleId: "consistency.funnel", questions: [e.q.code, l.q.code], what: `brands at ${l.q.code} must also be chosen at ${e.q.code}` });
  const ns = def.questions.filter(isNumeric);
  ns.forEach((p, i) => {
    const pt = strip(p.text);
    const w = OF_THEM.test(pt) && i > 0 ? ns[i - 1] : CHILD.test(pt) ? ns.find((x) => x.id !== p.id && HOUSEHOLD.test(strip(x.text)) && !CHILD.test(strip(x.text))) : null;
    if (w) out.push({ ruleId: "consistency.part_whole", questions: [w.code, p.code], what: `${p.code} must not exceed ${w.code}` });
  });
  const age = ns.find((q) => AGE.test(strip(q.text)) || /^age$/i.test(q.variableName ?? q.code));
  if (age) for (const q of ns) if (q.id !== age.id && YEARS.test(strip(q.text))) out.push({ ruleId: "consistency.age_years", questions: [age.code, q.code], what: `${q.code} (years) must not exceed the age at ${age.code}` });
  return out;
}
