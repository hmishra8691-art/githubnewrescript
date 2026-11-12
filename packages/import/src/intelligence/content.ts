/**
 * TEXT AND CONTENT REVIEW (Intelligent Mode upgrade, 2026-11-13).
 *
 * Reads the wording a respondent will see — question text, instructions, answer options — and FLAGS what a careful
 * researcher would query. It never rewrites anything: the questionnaire is the researcher's, and a change to its
 * wording changes what is measured. Every finding names the question, quotes the words and says why it matters.
 *
 *   programmer_text   a programming note left where the respondent will read it ("[ASK IF Q2=1]", "PROGRAMMER:")
 *   duplicate_option  two answers of one question read the same
 *   range_overlap     numeric bands that share a value (18–25, 25–34) — a respondent aged 25 has two answers
 *   range_gap         numeric bands that skip values (18–24, 26–34)
 *   leading           wording that pushes toward an answer ("Don't you agree…", "How much do you love…")
 *   double_barrelled  one question asking about two things with one answer ("price and quality")
 *   no_escape         a required list with no "None / Other / Don't know" where the list may not cover everyone
 *   empty_label       an answer with no text
 */
import type { CanonicalQuestion, CanonicalSurvey } from "../canonical.js";

export type ContentFindingKind = "programmer_text" | "duplicate_option" | "range_overlap" | "range_gap" | "leading" | "double_barrelled" | "no_escape" | "empty_label";
export interface ContentFinding { kind: ContentFindingKind; severity: "high" | "medium" | "low"; question: string; sourceId: string; quote: string; message: string }

const plain = (s: string | undefined) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const codeOf = (q: CanonicalQuestion) => q.code ?? q.variable;

const PROGRAMMER = /\[(?:\s*(?:ASK|SHOW|SKIP|PROG|PROGRAMMER|PN|TERMINATE|RANDOMI[SZ]E|ROTATE|ANCHOR|EXCLUSIVE|SINGLE|MULTI|MULTIPLE|OPEN|INSERT|PIPE|HIDE|DISPLAY|IF|GO ?TO|SCREEN ?OUT|DO NOT READ|READ OUT)\b[^\]]*)\]|\b(?:PROGRAMMER|PROG|SCRIPTER|SCRIPTING)\s*(?:NOTE|INSTRUCTION)?S?\s*:|\bPN\s*:/;
const LEADING = /\b(?:don'?t you (?:agree|think)|wouldn'?t you (?:agree|say)|isn'?t it true|do you agree that|how much do you (?:love|enjoy|like our)|how (?:great|amazing|excellent|wonderful) (?:is|was|were)|as you know|most people (?:think|believe|agree)|surely)\b/i;
const ESCAPE = /\b(?:none|other|don'?t know|not sure|not applicable|n\/?a|prefer not|no opinion|neither|nothing)\b/i;

/** "18-24", "18 to 24", "25–34 years", "Under 18", "65+" → [lo, hi] */
function band(label: string): [number, number] | null {
  const t = plain(label).replace(/[,$€£%]/g, "");
  let m = /^(?:\D{0,12})?(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)(?:\D{0,14})?$/i.exec(t);
  if (m) return [Number(m[1]), Number(m[2])];
  m = /^(?:under|less than|below|younger than|<)\s*(\d+(?:\.\d+)?)(?:\D{0,14})?$/i.exec(t);
  if (m) return [-Infinity, Number(m[1]) - 1];
  m = /^(?:up to|<=|≤)\s*(\d+(?:\.\d+)?)(?:\D{0,14})?$/i.exec(t);
  if (m) return [-Infinity, Number(m[1])];
  m = /^(\d+(?:\.\d+)?)\s*(?:\+|or (?:more|older|over|above)|and (?:over|above|older|more))(?:\D{0,14})?$/i.exec(t) ?? /^(?:over|more than|above|older than|>)\s*(\d+(?:\.\d+)?)(?:\D{0,14})?$/i.exec(t);
  if (m) return [/^(?:over|more than|above|older than|>)/i.test(t) ? Number(m[1]) + 1 : Number(m[1]), Infinity];
  return null;
}

export function reviewContent(c: CanonicalSurvey): ContentFinding[] {
  const out: ContentFinding[] = [];
  for (const q of c.questions) {
    if (q.kind === "hidden" || q.kind === "calculated") continue;
    const code = codeOf(q);
    const add = (kind: ContentFindingKind, severity: ContentFinding["severity"], quote: string, message: string) => out.push({ kind, severity, question: code, sourceId: q.sourceId, quote: quote.slice(0, 160), message });
    const text = plain(q.text);
    const shown = [text, ...q.options.map((o) => plain(o.label)), ...q.rows.map((r) => plain(r.label))];
    for (const s of shown) {
      const m = PROGRAMMER.exec(s);
      if (m) { add("programmer_text", "high", m[0], `${code}: a programming note is in the text respondents will read (“${m[0].slice(0, 60)}”). It was kept as written — remove it from the wording once its instruction is programmed.`); break; }
    }
    const seen = new Map<string, string>();
    for (const o of q.options) {
      const k = plain(o.label).toLowerCase();
      if (!k) { add("empty_label", "medium", String(o.code), `${code}: answer ${o.code} has no text.`); continue; }
      if (seen.has(k)) add("duplicate_option", "medium", plain(o.label), `${code}: two answers read “${plain(o.label)}” (codes ${seen.get(k)} and ${o.code}).`);
      else seen.set(k, String(o.code));
    }
    const bands = q.options.map((o) => ({ label: plain(o.label), b: band(o.label) })).filter((x): x is { label: string; b: [number, number] } => !!x.b);
    if (bands.length >= 3 && bands.length >= q.options.filter((o) => !ESCAPE.test(plain(o.label))).length - 1) {
      const sorted = [...bands].sort((a, b) => a.b[0] - b.b[0]);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1], cur = sorted[i];
        if (cur.b[0] <= prev.b[1]) add("range_overlap", "high", `${prev.label} / ${cur.label}`, `${code}: “${prev.label}” and “${cur.label}” both include ${cur.b[0]} — a respondent at that value has two answers.`);
        else if (Number.isInteger(prev.b[1]) && Number.isInteger(cur.b[0]) && cur.b[0] - prev.b[1] > 1) add("range_gap", "high", `${prev.label} / ${cur.label}`, `${code}: nothing covers ${prev.b[1] + 1}${cur.b[0] - prev.b[1] > 2 ? `–${cur.b[0] - 1}` : ""} between “${prev.label}” and “${cur.label}”.`);
      }
    }
    const lead = LEADING.exec(text);
    if (lead) add("leading", "medium", lead[0], `${code}: “${lead[0]}” suggests the answer. Flagged only — the wording was not changed.`);
    if (/^(single|dropdown|nps|stars|slider)$/.test(q.kind) && /\b(?:how (?:satisfied|likely|important|would you rate)|rate|agree)\b/i.test(text)) {
      const m = /\b(?:the|our|its|their|your)\s+([a-z]+(?:\s[a-z]+)?)\s+and\s+(?:the\s+|our\s+)?([a-z]+(?:\s[a-z]+)?)\b/i.exec(text);
      if (m && m[1].toLowerCase() !== m[2].toLowerCase()) add("double_barrelled", "low", m[0], `${code} asks about “${m[1]}” and “${m[2]}” with one answer — a respondent who feels differently about each cannot say so.`);
    }
    if (q.required && /^(single|multi)$/.test(q.kind) && q.options.length >= 4 && !q.carryForward && !q.options.some((o) => ESCAPE.test(plain(o.label)) || o.exclusive || o.otherSpecify) && /\b(?:which|what)\b[^?]{0,80}\b(?:brands?|products?|stores?|providers?|apps?|websites?|sources?|channels?|reasons?)\b/i.test(text) && bands.length === 0) {
      add("no_escape", "low", text.slice(0, 80), `${code} is required and lists ${q.options.length} answers with no “Other”, “None of these” or “Don't know” — a respondent the list does not cover has to pick a wrong answer.`);
    }
  }
  return out;
}
