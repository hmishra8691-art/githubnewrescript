/**
 * VOICE → TEXT → ENGLISH → INTENT (UI upgrade §18–§21).
 *
 *   microphone ─► /api/ai/transcribe ─► speech-to-text provider (cloud, swappable:
 *                                        AI_STT_API_URL, the same adapter the
 *                                        interview pipeline uses)
 *                                     ─► language detection + translation to
 *                                        English (the chat model, one prompt)
 *                 ◄─ { text, language, english }
 *   Intelligent mode ─► the SAME pipeline a typed sentence takes:
 *                       grammar ─► model ─► planner ─► validation ─► review card
 *
 * Nothing about speech reaches the planner. The planner sees an English
 * sentence exactly as if it had been typed; the card shows what was heard
 * and, when it was not English, what it was read as, so the programmer can
 * check the reading before applying anything (§20, §22).
 *
 * This module is the shared, testable part: the normalisation prompt and
 * its gate on the server side, and the transcript tidy-up on both.
 */

export interface HeardTranscript {
  /** what the provider heard, in the language it was spoken */
  text: string;
  /** BCP-47 base tag the provider reported, "en" when unknown */
  language: string;
  /** the English reading, when the language was not English (or the model gave one) */
  english?: string;
  /** the provider that heard it — for the card's provenance line */
  model?: string;
}

export const NORMALISE_SYSTEM_PROMPT = `You receive the transcript of a SPOKEN instruction to a survey-programming tool, in any language. Reply with one JSON object and nothing else:
{"language":"<BCP-47 base tag of the spoken language, e.g. hi, en, mr, es, fr, de>","english":"<the instruction in plain English>"}

Rules for "english": keep survey identifiers exactly as spoken — question codes (Q5, Q10), option numbers ("option 3"), variable names, page and block names — and keep the instruction's meaning, tense and scope. Do not add, explain or answer anything. If the transcript is already English, return it tidied (punctuation, casing of codes like q5 → Q5). If it is unintelligible, return {"language":"und","english":""}.`;

/** the user turn for the normalisation prompt */
export function normaliseUserPrompt(text: string, languageHint?: string | null): string {
  return `${languageHint ? `Spoken language (provider's guess): ${languageHint}\n` : ""}Transcript: ${text.trim()}`;
}

const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** the model's reply, admitted only in the shape asked for */
export function coerceNormalised(raw: unknown): { language: string; english: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const english = typeof o.english === "string" ? o.english.trim() : "";
  const language = typeof o.language === "string" && LANG_RE.test(o.language.trim()) ? o.language.trim().split("-")[0].toLowerCase() : "";
  if (!english && language !== "und") return null;
  return { language: language || "en", english: tidyTranscript(english) };
}

/**
 * The tidy-up a transcript gets before the grammar sees it: codes spoken as
 * "q 5" or "question five" become Q5, stray spaces and trailing filler go,
 * and the sentence ends once. Deterministic, provider-independent, cheap.
 */
export function tidyTranscript(text: string): string {
  const NUM: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20" };
  let t = text.replace(/\s+/g, " ").trim();
  // "q 5", "Q-5", "question 5", "question five" → Q5 (a code, as the grammar reads it)
  t = t.replace(/\b(?:q|que|cue|queue)\s*[-.]?\s*(\d{1,3})\b/gi, (_, n) => `Q${n}`);
  t = t.replace(/\bquestion\s+(\d{1,3})\b(?!\s*(?:s|'s)\b)/gi, (_, n) => `Q${n}`);
  t = t.replace(/\bquestion\s+(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi, (_, w: string) => `Q${NUM[w.toLowerCase()]}`);
  t = t.replace(/\boption\s+(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (_, w: string) => `option ${NUM[w.toLowerCase()]}`);
  // spoken punctuation and filler
  t = t.replace(/\b(?:um+|uh+|erm+|hmm+)\b[,.]?\s*/gi, "").replace(/\s+([,.?!])/g, "$1").replace(/[.?!]{2,}$/, (m) => m[0]);
  return t.trim();
}

/** "hi" → "Hindi", for the card */
export function languageName(tag: string): string {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    return dn.of(tag) ?? tag;
  } catch { return tag; }
}

/** the recording format the browser offers, in the order the provider likes them */
export function pickRecordingMime(supported: (m: string) => boolean): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/mpeg"]) if (supported(m)) return m;
  return "";
}
