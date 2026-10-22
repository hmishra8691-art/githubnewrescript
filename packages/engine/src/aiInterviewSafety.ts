/**
 * AI-MODERATED INTERVIEWS — THE PARTICIPANT-SIDE SAFETY READINGS (2026-10-22).
 *
 * Deterministic, pure, multilingual where it matters (English, Hindi in
 * Devanagari, Hinglish): what the moderator must notice in an answer BEFORE
 * any model sees it, because the right response must not depend on a model
 * being available, cheap or obedient:
 *
 *   distress       a participant who may be at risk → a gentle check-in, an offer to stop,
 *                  and an ALERT for the researcher (never a model's improvisation)
 *   abuse          abuse or threats aimed at the moderator → one calm boundary, then the
 *                  interview ends politely on a second
 *   stop           "I want to stop" → the interview closes, thanks, and keeps what was said
 *   continue       the answer to a check-in
 *   vagueness      the rules' reading of a thin answer (the fallback's probe decision)
 *   quality        gibberish, copy-paste or typing faster than a person types, repeated
 *                  one-word answers — flags for the researcher, never a refusal
 *   contact        an e-mail address or a phone number in an answer — masked before the
 *                  model sees it (same patterns as `@rescript/analytics` redactText, pinned
 *                  by `analytics/src/qual/moderatorRedact.test.ts`)
 *
 * Manipulation ("ignore your instructions…") is read by `scanUntrusted` (untrusted.ts).
 */

const DISTRESS: RegExp[] = [
  /\b(?:kill(?:ing)? my ?self|suicid\w*|end (?:my life|it all)|want(?:ed)? to die|wish I (?:was|were) dead|don'?t want to (?:live|be alive|be here any ?more)|self[- ]?harm\w*|hurt(?:ing)? my ?self|cut(?:ting)? my ?self|no reason to live|can'?t go on|better off dead|overdose)\b/i,
  /\b(?:i am|i'?m|being|been) (?:abused|beaten|assaulted)\b|\b(?:he|she|they) (?:hits?|beats?) me\b|\bnot safe at home\b|\bunsafe at home\b/i,
  /आत्महत्या|ख़ुदकुशी|खुदकुशी|मरना चाह(?:ता|ती)|जीना नहीं चाह(?:ता|ती)|खुद को (?:नुकसान|चोट)|ख़ुद को (?:नुकसान|चोट)/,
  /\b(?:khudkushi|aatmahatya|marna chah(?:ta|ti)|mar jana chah(?:ta|ti)|jeena nahi chah(?:ta|ti)|khud ko (?:nuksan|chot))\b/i,
];
export function detectDistress(text: string): boolean { return DISTRESS.some((r) => r.test(String(text ?? ""))); }

const ABUSE: RegExp[] = [
  /\bf+u+c+k+(?:ing)? (?:you|off|this)\b|\bshut (?:the f\w* )?up\b|\byou(?:'re| are) (?:so )?(?:stupid|useless|an idiot|a moron|dumb|pathetic)\b|\b(?:stupid|dumb|useless) (?:bot|ai|robot|machine)\b|\b(?:bitch|bastard|asshole|motherf\w*|dickhead|retard)\b|\bi(?:'ll| will| am going to) (?:kill|hurt|find|hunt) you\b/i,
  /बेवकूफ़?|हरामी|कुत्ते|कमीने|चुप कर|गधे|बकवास बंद/,
  /\b(?:chutiya|bhen ?chod|madar ?chod|harami|kamina|kutt(?:e|a)|gadh(?:a|e)|chup kar|bakwas band)\b/i,
];
export function detectAbuse(text: string): boolean { return ABUSE.some((r) => r.test(String(text ?? ""))); }

const wordCount = (s: string) => (String(s ?? "").trim().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu) ?? []).length;

/** an explicit request to stop the interview — a short message, not "I wanted to stop using the service" */
export function wantsStop(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || wordCount(t) > 12) return false;
  return /^(?:(?:please|pls|ok|okay|sorry)[, ]+)?(?:stop|quit|end|exit|finish|enough)(?:\s+(?:the|this))?(?:\s+(?:interview|chat|now|here|please|it))*[.!]*$/.test(t)
    || /\b(?:i|we)\s*(?:want|would like|['’]?d like|need) to (?:stop|quit|end|leave|finish)(?: (?:the|this) (?:interview|chat))?(?: now| here| please)?[.!]*$/.test(t)
    || /\bcan we (?:stop|end|finish)(?: (?:here|now|the interview))?\??$/.test(t)
    || /\bi (?:don'?t|do not) want to (?:continue|do this|go on)(?: any ?more)?[.!]*$/.test(t)
    || /(?:रुक(?:ना|ो|िए|ें)|बंद कर(?:ो|ें|िए|ना)|बस कर(?:ो|ें|िए)|आगे नहीं करना|नहीं करना चाह(?:ता|ती))/.test(t)
    || /\b(?:band karo|band kar do|ruk jao|bas karo|stop karo|aage nahi karna)\b/.test(t);
}

/** the answer to a check-in: carry on */
export function wantsContinue(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  return /\b(?:continue|go on|carry on|keep going|go ahead|i'?m (?:ok|okay|fine|alright|good)|it'?s (?:ok|okay|fine)|let'?s continue|yes,? (?:continue|please|go on)|sure)\b/.test(t)
    || /जारी|आगे बढ़|ठीक (?:हूँ|हूं|है)|चलिए/.test(t)
    || /\b(?:chalo|aage badho|theek hai|thik hai|main theek hoon)\b/.test(t);
}

const VAGUE = /\b(?:i don'?t know|dunno|idk|not sure|no idea|maybe|it depends|kind of|sort of|stuff|things|whatever|nothing (?:much|really)|n\/?a|fine|good|ok(?:ay)?|nice|bad|normal|same)\b|पता नहीं|मालूम नहीं|ठीक है|\b(?:pata nahi|malum nahi|theek hai)\b/i;
/** the rules' reading of a thin answer: short, or mostly hedges */
export function isVague(text: string): boolean {
  const n = wordCount(text);
  if (n === 0) return true;
  if (n < 6) return true;
  return n < 14 && VAGUE.test(String(text));
}

/** a strong feeling in an answer — what a deep probe asks about */
export function hasEmotion(text: string): boolean {
  return /\b(?:love[ds]?|hate[ds]?|frustrat\w*|angry|annoy\w*|furious|upset|disappoint\w*|delight\w*|excit\w*|worr\w*|scared|afraid|anxious|stress\w*|relie(?:f|ved)|embarrass\w*|proud|regret\w*)\b|गुस्सा|परेशान|खुश|डर|निराश|\b(?:gussa|pareshan|khush|dar lag)\b/i.test(String(text ?? ""));
}

/** keyboard mash, a run of one character, no vowels in a long Latin word */
export function looksLikeGibberish(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/(.)\1{5,}/.test(t)) return true;
  if (/\b(?:asdf|qwer|zxcv|hjkl|jkjk|sdfg)\w*/i.test(t)) return true;
  const latin = t.match(/[A-Za-z]{7,}/g) ?? [];
  return latin.length > 0 && latin.filter((w) => !/[aeiouy]/i.test(w)).length / latin.length >= 0.5;
}

/** what the browser says about how an answer was entered */
export interface EntryMeta { typingMs?: number; pasted?: boolean; chars?: number; spoken?: boolean }

/**
 * Answers that a person probably did not write themselves: pasted at length, or "typed" faster than
 * people type (≈ 12 characters a second sustained over 300 characters). A FLAG for the researcher — the
 * reading is indicative, and a spoken (transcribed) answer is never judged on speed.
 */
export function looksMachineWritten(text: string, meta: EntryMeta = {}): boolean {
  if (meta.spoken) return false;
  const chars = String(text ?? "").length;
  if (meta.pasted && chars >= 200) return true;
  if (chars >= 300 && typeof meta.typingMs === "number" && meta.typingMs > 0 && chars / (meta.typingMs / 1000) > 12) return true;
  return /\bas an ai (?:language )?model\b|\bi am an ai\b|\bcertainly! here(?:'s| is)\b/i.test(String(text ?? ""));
}

/* the same two patterns as @rescript/analytics qual/redact.ts (pinned by its moderatorRedact.test.ts) */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\w£$€])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}(?![\w%])/g;
const digits = (s: string) => s.replace(/\D/g, "").length;

/**
 * E-mail addresses and phone numbers replaced by "[email]" / "[phone]" — what the model is sent
 * instead of a participant's volunteered contact details. Output identical to analytics'
 * `redactText(text).text` with no names list.
 */
export function maskContactDetails(text: string): { text: string; masked: number } {
  const t = String(text ?? "");
  const hits: { kind: "email" | "phone"; start: number; end: number }[] = [];
  for (const m of t.matchAll(EMAIL)) hits.push({ kind: "email", start: m.index!, end: m.index! + m[0].length });
  for (const m of t.matchAll(PHONE)) { const d = digits(m[0]); if (d >= 7 && d <= 15 && !/^\d{1,2}:\d{2}/.test(m[0])) hits.push({ kind: "phone", start: m.index!, end: m.index! + m[0].length }); }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: typeof hits = [];
  for (const h of hits) if (!kept.length || h.start >= kept[kept.length - 1].end) kept.push(h);
  let out = "", at = 0;
  for (const h of kept) { out += t.slice(at, h.start) + `[${h.kind}]`; at = h.end; }
  return { text: out + t.slice(at), masked: kept.length };
}

/* ------------------------------------------------------------ language */

/** the writing system a language is normally written in (null = not checked) */
export function languageScript(language: string | undefined): RegExp | null {
  const l = String(language ?? "").toLowerCase().split(/[-_]/)[0];
  if (["hi", "mr", "ne", "sa", "kok", "mai"].includes(l)) return /[ऀ-ॿ]/u;
  if (["ar", "ur", "fa", "ps"].includes(l)) return /[؀-ۿ]/u;
  if (["zh", "ja"].includes(l)) return /[぀-ヿ一-鿿]/u;
  if (l === "ko") return /[가-힯]/u;
  if (["ru", "uk", "bg", "sr", "mk", "be", "kk"].includes(l)) return /[Ѐ-ӿ]/u;
  if (["bn", "as"].includes(l)) return /[ঀ-৿]/u;
  if (l === "pa") return /[਀-੿]/u;
  if (l === "gu") return /[઀-૿]/u;
  if (l === "or") return /[଀-୿]/u;
  if (l === "ta") return /[஀-௿]/u;
  if (l === "te") return /[ఀ-౿]/u;
  if (l === "kn") return /[ಀ-೿]/u;
  if (l === "ml") return /[ഀ-ൿ]/u;
  if (l === "th") return /[฀-๿]/u;
  if (l === "he") return /[֐-׿]/u;
  if (l === "el") return /[Ͱ-Ͽ]/u;
  if (["en", "es", "fr", "de", "pt", "it", "nl", "id", "ms", "sw", "tr", "vi", "pl", "ro", "sv", "da", "no", "nb", "fi", "cs", "hu", "tl", "fil"].includes(l)) return /[A-Za-z]/;
  return null;
}

/** does `say` read as written in `language`? Unknown languages pass; for a non-Latin language the text must be mostly in its script */
export function inLanguage(say: string, language: string | undefined): boolean {
  const re = languageScript(language);
  if (!re) return true;
  const letters = [...String(say ?? "")].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return true;
  const own = letters.filter((ch) => re.test(ch)).length;
  return own / letters.length >= (re.source === "[A-Za-z]" ? 0.7 : 0.4);
}

export const shortLanguage = (language: string | undefined, fallback = "en"): string => (String(language ?? "").toLowerCase().split(/[-_]/)[0] || fallback).slice(0, 8);
