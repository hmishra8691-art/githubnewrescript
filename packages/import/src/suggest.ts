import type { CanonicalSurvey } from "./canonical.js";
import type { Clarification } from "./clarify.js";
import { plainText } from "./canonical.js";
import { nativeCapabilityListing } from "./nativeRegistry.js";

/**
 * AI-ASSISTED INSTRUCTION INTERPRETATION (import brief §11, I6).
 *
 * The rule reader (document.ts) turns the instructions it can read into logic and asks about the rest (I5).
 * For a question it could not recommend an answer to ("ASK ONLY IF THEY OWN A CAR"), a model may SUGGEST one —
 * but only by choosing among the alternatives the engine already built and checked against the real survey.
 * The model cannot invent a question, an answer, a target or a rule; it returns an index, or nothing. Its
 * suggestion is labelled as the AI's, is never pre-selected, and is applied only when a person picks it.
 *
 * This module is pure: the prompt's survey listing, the coercion of the reply, and a deterministic stand-in for
 * the fake provider. The call itself (metered, fenced as untrusted data) is the Studio route's.
 */
export interface Suggestion { id: string; choice: number; because: string }

/** the questionnaire as the model sees it: codes, kinds, short texts, answers — no HTML, no images */
export function surveyListing(c: CanonicalSurvey, max = 120): string {
  return c.questions.slice(0, max).map((q) => {
    const opts = q.options.slice(0, 15).map((o) => `${o.code}=${o.label}`).join("; ");
    return `${q.code ?? q.variable} [${q.kind}] ${plainText(q.text).replace(/\s+/g, " ").slice(0, 160)}${opts ? ` — answers: ${opts}` : ""}`;
  }).join("\n");
}

/** the open questions as the model sees them: the instruction's words and the numbered choices it may pick from */
export function choicesListing(asks: Clarification[]): string {
  return asks.map((a) => {
    const opts = a.alternatives.filter((o) => o.decision.type !== "dismiss");
    return `id: ${a.id}\ninstruction: ${a.evidence}\nquestion: ${a.question}\nchoices:\n${opts.map((o, i) => `  ${i}: ${o.label}`).join("\n")}`;
  }).join("\n\n");
}

/** only the questions that have no recommendation yet and something to choose from */
export const askable = (asks: Clarification[]) => asks.filter((a) => !a.recommended && a.alternatives.some((o) => o.decision.type !== "dismiss")).slice(0, 25);

/** the reply, checked: a known id, an index into ITS choices (never "leave it"), a short reason */
export function coerceSuggestions(raw: unknown, asks: Clarification[]): Suggestion[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { suggestions?: unknown }).suggestions) ? (raw as { suggestions: unknown[] }).suggestions : [];
  const byId = new Map(asks.map((a) => [a.id, a]));
  const out: Suggestion[] = [];
  for (const s of list.slice(0, 50)) {
    if (!s || typeof s !== "object") continue;
    const o = s as { id?: unknown; choice?: unknown; because?: unknown };
    const a = typeof o.id === "string" ? byId.get(o.id) : undefined;
    if (!a || typeof o.choice !== "number" || !Number.isInteger(o.choice)) continue;
    const opts = a.alternatives.filter((x) => x.decision.type !== "dismiss");
    if (o.choice < 0 || o.choice >= opts.length || out.some((x) => x.id === a.id)) continue;
    out.push({ id: a.id, choice: o.choice, because: typeof o.because === "string" ? o.because.replace(/\s+/g, " ").trim().slice(0, 300) : "" });
  }
  return out;
}

/** the suggestions placed as recommendations (only where the rules had none); the rest unchanged */
export function withSuggestions(asks: Clarification[], sug: Suggestion[]): Clarification[] {
  const byId = new Map(sug.map((s) => [s.id, s]));
  return asks.map((a) => {
    const s = byId.get(a.id);
    if (!s || a.recommended) return a;
    const opts = a.alternatives.filter((x) => x.decision.type !== "dismiss");
    const rec = opts[s.choice];
    return { ...a, recommended: rec, because: s.because || "Suggested by the AI from the instruction's words.", suggestedBy: "ai", alternatives: a.alternatives.filter((x) => x !== rec) };
  });
}

/**
 * THE FAKE PROVIDER'S STAND-IN (deterministic; the browser suites and local development): the choice whose
 * question shares the most meaning-words with the instruction, preferring an affirmative answer unless the
 * instruction is negative. No overlap at all → no suggestion, rather than a guess.
 */
export function fakeSuggest(c: CanonicalSurvey, asks: Clarification[]): { suggestions: Suggestion[] } {
  const STOP = new Set("a an the if only ask show display to for of in on and or who that they them their respondents respondent people those with is are do does did you your this question".split(" "));
  const stem = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "").replace(/(?:ing|ly|ed|es|s)$/, "");
  const words = (t: string) => new Set(t.split(/\s+/).map(stem).filter((w) => w.length > 2 && !STOP.has(w)));
  const byCode = new Map(c.questions.map((q) => [(q.code ?? q.variable).toUpperCase(), q]));
  const suggestions: Suggestion[] = [];
  for (const a of askable(asks)) {
    const ins = words(a.evidence);
    const negative = /\b(?:not|no|never|don'?t|doesn'?t|non)\b/i.test(a.evidence);
    const opts = a.alternatives.filter((x) => x.decision.type !== "dismiss");
    let best = -1, bestScore = 0;
    opts.forEach((o, i) => {
      const code = o.label.split(" = ")[0]?.toUpperCase();
      const q = code ? byCode.get(code) : undefined;
      const qw = words(`${q ? plainText(q.text) : ""} ${o.label}`);
      let score = [...ins].filter((w) => qw.has(w)).length;
      if (!score) return;
      const ans = (o.label.split(" = ")[1] ?? "").toLowerCase();
      if (!negative && /^(?:yes|true|agree)/.test(ans)) score += 0.5;
      if (negative && /^(?:no|false|disagree)/.test(ans)) score += 0.5;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) suggestions.push({ id: a.id, choice: best, because: `The instruction's words match ${opts[best].label.split(" = ")[0]}'s question.` });
  }
  return { suggestions };
}

export const SUGGEST_SYSTEM_PROMPT = `You help a survey programmer import a questionnaire. Some programming instructions in it could not be turned into survey logic automatically. For each open question you are given the instruction's words and a NUMBERED list of choices the import engine already built (each one is valid in the survey). Pick the choice that best matches what the instruction means, using the questionnaire for context — or null when none clearly does. Never invent a choice. Reply with ONE JSON object and nothing else:
{"suggestions":[{"id":"<the open question's id>","choice":<number or null>,"because":"<one short sentence>"}]}

What Rescript builds natively — every choice is made of these. Use this list to understand what a choice would do; it does not let you propose anything that is not one of the numbered choices:
${nativeCapabilityListing()}`;
