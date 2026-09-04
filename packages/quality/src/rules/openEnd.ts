import type { Question } from "@rescript/schema";
import type { FlagDraft, RuleContext } from "../types.js";
import {
  fnv1a, gibberishScore, isGenericAnswer, normalizeText, pct, polishedTextScore, repeatedWordScore, textSimilarity, words,
} from "../metrics.js";
import { isOpen, isSingle, isMulti, questionVocabulary } from "../survey.js";

/** Text answers of a response: question → text (lists joined). */
export function openEnds(questions: Question[], answers: Record<string, unknown>): { q: Question; text: string }[] {
  const out: { q: Question; text: string }[] = [];
  for (const q of questions) {
    if (!isOpen(q)) continue;
    const v = answers[q.id];
    const text = typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : "";
    if (text.trim()) out.push({ q, text });
  }
  return out;
}

/** Stable hash of normalised text, for cross-respondent duplicate lookups. Trivial answers hash to null. */
export function openEndHash(text: string): string | null {
  const n = normalizeText(text);
  if (words(n).length < 3) return null;
  return fnv1a(n);
}

export function openEndRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const allEnds = openEnds(ctx.def.questions, ctx.response.answers);
  if (!allEnds.length) return out;
  const endsFor = (ruleId: string) => allEnds.filter((e) => ctx.applies(ruleId, e.q.id));
  let ends = allEnds;
  const code = (q: Question) => q.code;

  /* too short / one word */
  if (ctx.enabled("openend.too_short")) {
    ends = endsFor("openend.too_short");
    const minChars = ctx.param<number>("openend.too_short", "minChars");
    const share = ctx.param<number>("openend.too_short", "share");
    const judged = ends.filter((e) => e.q.type === "long_text" || (e.q.validation ?? []).some((v: any) => v.type === "min_length" || v.kind === "minLength"));
    const pool = judged.length ? judged : ends.filter((e) => e.q.type === "long_text");
    const short = pool.filter((e) => e.text.trim().length < minChars || words(e.text).length <= 1);
    if (pool.length >= 2 && short.length / pool.length >= share) {
      out.push({
        ruleId: "openend.too_short",
        observed: `${short.length} of ${pool.length} long-text answers under ${minChars} characters or one word`,
        expected: `fewer than ${pct(share)}`,
        explanation: "Open-ended questions asking for explanation received one-word or near-empty answers.",
        questionIds: short.map((e) => e.q.id),
      });
    }
  }

  /* gibberish */
  if (ctx.enabled("openend.gibberish")) {
    ends = endsFor("openend.gibberish");
    const thr = ctx.param<number>("openend.gibberish", "score");
    const hits = ends.map((e) => ({ ...e, score: gibberishScore(e.text) })).filter((e) => e.score >= thr && e.text.trim().length >= 4);
    if (hits.length) {
      out.push({
        ruleId: "openend.gibberish",
        observed: hits.map((h) => `${code(h.q)}: "${h.text.slice(0, 30)}${h.text.length > 30 ? "…" : ""}" (score ${Math.round(h.score * 100) / 100})`).join("; "),
        expected: `gibberish score < ${thr}`,
        explanation: "Text has the letter statistics of a keyboard mash rather than language.",
        questionIds: hits.map((h) => h.q.id),
        intensity: Math.min(1, 0.7 + hits.length * 0.15),
      });
    }
  }

  /* repeated words / same text across questions */
  if (ctx.enabled("openend.repeated")) {
    ends = endsFor("openend.repeated");
    const thr = ctx.param<number>("openend.repeated", "score");
    const rep = ends.filter((e) => words(e.text).length >= 3 && repeatedWordScore(e.text) >= thr);
    const seen = new Map<string, Question[]>();
    for (const e of ends) { const h = openEndHash(e.text); if (h) (seen.get(h) ?? seen.set(h, []).get(h)!).push(e.q); }
    const dupes = [...seen.values()].filter((qs) => qs.length > 1);
    if (rep.length || dupes.length) {
      out.push({
        ruleId: "openend.repeated",
        observed: [
          ...rep.map((e) => `${code(e.q)}: repeated words`),
          ...dupes.map((qs) => `same text in ${qs.map(code).join(" & ")}`),
        ].join("; "),
        explanation: "The same word or phrase was repeated to fill the box, or one text was given to several questions.",
        questionIds: [...new Set([...rep.map((e) => e.q.id), ...dupes.flat().map((q) => q.id)])],
      });
    }
  }

  /* generic */
  if (ctx.enabled("openend.generic")) {
    ends = endsFor("openend.generic");
    const thr = ctx.param<number>("openend.generic", "share");
    const generic = ends.filter((e) => isGenericAnswer(e.text));
    if (ends.length >= 2 && generic.length / ends.length >= thr) {
      out.push({
        ruleId: "openend.generic",
        observed: `${generic.length} of ${ends.length} open ends are generic ("${generic[0].text.slice(0, 20)}"…)`,
        expected: `fewer than ${pct(thr)}`,
        explanation: "Open-ended answers say nothing specific.",
        questionIds: generic.map((e) => e.q.id),
      });
    }
  }

  /* irrelevant: long answer, zero vocabulary overlap with the question */
  if (ctx.enabled("openend.irrelevant")) {
    ends = endsFor("openend.irrelevant");
    const hits = ends.filter((e) => {
      const ws = words(e.text).filter((w) => w.length > 3);
      if (ws.length < 8) return false;
      const vocab = questionVocabulary(e.q);
      if (vocab.size < 3) return false;
      return !ws.some((w) => vocab.has(w));
    });
    if (hits.length && hits.length >= Math.ceil(ends.length / 2)) {
      out.push({
        ruleId: "openend.irrelevant",
        observed: `${hits.length} long answers share no words with their question`,
        explanation: "The text does not touch the subject of the question at all (a weak relevance check).",
        questionIds: hits.map((h) => h.q.id),
      });
    }
  }

  /* contradiction with closed answers: names an option explicitly NOT chosen on the preceding choice question */
  if (ctx.enabled("openend.contradiction")) {
    ends = endsFor("openend.contradiction");
    const hits: { q: Question; other: Question; opt: string }[] = [];
    for (const e of ends) {
      const idx = ctx.def.questions.indexOf(e.q);
      const prev = ctx.def.questions.slice(Math.max(0, idx - 3), idx).reverse().find((p) => (isSingle(p) || isMulti(p)) && ctx.response.answers[p.id] !== undefined);
      if (!prev) continue;
      const chosen = new Set(([] as unknown[]).concat(ctx.response.answers[prev.id] as any).map(String));
      const text = normalizeText(e.text);
      for (const o of prev.options) {
        const label = normalizeText(o.label);
        if (label.length < 4 || chosen.has(String(o.code))) continue;
        if (/\b(no|not|never|none)\b/.test(label)) continue;
        if (text.includes(label) && /\b(i use|i own|i have|i bought|i drive|my)\b/.test(text)) { hits.push({ q: e.q, other: prev, opt: o.label }); break; }
      }
    }
    if (hits.length) {
      out.push({
        ruleId: "openend.contradiction",
        observed: hits.map((h) => `${code(h.q)} mentions "${h.opt.replace(/<[^>]*>/g, "")}" not selected in ${code(h.other)}`).join("; "),
        explanation: "A text answer claims something the closed question before it denied.",
        questionIds: hits.flatMap((h) => [h.q.id, h.other.id]),
      });
    }
  }

  /* duplicate / near-duplicate across respondents */
  if (ctx.enabled("openend.duplicate") && ctx.peers.length) {
    ends = endsFor("openend.duplicate");
    const thr = ctx.param<number>("openend.duplicate", "similarity");
    const minWords = ctx.param<number>("openend.duplicate", "minWords");
    const hits: { q: Question; peers: string[]; sim: number }[] = [];
    for (const e of ends) {
      if (words(e.text).length < minWords || isGenericAnswer(e.text)) continue;
      const myHash = openEndHash(e.text);
      const exact = ctx.peers.filter((p) => p.sessionId !== ctx.response.sessionId && myHash && p.system?.SYSTEM_OPENEND_HASHES?.[e.q.id] === myHash).map((p) => p.sessionId);
      if (exact.length) { hits.push({ q: e.q, peers: exact, sim: 1 }); continue; }
      // near-duplicate: compare against peers' raw text when present in answers
      const near: string[] = [];
      let best = 0;
      for (const p of ctx.peers) {
        if (p.sessionId === ctx.response.sessionId) continue;
        const pv = p.answers[e.q.id];
        const pt = typeof pv === "string" ? pv : Array.isArray(pv) ? pv.join(" ") : "";
        if (words(pt).length < minWords) continue;
        const s = textSimilarity(e.text, pt);
        if (s >= thr) { near.push(p.sessionId); best = Math.max(best, s); }
      }
      if (near.length) hits.push({ q: e.q, peers: near, sim: best });
    }
    if (hits.length) {
      out.push({
        ruleId: "openend.duplicate",
        observed: hits.map((h) => `${code(h.q)} ${h.sim === 1 ? "identical" : `${pct(h.sim)} similar`} to ${h.peers.length} other${h.peers.length === 1 ? "" : "s"}`).join("; "),
        expected: `similarity < ${pct(thr)}`,
        explanation: "An open-ended answer is the same, or nearly the same, as another respondent's.",
        questionIds: hits.map((h) => h.q.id),
        relatedSessionIds: [...new Set(hits.flatMap((h) => h.peers))].slice(0, 10),
        intensity: Math.min(1, 0.7 + hits.length * 0.15),
      });
    }
  }

  /* AI-like polish — risk only */
  if (ctx.enabled("openend.ai_like")) {
    ends = endsFor("openend.ai_like");
    const thr = ctx.param<number>("openend.ai_like", "score");
    const hits = ends.map((e) => ({ ...e, score: polishedTextScore(e.text) })).filter((e) => e.score >= thr);
    if (hits.length) {
      out.push({
        ruleId: "openend.ai_like",
        observed: hits.map((h) => `${code(h.q)}: polish score ${Math.round(h.score * 100) / 100}, ${words(h.text).length} words`).join("; "),
        expected: `< ${thr}`,
        explanation: "Unusually polished, connector-heavy, evenly structured prose. This is a risk signal, not proof that a tool wrote it.",
        questionIds: hits.map((h) => h.q.id),
        intensity: Math.min(1, hits[0].score),
      });
    }
  }

  /* pasted with minimal editing */
  if (ctx.enabled("openend.pasted") && ctx.telemetry && !ctx.disabledTelemetry.has("clipboard")) {
    ends = endsFor("openend.pasted");
    const thr = ctx.param<number>("openend.pasted", "share");
    const hits = ends.filter((e) => {
      const qt = ctx.telemetry!.questions[e.q.id];
      return qt && qt.pastes > 0 && e.text.length >= 20 && qt.pasteChars / Math.max(1, e.text.length) >= thr;
    });
    if (hits.length) {
      out.push({
        ruleId: "openend.pasted",
        observed: hits.map((e) => `${code(e.q)}: ${ctx.telemetry!.questions[e.q.id].pasteChars} of ${e.text.length} characters pasted`).join("; "),
        expected: `pasted share < ${pct(thr)}`,
        explanation: "Most of the text arrived by paste and was barely edited.",
        questionIds: hits.map((e) => e.q.id),
      });
    }
  }

  return out;
}
