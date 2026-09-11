import { pickCategory, pickSentiment, fakeClassify, fakeSentiment, fakeProbe } from "@rescript/engine";
import { approxTokens, reportUsage } from "./usage.js";

/**
 * THE AI PROVIDER — one client, shared by the runtime (classification,
 * sentiment, follow-up probes for a respondent's session) and the Studio
 * (a spoken-friendly rephrasing of a question for the programmer to approve).
 *
 * ## Configuration (server env, never in the browser)
 *
 *   AI_API_URL   base URL of an OpenAI-compatible chat-completions API,
 *                e.g. https://api.openai.com/v1 — or the literal `fake:` to
 *                use the deterministic in-process provider below
 *   AI_API_KEY   bearer token for that API
 *   AI_MODEL     model name (default gpt-4o-mini)
 *
 * Unset means AI is OFF: `aiConfigured()` is false, the routes answer 501,
 * the derived variables stay unset, and the survey runs exactly as it would
 * without them. Like mail, nothing here degrades a respondent's experience
 * when the provider is absent — the classification is missing, the interview
 * is not. The key is read from the environment here and nowhere else; it is
 * never logged, never returned, never sent to a browser.
 *
 * ## Why OpenAI-compatible and nothing else
 *
 * It is the one request shape that OpenAI, Azure OpenAI, Anthropic's
 * compatibility layer, Groq, Together, Ollama and most self-hosted gateways
 * all accept. One provider implementation covers the market; a second one is
 * a decision for when a customer's contract names a vendor.
 *
 * ## The contract with the survey
 *
 * `classify` returns one of the categories the programmer listed — VERBATIM —
 * or null. It never invents a label, never returns a near-miss, never
 * "helpfully" adds an Other. `sentiment` is the same over positive / neutral /
 * negative. `writeProbe` returns one short question or null. `rephraseForSpeech`
 * returns a spoken-friendly version of a question that keeps its MEANING —
 * the programmer approves it before any respondent hears it, and the stored
 * question text is never changed.
 *
 * Every call has a hard timeout. A slow provider must not stall a page
 * transition; the value simply stays unset and the respondent moves on.
 *
 * ## The fake provider
 *
 * `AI_API_URL=fake:` selects deterministic in-process stand-ins. It exists so
 * the browser suites can prove the whole path without a network or a key, and
 * so a developer can see the feature work locally. It is selected only by
 * that explicit value; it is never a silent fallback.
 */

const TIMEOUT_MS = 8_000;
const MAX_TEXT = 4_000;

export function aiConfigured(): boolean {
  return !!(process.env.AI_API_URL ?? "").trim();
}

export function aiProviderName(): "fake" | "openai-compatible" | null {
  const url = (process.env.AI_API_URL ?? "").trim();
  if (!url) return null;
  return url === "fake:" ? "fake" : "openai-compatible";
}

/** Pick one of `categories` for `text`, or null. */
export async function classify(text: string, categories: string[]): Promise<string | null> {
  if (!categories.length) return null;
  const t = text.slice(0, MAX_TEXT);
  if (aiProviderName() === "fake") { reportFake("chat", t, 8); return fakeClassify(t, categories); }
  const out = await complete(
    "You code survey open-ends into exactly one category from a fixed list. "
    + "Reply with JSON only: {\"label\": \"<one category, copied verbatim from the list>\"}. "
    + "If none fits, choose the closest; never invent a category.",
    `Categories:\n${categories.map((c) => `- ${c}`).join("\n")}\n\nResponse:\n"""${t}"""`,
  );
  const hit = pickCategory(out?.label, categories);
  if (!hit && out) console.warn("[rescript:ai] classify returned a label not in the list", JSON.stringify({ label: out.label, categories }));
  return hit;
}

/** positive | neutral | negative, or null. */
export async function sentiment(text: string): Promise<string | null> {
  const t = text.slice(0, MAX_TEXT);
  if (aiProviderName() === "fake") { reportFake("chat", t, 4); return fakeSentiment(t); }
  const out = await complete(
    "You rate the sentiment of a survey open-end. Reply with JSON only: {\"label\": \"positive\" | \"neutral\" | \"negative\"}.",
    `Response:\n"""${t}"""`,
  );
  return pickSentiment(out?.label);
}

/**
 * Write the n-th follow-up question for an answer, or null.
 *
 * The model sees the original question, the answer, the follow-ups already
 * asked and answered, and the programmer's instruction — the research
 * objective, allowed and restricted topics and the interviewer guardrails
 * arrive in that instruction. It returns ONE short question. It never sees
 * anything else about the respondent — no other answers, no embedded data —
 * because a probe is about the answer in front of it, and because the less
 * the provider is sent, the less there is to account for. Anything that is
 * not a question (a statement, a list, an empty string, more than 300
 * characters) is discarded and the probe is skipped.
 */
export async function writeProbe(input: {
  questionText: string;
  answer: string;
  transcript: { prompt: string; answer: string }[];
  n: number;
  instruction?: string;
  /** the respondent's language — the follow-up is written in it */
  language?: string;
}): Promise<string | null> {
  const answer = input.answer.slice(0, MAX_TEXT);
  if (aiProviderName() === "fake") { reportFake("chat", answer, 40); return fakeProbe(answer, input.n, input.instruction); }
  const history = input.transcript.map((t, i) => `Follow-up ${i + 1}: ${t.prompt}\nAnswer: ${t.answer || "(no answer)"}`).join("\n");
  const out = await complete(
    "You are a survey interviewer writing ONE short, neutral follow-up question (a probe) to learn more about a respondent's open-ended answer. "
    + "Do not lead, do not suggest answers, do not express approval or disapproval, do not persuade, do not repeat a follow-up already asked, and stay within the interviewer's instruction. Reply with JSON only: {\"question\": \"<the follow-up>\"}.",
    `Original question: ${stripTags(input.questionText)}\nAnswer: """${answer}"""\n`
    + (history ? `${history}\n` : "")
    + (input.instruction ? `Interviewer's instruction: ${input.instruction}\n` : "")
    + (input.language && input.language !== "en" ? `Write the follow-up in the language with code "${input.language}" — the language the respondent is answering in.\n` : "")
    + `Write follow-up ${input.n}.`,
  );
  const q = typeof out?.question === "string" ? out.question.trim() : "";
  if (!q || q.length > 300 || !/\?\s*$/.test(q)) {
    if (out) console.warn("[rescript:ai] probe writer returned something that is not a question", JSON.stringify({ n: input.n }));
    return null;
  }
  return q;
}

/**
 * A SPOKEN-FRIENDLY VERSION OF A QUESTION — the same question, worded for the
 * ear: short sentences, no visual references ("below", "click"), no markup,
 * the same meaning and the same scale. `variation` bounds how far the wording
 * may move: low keeps the original sentence structure, high may restructure.
 * Returns null when the provider gives back something that is not a question
 * or that is far longer than the original. The programmer approves the
 * result before it is used; the displayed text never changes.
 */
export async function rephraseForSpeech(input: { questionText: string; instruction?: string; variation?: "low" | "medium" | "high"; style?: string }): Promise<string | null> {
  const text = stripTags(input.questionText).slice(0, MAX_TEXT);
  if (!text) return null;
  if (aiProviderName() === "fake") { reportFake("chat", text, approxTokens(text)); return fakeRephrase(text, input.variation ?? "low"); }
  const bound = input.variation === "high" ? "You may restructure the sentence and split it in two." : input.variation === "medium" ? "Keep the sentence structure close to the original; you may simplify words." : "Change as little as possible: only what is needed for the ear.";
  const out = await complete(
    "You rewrite a survey question so it sounds natural when READ ALOUD by a voice interviewer. Keep exactly the same meaning, the same scale and the same terms; do not add, remove or reorder answer options; do not lead. "
    + `Remove visual references ("below", "click", "select"). ${bound} Reply with JSON only: {\"question\": \"<the spoken version>\"}.`,
    `Question: """${text}"""\n${input.instruction ? `Instruction shown with it: ${stripTags(input.instruction)}\n` : ""}${input.style ? `Interviewer style: ${input.style}\n` : ""}`,
  );
  const q = typeof out?.question === "string" ? out.question.trim() : "";
  if (!q || q.length > Math.max(300, text.length * 2)) return null;
  return q;
}

/** Deterministic spoken rephrasing for the fake provider: ear-friendly, meaning intact. */
export function fakeRephrase(text: string, variation: "low" | "medium" | "high" = "low"): string {
  let t = text
    .replace(/\b(please )?(select|choose|tick|check|click)( one| all that apply)?( option| the option| the answer)?( below| from the list| that fits best)?\b/gi, "tell me")
    .replace(/\b(below|above|on the right|on the left)\b/gi, "")
    .replace(/\b(e\.g\.|eg\.)/gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/\s+/g, " ").replace(/\s+([,.?!:])/g, "$1").replace(/^tell me:\s*/i, "").trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (variation !== "low") t = t.replace(/^(To what extent|How much) do you agree/i, "How far do you agree");
  if (variation === "high" && !/^(Thinking|Now)/i.test(t)) t = `Now, ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  if (!/[.?!]$/.test(t)) t += "?";
  return t;
}

/* ---------------------------------------------------------- translation */

export interface TranslateItem { key: string; text: string; /** what the string is, for context: "question text", "answer option", "validation message"… */ kind?: string }
export interface TranslateOptions {
  sourceLanguage: string;
  targetLanguage: string;
  /** BCP-47 regional variant, when the study chose one ("es-MX", "zh-TW", "fr-CA") */
  locale?: string;
  /** preferred wordings: source term → target term (a target equal to the source means: do not translate it) */
  glossary?: { source: string; target: string }[];
  /** translator's notes for this language ("formal register", "use the Gurmukhi script") */
  notes?: string;
  /** the survey's title / topic, for terminology */
  context?: string;
}

/**
 * TRANSLATE A BATCH OF SURVEY STRINGS, with survey context.
 *
 * The model is told what each string IS (a question, an answer option, a
 * scale point, a validation message), the survey's topic, the regional
 * variant and the glossary — so a satisfaction scale stays a scale, a brand
 * stays a brand and "18–24" stays "18–24". Two invariants are enforced after
 * the model answers, not trusted to it: `{{piping}}` tokens and `{params}`
 * must survive verbatim (a translation that lost or invented one is dropped
 * and the caller sees no translation for that key rather than a broken
 * one), and HTML tags must balance. Returns key → translation for the
 * strings that came back usable.
 */
export async function translateBatch(items: TranslateItem[], opts: TranslateOptions): Promise<Record<string, string>> {
  const clean = items.filter((i) => i.text?.trim()).slice(0, 80);
  if (!clean.length) return {};
  if (aiProviderName() === "fake") { reportFake("chat", clean.map((i) => i.text).join(" "), approxTokens(clean.map((i) => i.text).join(" "))); return Object.fromEntries(clean.map((i) => [i.key, fakeTranslate(i.text, opts)])); }
  const glossary = (opts.glossary ?? []).map((g) => (g.source === g.target ? `- "${g.source}": keep exactly as written (do not translate)` : `- "${g.source}" → "${g.target}"`)).join("\n");
  const out = await complete(
    "You are a professional survey localization translator. Translate each string from the source language into the target language and regional variant, "
    + "as a market-research questionnaire would be written there: natural, neutral, the same meaning, the same register, the same scale direction. "
    + "Rules: keep every {{piping}} token and every {parameter} EXACTLY as written; keep HTML tags and their nesting; keep numbers, ranges and codes; do not add explanations; "
    + "translate answer options so they remain mutually distinct; follow the glossary exactly. Reply with JSON only: {\"translations\": {\"<key>\": \"<translation>\", ...}} with every key present.",
    `Source language: ${opts.sourceLanguage}\nTarget language: ${opts.targetLanguage}${opts.locale ? ` (${opts.locale})` : ""}\n`
    + (opts.context ? `Survey: ${stripTags(opts.context)}\n` : "")
    + (opts.notes ? `Notes for this language: ${opts.notes}\n` : "")
    + (glossary ? `Glossary:\n${glossary}\n` : "")
    + `Strings (JSON):\n${JSON.stringify(clean.map((i) => ({ key: i.key, kind: i.kind ?? "text", text: i.text })))}`,
    1200,
  );
  const raw = (out as { translations?: unknown } | null)?.translations;
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, string> = {};
  for (const i of clean) {
    const t = (raw as Record<string, unknown>)[i.key];
    if (typeof t !== "string" || !t.trim()) continue;
    if (!placeholdersMatch(i.text, t) || !tagsBalanced(t)) { console.warn("[rescript:ai] translation dropped — placeholders or HTML changed", JSON.stringify({ key: i.key })); continue; }
    result[i.key] = t.trim();
  }
  return result;
}

const PLACEHOLDER_RE = /\{\{[^}]+\}\}|\{\w+\}/g;
export function placeholdersMatch(a: string, b: string): boolean {
  const norm = (s: string) => (s.match(PLACEHOLDER_RE) ?? []).map((x) => x.replace(/\s+/g, "")).sort().join("|");
  return norm(a) === norm(b);
}
export function tagsBalanced(s: string): boolean {
  return (s.match(/</g) ?? []).length === (s.match(/>/g) ?? []).length && !/<[^>]*$/.test(s);
}

/**
 * A SMALL SURVEY DICTIONARY for the fake provider — common questionnaire
 * words in a few languages, so a local demo reads plausibly; anything else is
 * marked `[xx]` so it is unmistakably a stand-in. Placeholders, tags and
 * numbers pass through untouched, and the glossary is applied — the same
 * post-conditions the real provider is held to.
 */
const FAKE_DICT: Record<string, Record<string, string>> = {
  hi: { "yes": "हाँ", "no": "नहीं", "next": "आगे", "back": "पीछे", "submit": "जमा करें", "male": "पुरुष", "female": "महिला", "other": "अन्य", "none of the above": "इनमें से कोई नहीं", "please specify": "कृपया बताएं", "strongly agree": "पूरी तरह सहमत", "agree": "सहमत", "neutral": "तटस्थ", "disagree": "असहमत", "strongly disagree": "पूरी तरह असहमत", "very satisfied": "बहुत संतुष्ट", "satisfied": "संतुष्ट", "dissatisfied": "असंतुष्ट", "very dissatisfied": "बहुत असंतुष्ट", "what is your age?": "आपकी उम्र क्या है?", "this question is required.": "यह प्रश्न अनिवार्य है।", "thank you for completing this survey.": "इस सर्वेक्षण को पूरा करने के लिए धन्यवाद।", "great": "बहुत अच्छा", "fine": "ठीक", "poor": "ख़राब", "good": "अच्छा", "bad": "बुरा", "language": "भाषा" },
  es: { "yes": "Sí", "no": "No", "next": "Siguiente", "back": "Atrás", "submit": "Enviar", "male": "Hombre", "female": "Mujer", "other": "Otro", "none of the above": "Ninguna de las anteriores", "please specify": "Por favor, especifique", "strongly agree": "Totalmente de acuerdo", "agree": "De acuerdo", "neutral": "Neutral", "disagree": "En desacuerdo", "strongly disagree": "Totalmente en desacuerdo", "very satisfied": "Muy satisfecho", "satisfied": "Satisfecho", "dissatisfied": "Insatisfecho", "very dissatisfied": "Muy insatisfecho", "what is your age?": "¿Cuál es su edad?", "this question is required.": "Esta pregunta es obligatoria.", "thank you for completing this survey.": "Gracias por completar esta encuesta.", "great": "Excelente", "fine": "Bien", "poor": "Mal", "good": "Bueno", "bad": "Malo", "language": "Idioma" },
  fr: { "yes": "Oui", "no": "Non", "next": "Suivant", "back": "Retour", "submit": "Envoyer", "male": "Homme", "female": "Femme", "other": "Autre", "none of the above": "Aucune de ces réponses", "please specify": "Veuillez préciser", "strongly agree": "Tout à fait d'accord", "agree": "D'accord", "neutral": "Neutre", "disagree": "Pas d'accord", "strongly disagree": "Pas du tout d'accord", "what is your age?": "Quel âge avez-vous ?", "this question is required.": "Cette question est obligatoire.", "thank you for completing this survey.": "Merci d'avoir répondu à cette enquête.", "great": "Excellent", "fine": "Bien", "poor": "Mauvais", "good": "Bon", "bad": "Mauvais", "language": "Langue" },
  de: { "yes": "Ja", "no": "Nein", "next": "Weiter", "back": "Zurück", "submit": "Absenden", "male": "Männlich", "female": "Weiblich", "other": "Sonstiges", "none of the above": "Keine der genannten", "please specify": "Bitte angeben", "strongly agree": "Stimme voll zu", "agree": "Stimme zu", "neutral": "Neutral", "disagree": "Stimme nicht zu", "strongly disagree": "Stimme überhaupt nicht zu", "what is your age?": "Wie alt sind Sie?", "this question is required.": "Diese Frage ist erforderlich.", "thank you for completing this survey.": "Vielen Dank für die Teilnahme an dieser Umfrage.", "great": "Sehr gut", "fine": "Gut", "poor": "Schlecht", "good": "Gut", "bad": "Schlecht", "language": "Sprache" },
  ar: { "yes": "نعم", "no": "لا", "next": "التالي", "back": "السابق", "submit": "إرسال", "male": "ذكر", "female": "أنثى", "other": "أخرى", "what is your age?": "كم عمرك؟", "this question is required.": "هذا السؤال إلزامي.", "language": "اللغة" },
};

export function fakeTranslate(text: string, opts: TranslateOptions): string {
  const lang = opts.targetLanguage.toLowerCase().split("-")[0];
  const dict = FAKE_DICT[lang] ?? {};
  // protect placeholders and tags
  const holes: string[] = [];
  const protectedText = text.replace(/\{\{[^}]+\}\}|\{\w+\}|<[^>]+>/g, (m) => { holes.push(m); return `\u0000${holes.length - 1}\u0000`; });
  const plain = protectedText.trim().toLowerCase();
  let out: string;
  if (dict[plain]) out = dict[plain];
  else if (/^[\d\s.,%$€£+–-]+$/.test(protectedText.trim()) || !/\p{L}/u.test(protectedText)) out = protectedText;
  else out = `[${lang}] ${protectedText.trim()}`;
  for (const g of opts.glossary ?? []) {
    if (!g.source.trim()) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${g.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "giu");
    out = out.replace(re, (_, pre) => `${pre}${g.target}`);
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)]);
}

/* ---------------------------------------------------------------- speech */

export interface SpeechOptions {
  /** BCP-47 */
  language: string;
  /** a provider voice id, else the provider's default for the language */
  voiceId?: string;
  gender?: string;
  /** 0.5–2 */
  speed?: number;
  style?: string;
  format?: "mp3" | "wav";
}

/**
 * GENERATE SPOKEN AUDIO for a translated string — the "AI voice" of the
 * localization layer. OpenAI-compatible `/audio/speech`; the caller stores the
 * bytes and marks the asset AI-generated (never presented as a human
 * recording). The fake provider returns a short valid WAV tone whose length
 * follows the text, so the whole pipeline — generate, preview, approve,
 * attach, play — is testable without a vendor.
 */
export async function synthesizeSpeech(text: string, opts: SpeechOptions): Promise<{ bytes: Uint8Array; mimeType: string; durationMs: number } | null> {
  const t = stripTags(text).slice(0, 2000);
  if (!t) return null;
  if (aiProviderName() === "fake") { reportUsage({ kind: "tts", provider: "fake", model: "fake-tts", characters: t.length, requests: 1, estimated: true }); return fakeSpeech(t, opts.speed ?? 1); }
  const base = (process.env.AI_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.AI_API_KEY ?? "").trim();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(`${base}/audio/speech`, {
      method: "POST", signal: ctrl.signal, cache: "no-store",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1", input: t, voice: opts.voiceId || defaultVoiceFor(opts.gender), speed: Math.max(0.5, Math.min(2, opts.speed ?? 1)), response_format: opts.format ?? "mp3", ...(opts.style ? { instructions: `Speak in ${opts.language}, ${opts.style}.` } : {}) }),
    });
    if (!r.ok) { console.warn("[rescript:ai] tts provider error", JSON.stringify({ status: r.status })); return null; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length) return null;
    reportUsage({ kind: "tts", provider: "openai-compatible", model: (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1", characters: t.length, requests: 1, estimated: false });
    const mime = opts.format === "wav" ? "audio/wav" : "audio/mpeg";
    return { bytes: buf, mimeType: mime, durationMs: Math.round((t.length / 15) * 1000 / (opts.speed ?? 1)) };
  } catch (e) {
    console.warn("[rescript:ai] tts provider unreachable", JSON.stringify({ error: (e as Error).name }));
    return null;
  } finally { clearTimeout(timer); }
}

function defaultVoiceFor(gender?: string): string {
  return gender === "female" ? "nova" : gender === "male" ? "onyx" : "alloy";
}

/** A 16-bit mono 8 kHz WAV: a soft tone whose duration follows the text — recognisably synthetic, valid everywhere. */
export function fakeSpeech(text: string, speed = 1): { bytes: Uint8Array; mimeType: string; durationMs: number } {
  const rate = 8000;
  const durationMs = Math.min(8000, Math.max(300, Math.round((text.length / 15) * 1000 / speed)));
  const samples = Math.round((rate * durationMs) / 1000);
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const tsec = i / rate;
    const env = Math.min(1, tsec / 0.05, (samples - i) / rate / 0.05);
    data[i] = Math.round(Math.sin(2 * Math.PI * 440 * tsec) * 0.15 * 32767 * env);
  }
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, samples * 2, true);
  new Int16Array(buf, 44).set(data);
  return { bytes: new Uint8Array(buf), mimeType: "audio/wav", durationMs };
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * THE MODEL'S JSON, however it was wrapped. `response_format: json_object`
 * is honoured by OpenAI-style servers and IGNORED by others (Anthropic's
 * OpenAI-compatible endpoint, some gateways), which then answer with the
 * JSON inside a ```json fence or after a sentence. Take the first balanced
 * object in the reply; anything without one is no answer.
 */
export function parseJsonReply(content: string): { label?: unknown; question?: unknown; translations?: unknown } | null {
  const text = content.trim();
  try { return JSON.parse(text); } catch { /* wrapped */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ } }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/* ------------------------------------------------------- the http client */

/** The model the Studio / runtime is configured to call. */
export function aiModelName(): string {
  return (process.env.AI_MODEL ?? "").trim() || "gpt-4o-mini";
}

/** A fake-provider call reports the shape of a real one so the meter can show what it WOULD cost. */
function reportFake(kind: "chat", promptText: string, outputTokens: number): void {
  reportUsage({ kind, provider: "fake", model: "fake", inputTokens: approxTokens(promptText) + 60, outputTokens, requests: 1, estimated: true });
}

async function complete(system: string, user: string, maxTokens = 160): Promise<{ label?: unknown; question?: unknown; translations?: unknown } | null> {
  const base = (process.env.AI_API_URL ?? "").trim().replace(/\/+$/, "");
  const model = aiModelName();
  const key = (process.env.AI_API_KEY ?? "").trim();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) {
      console.warn("[rescript:ai] provider error", JSON.stringify({ status: r.status }));
      return null;
    }
    const j = await r.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } | null;
    const content = j?.choices?.[0]?.message?.content;
    /*
     * METERING. The provider's own count when it gives one (OpenAI-compatible
     * `usage`), an estimate from the text when it does not — reported to
     * whoever wrapped this call in `collectUsage`; nobody else notices.
     */
    const inTok = j?.usage?.prompt_tokens, outTok = j?.usage?.completion_tokens;
    reportUsage({
      kind: "chat", provider: "openai-compatible", model: j?.model || model,
      inputTokens: typeof inTok === "number" ? inTok : approxTokens(system + user),
      outputTokens: typeof outTok === "number" ? outTok : approxTokens(content ?? ""),
      requests: 1, estimated: typeof inTok !== "number",
    });
    if (!content) return null;
    return parseJsonReply(content);
  } catch (e) {
    console.warn("[rescript:ai] provider unreachable", JSON.stringify({ error: (e as Error).name }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export * from "./translation.js";
export * from "./usage.js";
