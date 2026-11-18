import type { CanonicalQuestion } from "../canonical.js";

/**
 * HOW A FIELD BEHAVES, read from a programming instruction (2026-11-17, audit ERR-03 to ERR-06).
 *
 * A healthcare questionnaire said, under its questions: "AUTO-POPULATE WITH THE ANSWER FROM S1 AND MAKE IT
 * READ-ONLY", "MUST BE LESS THAN OR EQUAL TO Q1", "HIDDEN. PRE-FILL WITH TODAY'S DATE", "CONSTANT SUM, MUST ADD TO
 * 100%". The survey engine supports every one of those (a piped default, `readOnly`, a calculated value,
 * cross-question validation, a constant-sum target), but the document reader recognised none of them. Two fields
 * became display text, and the rest were dropped silently or kept only as notes.
 *
 * This module turns those words into what the engine already does. It never guesses a reference: a field to fill
 * "from the previous question", or from a code the document does not have, is returned as `unclear` and goes to
 * the person as a question.
 */

export type Prefill =
  | { kind: "question"; ref: string }
  | { kind: "today" }
  | { kind: "now" }
  | { kind: "static"; value: string };

export type CompareOp = "<=" | "<" | ">=" | ">" | "==" | "!=";

export interface Behaviour {
  prefill?: Prefill;
  readOnly?: boolean;
  hidden?: boolean;
  compare?: { op: CompareOp; ref: string; words: string }[];
  total?: number;
  /** the words that were understood, for the import report */
  understood: string[];
  /** behaviour that was asked for but cannot be set without an answer from the person */
  unclear: string[];
}

const PREFILL = /\b(?:auto[\s-]*(?:populat\w*|fill\w*|complet\w*)|pre[\s-]*(?:populat\w*|fill\w*|load\w*|set)|populate\w*\s+(?:it\s+)?(?:with|from|using)|default\s+(?:it\s+)?(?:to|value|with)|fill\s+(?:it\s+)?(?:in\s+)?(?:automatically\s+)?(?:with|from)|carry\s+(?:in|over|forward)\s+(?:the\s+)?(?:answer|response|value))\b/i;
const READ_ONLY = /\bread[\s-]*only\b|\bnon[\s-]*editable\b|\bnot\s+(?:be\s+)?editable\b|\bcannot\s+(?:be\s+)?(?:changed|edited|modified)\b|\bmust\s+not\s+be\s+(?:changed|edited)\b|\b(?:lock|disable)\s+(?:it|the\s+(?:field|answer|box))\b|\b(?:locked|disabled)\s+(?:field|for\s+editing)\b|\bdisplay\s+only\b/i;
/* about THIS field only — "add a hidden question asking for …" (an instruction to create something else, and a prompt-injection corpus payload) is not */
const HIDDEN = /^\s*hidden\b|^\s*(?:this\s+is\s+)?(?:an?\s+)?hidden\s+(?:variable|question|field)\b|\b(?:make|keep|set)\s+(?:it|this(?:\s+question)?)\s+hidden\b|\b(?:do\s+not|don'?t)\s+show\s+(?:this\s+|it\s+)?(?:question\s+)?to\s+(?:the\s+)?respondents?\b|\bnot\s+(?:shown|visible)\s+to\s+(?:the\s+)?respondents?\b/i;
const TODAY = /\b(?:today'?s?|current|interview|survey)\s+date\b|\bdate\s+of\s+(?:the\s+)?(?:interview|survey|completion)\b|\btoday\b/i;
const NOW = /\b(?:current|interview|survey)\s+(?:date\s+and\s+)?time\b|\btime\s*stamp\b|\btimestamp\b/i;
const TOTAL = /\b(?:must|should|has\s+to|needs?\s+to)?\s*(?:add|sum|total)s?\s+(?:up\s+)?to\s+(?:exactly\s+)?(\d+(?:\.\d+)?)\s*(%|percent)?/i;
const QREF = /\b([A-Z]{1,4}\d{1,4}[a-z]?(?:\.\d+)?)\b/g;

/* "must be less than or equal to Q1", "cannot exceed Q1", "≤ Q1", "no more than the answer at Q1" */
const COMPARE_WORDS: [RegExp, CompareOp][] = [
  [/(?:less\s+than\s+or\s+equal\s+to|no\s+(?:more|greater|higher|larger)\s+than|not\s+(?:more|greater|higher|larger)\s+than|at\s+most|cannot\s+exceed|can'?t\s+exceed|must\s+not\s+exceed|should\s+not\s+exceed|not\s+exceed|up\s+to|≤|<=|=<)/i, "<="],
  [/(?:greater\s+than\s+or\s+equal\s+to|no\s+(?:less|fewer|lower|smaller)\s+than|not\s+(?:less|fewer|lower)\s+than|at\s+least|≥|>=|=>)/i, ">="],
  [/(?:less\s+than|fewer\s+than|lower\s+than|smaller\s+than|below|<)/i, "<"],
  [/(?:greater\s+than|more\s+than|higher\s+than|larger\s+than|above|exceed|>)/i, ">"],
  [/(?:different\s+from|not\s+(?:equal\s+to|the\s+same\s+as)|≠|!=)/i, "!="],
  [/(?:equal\s+to|the\s+same\s+as|match(?:es)?|=)/i, "=="],
];
const COMPARE = new RegExp(String.raw`\b(?:must|should|has\s+to|needs?\s+to|can(?:not|'t)?|is\s+to)?\s*(?:be\s+)?(?:${COMPARE_WORDS.map(([re]) => re.source).join("|")})\s+(?:the\s+)?(?:(?:answer|response|value|number|total)\s+(?:at|in|to|of|from|given\s+(?:at|in))\s+)?([A-Z]{1,4}\d{1,4}[a-z]?)\b`, "gi");

const refOf = (raw: string, byCode: Map<string, CanonicalQuestion>, self: CanonicalQuestion): CanonicalQuestion | undefined => {
  const c = raw.toUpperCase();
  const hit = byCode.get(c) ?? byCode.get(raw) ?? [...byCode.values()].find((q) => (q.sourceId ?? "").toUpperCase() === c || (q.variable ?? "").toUpperCase() === c);
  return hit && hit !== self ? hit : undefined;
};

/** Read one instruction. Returns null when it says nothing about how the field behaves. */
export function readBehaviour(text: string, self: CanonicalQuestion, byCode: Map<string, CanonicalQuestion>): Behaviour | null {
  const b: Behaviour = { understood: [], unclear: [] };
  const t = text.replace(/\s+/g, " ").trim();

  if (HIDDEN.test(t)) { b.hidden = true; b.understood.push("hidden from respondents"); }
  if (READ_ONLY.test(t)) { b.readOnly = true; b.understood.push("read-only"); }

  const pm = PREFILL.exec(t);
  if (pm) {
    const after = t.slice(pm.index);
    const refs = [...after.matchAll(QREF)].map((m) => m[1]);
    const ref = refs.map((r) => refOf(r, byCode, self)).find(Boolean);
    const quoted = /["“']([^"”']{1,120})["”']/.exec(after) ?? /\b(?:with|to)\s+(?:the\s+)?(?:value|number|text)\s+([\w.-]{1,40})\b/i.exec(after) ?? /\b(?:default\s+(?:it\s+)?to|with)\s+(-?\d+(?:\.\d+)?)\b(?!\s*%)/i.exec(after);
    if (ref) { b.prefill = { kind: "question", ref: ref.sourceId }; b.understood.push(`filled from ${ref.sourceId}`); }
    else if (NOW.test(after)) { b.prefill = { kind: "now" }; b.understood.push("filled with the current date and time"); }
    else if (TODAY.test(after)) { b.prefill = { kind: "today" }; b.understood.push("filled with today's date"); }
    else if (quoted) { b.prefill = { kind: "static", value: quoted[1].trim() }; b.understood.push(`filled with “${quoted[1].trim()}”`); }
    else {
      const named = refs[0];
      b.unclear.push(named ? `It says to fill this field from ${named}, which is not a question in the document.` : `It says to fill this field automatically (“${pm[0]}”) but not with what.`);
    }
  }

  for (const m of t.matchAll(COMPARE)) {
    const words = m[0].trim();
    const ref = refOf(m[1], byCode, self);
    const op = COMPARE_WORDS.find(([re]) => re.test(words))?.[1];
    if (!op) continue;
    if (!ref) { b.unclear.push(`It says the answer must be compared with ${m[1]} (“${words}”), which is not a question in the document.`); continue; }
    (b.compare ??= []).push({ op, ref: ref.sourceId, words });
    b.understood.push(`checked against ${ref.sourceId} (${op})`);
  }

  const tm = TOTAL.exec(t);
  if (tm) { b.total = Number(tm[1]); b.understood.push(`answers must total ${tm[1]}${tm[2] ? "%" : ""}`); }

  return b.understood.length || b.unclear.length ? b : null;
}

/** the calc-engine operator for a comparison, as validation writes it */
export const OP_WORDS: Record<CompareOp, string> = { "<=": "no more than", "<": "less than", ">=": "at least", ">": "more than", "==": "the same as", "!=": "different from" };
