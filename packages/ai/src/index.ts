import { pickCategory, pickSentiment, fakeClassify, fakeSentiment, fakeProbe, placeholderMismatch, placeholdersIn } from "@rescript/engine";
import { approxTokens, reportUsage } from "./usage.js";
import { ProviderError, classifyResponse, redact, DEFAULT_RETRY, fallbackProvider, isProviderError, logProvider, managedSend, type ProviderEvent, type RetryPolicy } from "./provider.js";
export * from "./provider.js";
export * from "./connection.js";
export * from "./registry.js";
export * from "./netguard.js";
import { aiFetch, currentAiScope, scopedProvider, type ConnectionSource, type SttScope, type SttTarget, type Target } from "./connection.js";
import { guardedFetch } from "./netguard.js";

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
 *   AI_MODEL     model name (default gpt-4o-mini) — the LARGE tier: drafting
 *   AI_MODEL_SMALL   a cheaper model for short structuring calls (the SMALL
 *                tier, Research Engine audit Phase 6); falls back to AI_MODEL
 *
 *   AI_STT_API_URL   base URL of a provider serving POST
 *                    <base>/audio/transcriptions. Falls back to AI_API_URL.
 *   AI_STT_API_KEY   bearer token for it. Falls back to AI_API_KEY.
 *   AI_STT_MODEL     model name (default whisper-1)
 *
 * Speech-to-text is configured separately because it is usually a different
 * vendor. Anthropic's API is OpenAI-compatible for chat and has no
 * transcription endpoint at all; an installation that names it for AI_API_URL
 * is correctly configured for classification, sentiment and probes, and
 * cannot transcribe a thing. `sttUnavailableReason()` says so in a sentence
 * rather than letting every clip collect a 404.
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

/** the user's chat connection for this request, if the call runs inside one (else the installation's environment is the provider) */
function userChat() { return scopedProvider("chat") ? currentAiScope()!.chat! : null; }
function userStt(): SttScope | null { return scopedProvider("stt") ? currentAiScope()!.stt! : null; }
const trimBase = (s: string) => s.trim().replace(/\/+$/, "");
/** the chat provider's address and key for THIS call: the user's connection when the call runs inside one, else the installation's */
function chatBase(): string { const u = userChat(); return u ? trimBase(u.base) : trimBase(process.env.AI_API_URL ?? ""); }
function chatKey(): string { const u = userChat(); return u ? u.key : (process.env.AI_API_KEY ?? "").trim(); }
function ttsModelName(): string { const u = userChat(); return u ? (u.ttsModel || "tts-1") : (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1"; }

/**
 * The installation's own chat provider as a `Target` — what a user who ALLOWED
 * the platform as a last resort lists among their fallbacks. Read from the
 * environment, never from a scope. `null` when no real provider is configured
 * (the fake provider is not a fallback anyone chose).
 */
export function platformTarget(env: Record<string, string | undefined> = process.env): Target | null {
  const base = trimBase(env.AI_API_URL ?? "");
  if (!base || base === "fake:") return null;
  const model = (env.AI_MODEL ?? "").trim() || "gpt-4o-mini";
  return { provider: "platform", base, key: (env.AI_API_KEY ?? "").trim(), model, modelSmall: (env.AI_MODEL_SMALL ?? "").trim() || model, platform: true, label: "Platform AI" };
}

export function aiConfigured(): boolean {
  const u = userChat();
  if (u) return !!u.base;
  return !!(process.env.AI_API_URL ?? "").trim();
}

export function aiProviderName(): "fake" | "openai-compatible" | null {
  if (userChat()) return "openai-compatible";
  const url = (process.env.AI_API_URL ?? "").trim();
  if (!url) return null;
  return url === "fake:" ? "fake" : "openai-compatible";
}

/* ------------------------------------------------- speech-to-text provider */

/**
 * SPEECH-TO-TEXT IS A SEPARATE PROVIDER, AND USUALLY A DIFFERENT VENDOR.
 *
 * `AI_API_URL` was assumed to serve both chat and transcription. That is
 * wrong for the commonest configuration there is: Anthropic's API is
 * OpenAI-compatible for `/chat/completions` and has NO speech-to-text
 * endpoint at all, so an installation pointed at `api.anthropic.com` gets
 * working classification, sentiment and probes — and a 404 on every
 * transcription, with nothing in the configuration to suggest why.
 *
 *   AI_STT_API_URL   base URL of a provider that serves
 *                    POST <base>/audio/transcriptions (OpenAI, Groq,
 *                    a self-hosted Whisper, …). Falls back to AI_API_URL.
 *   AI_STT_API_KEY   bearer token for it. Falls back to AI_API_KEY.
 *   AI_STT_MODEL     the model name (default whisper-1).
 *
 * The fallback is kept because an installation using OpenAI for everything
 * should not have to say so twice. The point is that it is now possible to
 * say otherwise.
 */
/**
 * EXTRA HEADERS FOR THE AI PROVIDER — for providers that need more than a
 * bearer key on every request.
 *
 *   AI_WORKSPACE_ID   sent as `anthropic-workspace-id`. An Anthropic API key
 *                     that is not scoped to a workspace is refused with
 *                     "must include the anthropic-workspace-id header"
 *                     unless every request names the workspace; this names it.
 *   AI_API_HEADERS    any other headers, as a JSON object
 *                     ({"OpenAI-Organization":"org_…"}). Invalid JSON is
 *                     ignored with a warning, never sent half-parsed.
 *
 * Read from the server environment only, like the key; nothing here is ever
 * returned to a caller or logged. A header that would replace the key
 * (authorization) or the body's type is not accepted from AI_API_HEADERS.
 */
export function aiExtraHeaders(): Record<string, string> {
  /* a user's provider gets the headers THEIR configuration names — never the installation's workspace or organization */
  const u = userChat();
  if (u) return { ...(u.headers ?? {}) };
  return envExtraHeaders();
}

/** the installation's own extra headers (AI_API_HEADERS, AI_WORKSPACE_ID) — for the platform provider and a platform fallback the user allowed */
export function envExtraHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = (process.env.AI_API_HEADERS ?? "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const name = k.trim();
          if (!/^[A-Za-z0-9-]+$/.test(name) || /^(?:authorization|content-type|content-length|host)$/i.test(name)) continue;
          if (typeof v === "string" || typeof v === "number") out[name.toLowerCase()] = String(v);
        }
      } else console.warn("[rescript:ai] AI_API_HEADERS must be a JSON object; ignored");
    } catch { console.warn("[rescript:ai] AI_API_HEADERS is not valid JSON; ignored"); }
  }
  const ws = (process.env.AI_WORKSPACE_ID ?? "").trim();
  if (ws) out["anthropic-workspace-id"] = ws;
  return out;
}

/** The headers of one request to the configured AI provider: the key, and the extra headers above. */
function providerHeaders(key: string, json = true, extra: Record<string, string> = aiExtraHeaders()): Record<string, string> {
  return { ...(json ? { "content-type": "application/json" } : {}), ...extra, ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

export function sttBase(): string {
  const u = userStt();
  if (u) return trimBase(u.base);
  const own = (process.env.AI_STT_API_URL ?? "").trim();
  return (own || (process.env.AI_API_URL ?? "").trim()).replace(/\/+$/, "");
}

/** the transcription provider is the chat provider (no AI_STT_API_URL of its own): it gets the same extra headers */
function sameProviderAsChat(base: string): boolean {
  if (userStt()) return false; /* a user's transcription provider carries its own headers, never the chat provider's */
  return base === (process.env.AI_API_URL ?? "").trim().replace(/\/+$/, "");
}

function sttKey(): string {
  const u = userStt();
  if (u) return u.key;
  return ((process.env.AI_STT_API_KEY ?? "").trim() || (process.env.AI_API_KEY ?? "").trim());
}

/**
 * Vendors known to serve chat on an OpenAI-compatible path and no
 * transcription whatsoever.
 *
 * Hard-coding a hostname is not a thing to do lightly, and this is worth it:
 * without it the installation gets a 404 whose honest reading is "check your
 * endpoint and model", and no amount of checking the model will help, because
 * the vendor does not offer the capability. One sentence here saves a long
 * afternoon.
 */
const NO_STT_HOSTS = [
  { match: /(^|\.)anthropic\.com$/i, vendor: "Anthropic" },
];

function noSttVendor(base: string): string | null {
  if (!base || base === "fake:") return null;
  let host = "";
  try { host = new URL(base).hostname; } catch { return null; }
  return NO_STT_HOSTS.find((h) => h.match.test(host))?.vendor ?? null;
}

function noSttReason(base: string): string | null {
  const vendor = noSttVendor(base);
  if (!vendor) return null;
  const known = { vendor };
  return `${known.vendor}'s API has no speech-to-text endpoint — it is OpenAI-compatible for chat only. Set AI_STT_API_URL (and AI_STT_API_KEY) to a provider that serves /audio/transcriptions, such as OpenAI or Groq, and leave AI_API_URL as it is for everything else.`;
}

export function sttUnavailableReason(): string | null {
  const base = sttBase();
  if (!base) return "No transcription provider is configured (AI_STT_API_URL and AI_API_URL are both unset).";
  return noSttReason(base);
}

/** Whether this installation can transcribe at all. */
export function sttConfigured(): boolean {
  return !!sttBase() && !sttUnavailableReason();
}

export function sttProviderName(): "fake" | "openai-compatible" | null {
  const base = sttBase();
  if (!base) return null;
  return base === "fake:" ? "fake" : "openai-compatible";
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

/**
 * Did a provider's translation `b` keep the placeholders of source `a`? The
 * engine's one grammar decides (`placeholderMismatch`): pipes, `${…}`,
 * `[[…]]`, every `{word}` parameter and the source's question codes — the
 * same check `set_translations` applies when the text reaches the survey, so
 * nothing the provider path accepts is refused there, and the reverse.
 */
export function placeholdersMatch(a: string, b: string): boolean {
  return placeholderMismatch(a, b) === null;
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
  // the engine's placeholder grammar, then the tags — the same post-conditions the real providers are held to
  let lifted = "", at = 0;
  for (const p of placeholdersIn(text)) { lifted += text.slice(at, p.start); holes.push(p.text); lifted += `\u0000${holes.length - 1}\u0000`; at = p.end; }
  lifted += text.slice(at);
  const protectedText = lifted.replace(/<[^>]+>/g, (m) => { holes.push(m); return `\u0000${holes.length - 1}\u0000`; });
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
  const base = chatBase();
  const key = chatKey();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await aiFetch("chat", `${base}/audio/speech`, {
      method: "POST", signal: ctrl.signal, cache: "no-store",
      headers: providerHeaders(key),
      body: JSON.stringify({ model: ttsModelName(), input: t, voice: opts.voiceId || defaultVoiceFor(opts.gender), speed: Math.max(0.5, Math.min(2, opts.speed ?? 1)), response_format: opts.format ?? "mp3", ...(opts.style ? { instructions: `Speak in ${opts.language}, ${opts.style}.` } : {}) }),
    });
    if (!r.ok) { console.warn("[rescript:ai] tts provider error", JSON.stringify({ status: r.status })); return null; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length) return null;
    reportUsage({ kind: "tts", provider: "openai-compatible", model: ttsModelName(), characters: t.length, requests: 1, estimated: false });
    const mime = opts.format === "wav" ? "audio/wav" : "audio/mpeg";
    return { bytes: buf, mimeType: mime, durationMs: Math.round((t.length / 15) * 1000 / (opts.speed ?? 1)) };
  } catch (e) {
    console.warn("[rescript:ai] tts provider unreachable", JSON.stringify({ error: (e as Error).name }));
    return null;
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------- speech to text */

export interface TranscribeOptions {
  /** BCP-47 hint. Blank lets the provider detect it, which is usually right. */
  language?: string;
  /** filename the provider sees — some infer the container from its extension */
  fileName?: string;
  /** what the recording is, e.g. "audio/webm" */
  mimeType?: string;
  /** seconds, for metering; estimated from the byte count when unknown */
  durationSeconds?: number;
  /**
   * Ask for per-segment timings as well as the text.
   *
   * Costs nothing extra on an OpenAI-compatible endpoint — it is
   * `verbose_json` instead of `json` — and it is what makes a transcript
   * navigable: a reviewer clicking a quote and landing at the second it was
   * said. `locateQuote` in `@rescript/interviews` needs them.
   */
  segments?: boolean;
  /**
   * Ask the provider to separate the speakers.
   *
   * Requested, never assumed. The OpenAI Whisper endpoint does not do this;
   * several OpenAI-COMPATIBLE gateways do, through an extra field they accept
   * and the rest ignore. So the parameter is sent, the reply is parsed for
   * speaker labels, and `Transcription.diarized` says truthfully whether any
   * came back. A recording of three people transcribed by a provider that
   * cannot diarize is a transcript with one voice, and the product must know
   * that rather than assume the labels are simply missing.
   *
   * Implies `segments`: a speaker label with no timing has nothing to attach to.
   */
  diarize?: boolean;
  /**
   * A ceiling on the scaled timeout, for a caller that knows how much of its
   * own time is left (the job runner). The scaled value is never raised by
   * this, only capped.
   */
  timeoutMs?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** the provider's own anonymous label — "Speaker 1", "A". Never a name. */
  speaker?: string;
}

export interface Transcription {
  text: string;
  language?: string;
  model: string;
  durationSeconds?: number;
  /** inside a user's connection: the registry id of the provider that answered (never a key). Absent for the installation's own. */
  provider?: string;
  /** present when `segments` or `diarize` was asked for and the provider obliged */
  segments?: TranscriptSegment[];
  /**
   * Whether speaker separation ACTUALLY happened — not whether it was asked
   * for. False after a diarize request the provider ignored, which is the case
   * that must not be mistaken for "everybody sounded the same".
   */
  diarized?: boolean;
  /** how many distinct voices the provider reported, when it diarized */
  speakerCount?: number;
}

/** A rough audio-minute figure when the caller could not measure one.
 *  Opus/WebM voice is ~16 kB per second; wrong by a factor under two, which
 *  is close enough to bill honestly and far better than billing nothing. */
const BYTES_PER_SECOND = 16_000;

/**
 * TRANSCRIBE A RECORDING — the respondent's spoken answer, as text.
 *
 * OpenAI-compatible `/audio/transcriptions`, and the first **multipart**
 * provider call in this package: every other request here is JSON, and the
 * transcription endpoint takes a file part. That asymmetry is the whole
 * reason this is its own function rather than a flag on `complete`.
 *
 * The failure posture is the one every provider call in this platform has:
 * a `null` return is not an error the caller must handle loudly. It means
 * the clip stays recorded, stays uploaded, stays the answer — and the
 * transcript is simply absent, to be generated later. An interview that
 * cannot be finished because a transcription service was slow is a worse
 * outcome than an interview with a transcript still to come.
 *
 * The timeout is the TTS one, not the chat one: audio takes longer than a
 * sentence of JSON, and 8 seconds would abort legitimate work on a minute of
 * speech.
 */
/**
 * An HTTP status from a speech-to-text provider, said usefully.
 *
 * These four are the ones that actually happen when a provider is newly
 * configured, and each has a different fix — which is the whole reason for
 * not collapsing them into "returned nothing".
 */
function providerReason(status: number, model: string, detail: string): string {
  const tail = detail ? ` The service said: ${detail}` : "";
  if (status === 401 || status === 403) return `The transcription service rejected this installation's credentials (${status}). Check AI_API_KEY.${tail}`;
  if (status === 404) return `The transcription service has no /audio/transcriptions endpoint, or no model called "${model}" (404). Check AI_API_URL points at an OpenAI-compatible base URL, and AI_STT_MODEL names a speech-to-text model it offers.${tail}`;
  if (status === 429) return `The transcription service is rate-limiting this installation (429). The audio is saved — try again shortly.${tail}`;
  if (status === 400 || status === 415 || status === 422) return `The transcription service would not accept this audio (${status}).${tail}`;
  return `The transcription service returned ${status}.${tail}`;
}

/**
 * What happened, not merely whether it worked.
 *
 * `transcribe` used to answer `null` to six different questions — no bytes,
 * no provider configured, an HTTP error, an unreadable body, an empty
 * transcript, and a timeout — and the caller stored one sentence for all of
 * them. A researcher was told "the service returned nothing" when the service
 * had in fact returned 404, which is a different problem with a different
 * fix. So the reason travels with the failure.
 *
 * The reason is written for the person who will read it in the Studio, and
 * carries the provider's own words where it has any: a provider that says
 * "model whisper-1 does not exist" has diagnosed the problem better than any
 * message we could compose.
 */
export type TranscribeOutcome =
  | { ok: true; value: Transcription }
  | { ok: false; reason: string; status?: number };

/** one place a transcription can go: the user's provider, one of the fallbacks they listed, or the installation's own */
interface SttHop {
  provider: string;
  protocol: "openai-stt" | "google-stt";
  base: string;
  key: string;
  model: string;
  headers: Record<string, string>;
  source: ConnectionSource;
  limits?: { maxSeconds?: number; maxBytes?: number };
  language?: string;
}

/**
 * The installation's own transcription provider as an `SttTarget` — what a
 * user who ALLOWED the platform as a last resort lists among their fallbacks.
 * Read from the environment, never from a scope; `null` when none is usable
 * (unset, the fake provider, or a vendor with no speech endpoint).
 */
export function platformSttTarget(env: Record<string, string | undefined> = process.env): SttTarget | null {
  const own = trimBase(env.AI_STT_API_URL ?? "");
  const base = own || trimBase(env.AI_API_URL ?? "");
  if (!base || base === "fake:" || noSttReason(base)) return null;
  return { provider: "platform", protocol: "openai-stt", base, key: (env.AI_STT_API_KEY ?? "").trim() || (env.AI_API_KEY ?? "").trim(), model: (env.AI_STT_MODEL ?? "").trim() || "whisper-1", platform: true, label: "Platform AI" };
}

/** a fixed-up language tag for Google, which wants a region (en → en-US) */
const GOOGLE_REGION: Record<string, string> = { en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-BR", nl: "nl-NL", ja: "ja-JP", ko: "ko-KR", hi: "hi-IN", ru: "ru-RU", tr: "tr-TR", pl: "pl-PL", sv: "sv-SE", zh: "cmn-Hans-CN" };
const googleLanguage = (l: string | undefined): string => { const t = (l ?? "").trim().replace(/_/g, "-"); if (!t) return "en-US"; return t.includes("-") ? t : GOOGLE_REGION[t.toLowerCase()] ?? t; };

/** what Google can read, decided from the bytes (a browser's mime type carries codec suffixes and is not trusted) */
function googleEncoding(bytes: Uint8Array): { encoding?: "WEBM_OPUS" } | null {
  const at = (i: number, s: string) => s.split("").every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { encoding: "WEBM_OPUS" };
  if (bytes.length > 12 && at(0, "RIFF") && at(8, "WAVE")) return {}; /* the header names the format and rate */
  if (bytes.length > 4 && at(0, "fLaC")) return {};
  return null;
}

/** an HTTP status from the user's own speech provider, said so that the fix is theirs to make */
function ownReason(status: number, model: string, protocol: SttHop["protocol"], detail: string): string {
  const tail = detail ? ` The service said: ${detail}` : "";
  const where = " Check it in Settings → AI & Integrations → AI Provider Configuration.";
  if (status === 401) return `Your speech-to-text provider rejected the API key (401).${where}${tail}`;
  if (status === 403) return protocol === "google-stt"
    ? `Google refused this key for Speech-to-Text (403). Enable the Cloud Speech-to-Text API for the key's project, and check the key is not restricted away from it.${where}${tail}`
    : `Your speech-to-text provider refused this key for that model or endpoint (403).${where}${tail}`;
  if (status === 404) return `Your speech-to-text provider does not know the model "${model}" or has no transcription endpoint at that address (404).${where}${tail}`;
  if (status === 429) return `Your speech-to-text provider is rate-limiting this key (429), or the account has no credit left. The audio is saved — try again shortly.${tail}`;
  if (status === 400 || status === 413 || status === 415 || status === 422) return `Your speech-to-text provider would not accept this audio (${status}).${tail}`;
  return `Your speech-to-text provider returned ${status}.${tail}`;
}

type SttAttempt = { ok: true; value: Transcription } | { ok: false; reason: string; status?: number; /** another provider could cure this */ fallbackable: boolean };

export async function transcribe(
  bytes: Uint8Array,
  opts: TranscribeOptions = {},
): Promise<TranscribeOutcome> {
  if (!bytes?.length) return { ok: false, reason: "The recording was empty." };
  const seconds = opts.durationSeconds ?? Math.max(1, Math.round(bytes.length / BYTES_PER_SECOND));

  if (sttProviderName() === "fake") {
    reportUsage({ kind: "stt", provider: "fake", model: "fake-stt", seconds, requests: 1, estimated: true });
    return { ok: true, value: fakeTranscribe(bytes, opts) };
  }

  /*
   * WHERE THE CALL GOES. Outside a user's connection: the installation's
   * provider. Inside one: the user's provider, then ONLY the fallbacks the
   * user's own configuration lists, in order — the installation's key is
   * reached on a user's behalf only when they allowed the platform as a last
   * resort (it is then one of their listed fallbacks).
   */
  const mine = userStt();
  const chatUrl = trimBase(process.env.AI_API_URL ?? "");
  const hopOf = (t: SttTarget, source: ConnectionSource): SttHop => ({
    provider: t.provider, protocol: t.protocol ?? "openai-stt", base: trimBase(t.base), key: t.key, model: t.model, source,
    headers: t.platform ? (trimBase(t.base) === chatUrl ? envExtraHeaders() : {}) : t.headers ?? {},
    ...(t.limits ? { limits: t.limits } : {}), ...(t.language ? { language: t.language } : {}),
  });
  let hops: SttHop[];
  if (mine) hops = [hopOf(mine, mine.source), ...mine.fallbacks.map((f) => hopOf(f, f.platform ? "platform" : "user"))];
  else {
    const base = sttBase();
    if (!base) return { ok: false, reason: "No transcription provider is configured on this installation (AI_STT_API_URL and AI_API_URL are both unset)." };
    /* a vendor that cannot do this at all, said before the round trip */
    const impossible = sttUnavailableReason();
    if (impossible) return { ok: false, reason: impossible };
    hops = [{
      provider: "platform", protocol: "openai-stt", base, key: sttKey(), model: (process.env.AI_STT_MODEL ?? "").trim() || "whisper-1", source: "platform",
      headers: sameProviderAsChat(base) ? envExtraHeaders() : {},
    }];
  }

  let last: Extract<SttAttempt, { ok: false }> | null = null;
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const a = await attemptHop(hop, i > 0, !!mine, bytes, seconds, opts);
    if (a.ok) return a;
    last = a;
    if (!a.fallbackable) break;
    const next = hops[i + 1];
    if (next) console.warn("[rescript:ai] stt fallback", JSON.stringify({ from: hop.provider, status: a.status ?? null, to: next.provider, source: next.source }));
  }
  const failure = last!;
  const hopped = hops.length > 1 && failure.fallbackable;
  return { ok: false, reason: hopped ? `${failure.reason} (the fallback providers also failed)` : failure.reason, ...(failure.status ? { status: failure.status } : {}) };
}

/** one attempt at one provider */
async function attemptHop(hop: SttHop, usedFallback: boolean, own: boolean, bytes: Uint8Array, seconds: number, opts: TranscribeOptions): Promise<SttAttempt> {
  const isOwn = own && hop.source !== "platform";
  const label = isOwn ? "Your speech-to-text provider" : "The transcription service";
  /* what this provider cannot take, said before the round trip — and a fallback may be able to */
  const cannot = (r: string): SttAttempt => ({ ok: false, reason: r, fallbackable: true });
  if (hop.limits?.maxSeconds && seconds > hop.limits.maxSeconds) return cannot(`${label} takes recordings up to ${hop.limits.maxSeconds} seconds; this one is about ${seconds}. Use a provider that takes longer recordings, or allow the platform as a backstop.`);
  if (hop.limits?.maxBytes && bytes.length > hop.limits.maxBytes) return cannot(`${label} takes recordings up to ${Math.round(hop.limits.maxBytes / 1024 / 1024)} MB; this one is ${Math.round(bytes.length / 1024 / 1024)} MB.`);
  const vendor = hop.protocol === "openai-stt" ? noSttVendor(hop.base) : null;
  if (vendor) return cannot(isOwn ? `${vendor}'s API has no speech-to-text endpoint. Choose OpenAI, Groq, Google or another provider that serves /audio/transcriptions.` : (noSttReason(hop.base) ?? `${vendor} has no speech-to-text endpoint.`));
  const google = hop.protocol === "google-stt" ? googleEncoding(bytes) : undefined;
  if (hop.protocol === "google-stt" && !google) return cannot("Google Speech-to-Text reads WebM/Opus, WAV and FLAC recordings only; this recording is in another format. Use an OpenAI-compatible provider for it, or allow the platform as a backstop.");

  const doFetch = (url: string, init: RequestInit) => hop.source === "platform" ? fetch(url, init) : guardedFetch(url, init, { allowPrivate: currentAiScope()?.allowPrivate });
  const reasonOf = (status: number, detail: string) => isOwn ? ownReason(status, hop.model, hop.protocol, detail) : providerReason(status, hop.model, detail);
  /*
   * The timeout scales with the clip, because a fixed one is wrong at both
   * ends. Thirty seconds was generous for a fifteen-second answer and far too
   * short for five minutes of speech, which a Whisper-class service takes
   * twenty to sixty seconds to read and longer under load — so the flat
   * 30_000 aborted legitimate work and recorded it as "the provider could not
   * be reached", indistinguishable from having no provider configured at all.
   *
   * Roughly 0.4s of patience per second of audio, never less than 30s and
   * never more than 240s. The ceiling sits under the 300s the calling routes
   * are allowed, so the abort is ours — and produces a message a researcher
   * can act on — rather than the platform killing the function and producing
   * none. Each provider gets its own budget.
   */
  const scaledMs = Math.min(240_000, Math.max(30_000, Math.round(seconds * 400)));
  const budgetMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs as number) > 0
    ? Math.min(scaledMs, Math.round(opts.timeoutMs as number))
    : scaledMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  const wantSegments = !!(opts.segments || opts.diarize);
  const usage = (model: string, measured: number, estimated: boolean) => reportUsage({
    kind: "stt", provider: hop.protocol === "google-stt" ? "google" : "openai-compatible", model, seconds: measured, requests: 1, estimated,
    source: hop.source, providerId: hop.provider, ...(usedFallback ? { usedFallback: true } : {}),
  });
  const provider = own ? { provider: hop.source === "platform" ? "openai-compatible" : hop.provider } : {};
  try {
    if (hop.protocol === "google-stt") {
      const language = googleLanguage(opts.language || hop.language);
      const r = await doFetch(`${hop.base}/speech:recognize`, {
        method: "POST", signal: ctrl.signal, cache: "no-store",
        headers: { "content-type": "application/json", ...hop.headers, "x-goog-api-key": hop.key },
        body: JSON.stringify({ config: { ...google, languageCode: language, model: hop.model, enableAutomaticPunctuation: true, ...(wantSegments ? { enableWordTimeOffsets: true } : {}) }, audio: { content: Buffer.from(bytes).toString("base64") } }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        const detail = redact(text, 300);
        /* Google answers a bad key with 400 INVALID_ARGUMENT rather than 401 */
        const status = r.status === 400 && /API key not valid|API_KEY_INVALID/i.test(text) ? 401 : r.status;
        console.warn("[rescript:ai] stt provider error", JSON.stringify({ status, model: hop.model, provider: hop.provider }));
        return { ok: false, status, reason: reasonOf(status, detail), fallbackable: classifyResponse(status, r.headers, detail).fallbackable };
      }
      const j = (await r.json().catch(() => null)) as { results?: { alternatives?: { transcript?: string; words?: { startTime?: string; endTime?: string }[] }[]; resultEndTime?: string; languageCode?: string }[]; totalBilledTime?: string } | null;
      if (!j) return { ok: false, reason: `${label} replied in a format this installation could not read.`, fallbackable: false };
      const results = Array.isArray(j.results) ? j.results : [];
      const text = results.map((x) => (x.alternatives?.[0]?.transcript ?? "").trim()).filter(Boolean).join(" ").trim();
      if (!text) return { ok: false, reason: `${label} heard no speech in this recording. The audio is saved — check that it is audible, then try again.`, fallbackable: false };
      const secs = (v: string | undefined) => { const t = String(v ?? "").replace(/s$/, "").trim(); const n = t ? Number(t) : NaN; return Number.isFinite(n) ? n : NaN; };
      const billed = secs(j.totalBilledTime);
      const measured = Number.isFinite(billed) && billed > 0 ? Math.max(1, Math.round(billed)) : seconds;
      usage(hop.model, measured, !(Number.isFinite(billed) && billed > 0));
      let from = 0;
      const segments: TranscriptSegment[] = wantSegments ? results.map((x) => {
        const w = x.alternatives?.[0]?.words ?? [];
        const start = secs(w[0]?.startTime), end = secs(x.resultEndTime ?? w[w.length - 1]?.endTime);
        const seg = { start: Number.isFinite(start) ? start : from, end, text: (x.alternatives?.[0]?.transcript ?? "").trim() };
        if (Number.isFinite(end)) from = end;
        return seg;
      }).filter((sg) => Number.isFinite(sg.end) && sg.text) : [];
      return {
        ok: true,
        value: {
          text, language: results[0]?.languageCode || language, model: hop.model, durationSeconds: measured, ...provider,
          ...(segments.length ? { segments } : {}),
          /* Google can label speakers, but this adapter does not ask: said truthfully */
          ...(opts.diarize ? { diarized: false, speakerCount: 0 } : {}),
        },
      };
    }

    const form = new FormData();
    /* `Blob` over the raw array: the provider reads the part's filename and
       content type to pick a decoder, and a bare buffer gives it neither */
    form.append("file", new Blob([bytes as unknown as BlobPart], { type: opts.mimeType || "audio/webm" }), opts.fileName || "answer.webm");
    form.append("model", hop.model);
    /*
     * `verbose_json` is what carries segment timings. It is the same request
     * and the same price as `json`, so it is used whenever anything downstream
     * wants timings — and diarization implies them, since a speaker label with
     * no timing has nothing to attach to. The GPT-4o transcribe models take
     * `json` only and refuse `verbose_json`, so they are asked for the text
     * and the transcript says truthfully that it has no timings.
     */
    const jsonOnly = /transcribe/i.test(hop.model) && !/diariz/i.test(hop.model);
    const timings = wantSegments && !jsonOnly;
    form.append("response_format", timings ? "verbose_json" : "json");
    if (timings) form.append("timestamp_granularities[]", "segment");
    /*
     * Sent as an extra field rather than negotiated. Providers that diarize
     * read it; the rest ignore an unknown multipart part, which is why asking
     * is safe against an endpoint that has never heard of it.
     */
    if (opts.diarize && !jsonOnly) form.append("diarize", "true");
    const lang = opts.language || hop.language;
    if (lang) form.append("language", shortLang(lang));

    const r = await doFetch(`${hop.base}/audio/transcriptions`, {
      method: "POST", signal: ctrl.signal, cache: "no-store",
      /* deliberately NO content-type header — fetch sets it with the
         multipart boundary, and setting it by hand produces a body the
         provider cannot parse */
      headers: { ...hop.headers, ...(hop.key ? { authorization: `Bearer ${hop.key}` } : {}) },
      body: form,
    });
    if (!r.ok) {
      /*
       * The provider's own words, up to a couple of sentences. Never the
       * request — the body we sent carries the audio and the headers carry
       * the key, and neither belongs in an error a researcher reads.
       */
      const detail = redact((await r.text().catch(() => "")), 300);
      console.warn("[rescript:ai] stt provider error", JSON.stringify({ status: r.status, model: hop.model, detail }));
      return { ok: false, status: r.status, reason: reasonOf(r.status, detail), fallbackable: classifyResponse(r.status, r.headers, detail).fallbackable };
    }
    const j = (await r.json().catch(() => null)) as {
      text?: string; language?: string; duration?: number;
      segments?: { start?: number; end?: number; text?: string; speaker?: string; speaker_label?: string }[];
    } | null;
    if (!j) return { ok: false, reason: `${label} replied in a format this installation could not read.`, fallbackable: false };
    const text = (j.text ?? "").trim();
    if (!text) {
      return { ok: false, reason: `${label} heard no speech in this recording. The audio is saved — check that it is audible, then try again.`, fallbackable: false };
    }
    const measured = Number.isFinite(j?.duration) ? Math.max(1, Math.round(j!.duration!)) : seconds;
    usage(hop.model, measured, !Number.isFinite(j?.duration));

    /*
     * Segments are taken only when they are usable. A provider that returns
     * the key with no timings gives a transcript that looks navigable and
     * jumps to zero, which is worse than one that plainly has no timings.
     */
    const rawSegments = Array.isArray(j?.segments) ? j!.segments! : [];
    const segments: TranscriptSegment[] = rawSegments
      .map((sg) => ({
        start: Number(sg.start),
        end: Number(sg.end),
        text: String(sg.text ?? "").trim(),
        speaker: (sg.speaker ?? sg.speaker_label ?? "").trim() || undefined,
      }))
      .filter((sg) => Number.isFinite(sg.start) && Number.isFinite(sg.end) && sg.text);

    const speakers = new Set(segments.map((sg) => sg.speaker).filter(Boolean) as string[]);
    return {
      ok: true,
      value: {
        text, language: j?.language || opts.language, model: hop.model, durationSeconds: measured, ...provider,
        ...(segments.length ? { segments } : {}),
        /* truthful: asked-for is not the same as happened */
        ...(opts.diarize ? { diarized: speakers.size > 0, speakerCount: speakers.size } : {}),
      },
    };
  } catch (e) {
    const name = (e as Error).name;
    console.warn("[rescript:ai] stt provider unreachable", JSON.stringify({ error: name }));
    if (name === "EndpointRefused") return { ok: false, reason: `${label} is at an address this Studio will not call: ${redact((e as Error).message, 200)}`, fallbackable: false };
    return {
      ok: false, fallbackable: true,
      reason: name === "AbortError"
        ? `${label} did not answer within ${Math.round(budgetMs / 1000)} seconds. The audio is saved — try again.`
        : `${label} could not be reached. The audio is saved — try again.`,
    };
  } finally { clearTimeout(timer); }
}

/**
 * The fake transcriber. Deterministic, and deliberately NOT a fixed string:
 * it reports the clip's length and a stable id derived from the bytes, so a
 * test can tell two different recordings apart and assert that the
 * transcript belongs to the clip that produced it — which a constant could
 * never prove.
 */
export function fakeTranscribe(bytes: Uint8Array, opts: TranscribeOptions = {}): Transcription {
  const seconds = opts.durationSeconds ?? Math.max(1, Math.round(bytes.length / BYTES_PER_SECOND));
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 97) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
  const id = (h >>> 0).toString(36).slice(0, 6);
  const text = `[transcript ${id}] This is a simulated transcript of a ${seconds}-second answer.`;

  /*
   * The fake diarizes when asked, because a fake that cannot exercise the
   * interesting path is a fake that lets the interesting path ship untested.
   * Two voices alternating, which is what a moderated interview sounds like.
   */
  const want = !!(opts.segments || opts.diarize);
  const segments: TranscriptSegment[] = [];
  if (want) {
    /*
     * Four turns, not "however many sentences the filler text happens to
     * have". A fake whose segment count depends on its own punctuation is a
     * fake that silently stops exercising the multi-speaker path the day
     * somebody rewords it — which is exactly what a test caught here.
     */
    const words = text.split(/\s+/).filter(Boolean);
    const turns = 4;
    const per = Math.max(1, Math.ceil(words.length / turns));
    const parts = Array.from({ length: turns }, (_, i) =>
      words.slice(i * per, (i + 1) * per).join(" ")).filter(Boolean);
    const each = Math.max(1, seconds / Math.max(1, parts.length));
    parts.forEach((part, i) => {
      segments.push({
        start: Math.round(i * each * 100) / 100,
        end: Math.round((i + 1) * each * 100) / 100,
        text: part.endsWith(".") ? part : `${part}.`,
        ...(opts.diarize ? { speaker: `Speaker ${(i % 2) + 1}` } : {}),
      });
    });
  }

  return {
    text,
    language: opts.language ? shortLang(opts.language) : "en",
    model: "fake-stt",
    durationSeconds: seconds,
    ...(segments.length ? { segments } : {}),
    ...(opts.diarize
      ? { diarized: true, speakerCount: new Set(segments.map((s2) => s2.speaker)).size }
      : {}),
  };
}

/** "en-GB" → "en". Providers take the base tag; a region often 400s. */
const shortLang = (l: string) => (l || "").trim().split(/[-_]/)[0].toLowerCase();

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

/*
 * JSON MODE, WHERE THE PROVIDER HAS IT. OpenAI-style servers take
 * `response_format: {type: "json_object"}`; Anthropic's OpenAI-compatible
 * endpoint refuses it with a 400 ("response_format.type: Input should be
 * 'json_schema'"), and some gateways do the same. The reply is read by
 * `parseJsonReply` either way, so json mode is a nicety, never a requirement:
 * it is not sent to Anthropic, and any other provider that refuses it with a
 * 400 naming `response_format` is asked once more without it — and not sent
 * it again for the life of the process.
 */
const NO_JSON_MODE = new Set<string>();
/** bases that refused `json_schema` (a schema is then sent as `json_object`, or not at all) */
const NO_JSON_SCHEMA = new Set<string>();
export function acceptsJsonMode(base: string): boolean {
  if (NO_JSON_MODE.has(base)) return false;
  try { return !/(^|\.)anthropic\.com$/i.test(new URL(base).hostname); } catch { return true; }
}
/*
 * RETRY, PACING AND CLASSIFICATION live in provider.ts (the AI request
 * manager): a 429 is retried after the provider's own Retry-After, with
 * jittered exponential back-off, inside the caller's deadline, behind a
 * cool-down every request on this server shares; a 401, a 403 that is not a
 * rate limit, a 404 and a spent quota are never retried. This function adds
 * the one thing that is specific to the chat endpoint: json mode.
 */
/** how one request reaches its provider when it is not simply "the current scope": a fallback target says its own headers and whether the endpoint guard applies */
interface Via { headers?: Record<string, string>; guard: boolean; allowPrivate?: boolean }

async function postChat(base: string, key: string, body: Record<string, unknown>, signal: AbortSignal, retry: RetryPolicy = DEFAULT_RETRY, deadline = Date.now() + TIMEOUT_MS, label?: string, onEvent?: (e: ProviderEvent) => void, via?: Via): Promise<{ r: Response; detail?: string }> {
  const once = (b: Record<string, unknown>) => {
    const init: RequestInit = { method: "POST", signal, cache: "no-store", headers: via ? providerHeaders(key, true, via.headers ?? {}) : providerHeaders(key), body: JSON.stringify(b) };
    const url = `${base}/chat/completions`;
    return via ? (via.guard ? guardedFetch(url, init, { allowPrivate: via.allowPrivate }) : fetch(url, init)) : aiFetch("chat", url, init);
  };
  const send = (b: Record<string, unknown>): Promise<Response> => managedSend({ base, key, once: () => once(b), signal, deadline, retry, label, onEvent });
  const { response_format: format, ...plain } = body;
  const schema = !!format && typeof format === "object" && (format as { type?: string }).type === "json_schema";
  /*
   * A SCHEMA FIRST, WHERE THE PROVIDER TAKES ONE. Anthropic's compatibility
   * layer refuses `json_object` but names `json_schema` as what it wants, so
   * a schema goes to every provider; one that refuses it with a 400 naming
   * `response_format` is sent `json_object` (where that is accepted), and a
   * second refusal is remembered as "no json mode at all" for this base.
   */
  if (schema && !NO_JSON_SCHEMA.has(base)) {
    const r = await send(body);
    if (r.ok || r.status !== 400) return { r };
    const detail = (await r.text().catch(() => "")).trim();
    if (!/response_format|json_schema|schema/i.test(detail)) return { r, detail };
    NO_JSON_SCHEMA.add(base);
  }
  if (!format || !acceptsJsonMode(base)) return { r: await send(plain) };
  const r = await send({ ...plain, response_format: { type: "json_object" } });
  if (r.ok || r.status !== 400) return { r };
  const detail = (await r.text().catch(() => "")).trim();
  if (!/response_format/i.test(detail)) return { r, detail };
  NO_JSON_MODE.add(base);
  return { r: await send(plain) };
}

/* ------------------------------------------------------- prompt caching */

/*
 * PROVIDER PROMPT CACHING (AI cost audit, 2026-10-17).
 *
 * Every copilot call sent the same ~15k-character system prompt (and, for a
 * behaviour request, the same ~20k-character UX guide) at the full input
 * price, call after call. Providers cache a stable prompt PREFIX and bill a
 * read of it at a fraction of the input rate:
 *
 *   Anthropic   only through its own Messages API (`/v1/messages`) with
 *               `cache_control: {type: "ephemeral"}` on the blocks to cache
 *               (a 5-minute cache, refreshed on every hit; a write costs
 *               ~125 % of input, a read ~10 %). Its OpenAI-compatible
 *               endpoint does not cache. So a base on anthropic.com is called
 *               natively by `completeJson`; the reply, the stop reason and the
 *               usage are read back into the same shape as before.
 *   OpenAI      automatic for a prefix of 1,024+ tokens (a read ~50 %);
 *               nothing to send — `usage.prompt_tokens_details.cached_tokens`
 *               says how much was read. Keeping the stable text FIRST (the
 *               system blocks, joined) is what makes it hit.
 *
 * A call opts in by giving its system prompt as BLOCKS (or `promptCache:
 * true`): the copilot does; a call with a plain string is sent exactly as
 * before, so no other feature changes protocol or pays a cache write it never
 * reads back. `AI_PROMPT_CACHE=off` turns both off: Anthropic is then called through its
 * OpenAI-compatible endpoint exactly as before. A native request the provider
 * refuses as malformed (400) or unknown (404) is sent once more the old way,
 * and that base is not called natively again for the life of the process —
 * a protocol difference never costs a researcher their request.
 */
export function promptCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(off|0|false|no)$/i.test((env.AI_PROMPT_CACHE ?? "").trim());
}
/** bases whose native Messages API refused a request: called through the OpenAI-compatible endpoint from then on */
const NO_NATIVE = new Set<string>();
export function resetNativeRefusals(): void { NO_NATIVE.clear(); }
/** is this base Anthropic's own API, to be called natively (so its prompt cache works)? */
export function anthropicNative(base: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!promptCacheEnabled(env) || NO_NATIVE.has(base)) return false;
  try { return /(^|\.)anthropic\.com$/i.test(new URL(base).hostname); } catch { return false; }
}

/** what a provider said the call consumed, in one shape — OpenAI-style (`prompt_tokens` includes the cached part) and Anthropic Messages (`input_tokens` excludes it) alike */
export interface ChatUsageCounts {
  /** all input tokens, cached or not; undefined when the provider reported none */
  inputTokens?: number;
  outputTokens?: number;
  /** of the input: read from the provider's prompt cache */
  cachedInputTokens: number;
  /** of the input: written into it */
  cacheWriteTokens: number;
}
export function chatUsageFrom(usage: unknown): ChatUsageCounts {
  const o = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  if (n(o.prompt_tokens) == null && (n(o.input_tokens) != null || n(o.output_tokens) != null)) {
    /* Anthropic Messages: input_tokens is what was NOT read from or written to the cache */
    const read = n(o.cache_read_input_tokens) ?? 0, write = n(o.cache_creation_input_tokens) ?? 0, rest = n(o.input_tokens);
    return { inputTokens: rest == null ? undefined : rest + read + write, outputTokens: n(o.output_tokens), cachedInputTokens: rest == null ? 0 : read, cacheWriteTokens: rest == null ? 0 : write };
  }
  const details = (o.prompt_tokens_details && typeof o.prompt_tokens_details === "object" ? o.prompt_tokens_details : {}) as Record<string, unknown>;
  const input = n(o.prompt_tokens);
  const read = n(details.cached_tokens) ?? n(o.prompt_cache_hit_tokens) ?? n(o.cache_read_input_tokens) ?? 0;
  const write = n(details.cache_write_tokens) ?? n(o.cache_creation_input_tokens) ?? 0;
  if (input == null) return { inputTokens: undefined, outputTokens: n(o.completion_tokens), cachedInputTokens: 0, cacheWriteTokens: 0 };
  const r = Math.min(read, input);
  return { inputTokens: input, outputTokens: n(o.completion_tokens), cachedInputTokens: r, cacheWriteTokens: Math.min(write, input - r) };
}

type Turn = { role: "user" | "assistant"; content: string };
/** Anthropic allows at most four cache breakpoints per request */
const MAX_BREAKPOINTS = 4;
/**
 * The body of one Anthropic Messages request: the system blocks (each a cache
 * breakpoint when caching is on — the last four), the turns, the budget.
 * Exported for the tests: what is sent is the contract.
 */
export function anthropicRequest(model: string, maxTokens: number, system: readonly string[], turns: Turn[], cache = true): Record<string, unknown> {
  const parts = system.filter((s) => s.trim());
  const blocks = parts.map((text, i) => ({ type: "text", text, ...(cache && i >= parts.length - MAX_BREAKPOINTS ? { cache_control: { type: "ephemeral" } } : {}) }));
  /* the Messages API refuses an empty text block; an empty turn (a reply with no content, sent back for continuation) says so in words */
  const messages = turns.map((t) => ({ role: t.role, content: t.content.trim() ? t.content : "(empty)" }));
  return { model, max_tokens: maxTokens, temperature: 0, ...(blocks.length ? { system: blocks } : {}), messages };
}
/** Anthropic's own authentication: the key in `x-api-key`, the API version, and the extra headers (workspace) the configuration names */
function anthropicHeaders(key: string, extra: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(extra)) if (!/^(authorization|x-api-key|content-type)$/i.test(k)) h[k] = v;
  return { ...h, ...(key ? { "x-api-key": key } : {}), "anthropic-version": (process.env.AI_ANTHROPIC_VERSION ?? "").trim() || "2023-06-01" };
}
async function postMessages(base: string, key: string, body: Record<string, unknown>, signal: AbortSignal, retry: RetryPolicy, deadline: number, label?: string, onEvent?: (e: ProviderEvent) => void, via?: Via): Promise<Response> {
  const init: RequestInit = { method: "POST", signal, cache: "no-store", headers: anthropicHeaders(key, via ? via.headers ?? {} : aiExtraHeaders()), body: JSON.stringify(body) };
  const url = `${base}/messages`;
  const once = () => (via ? (via.guard ? guardedFetch(url, init, { allowPrivate: via.allowPrivate }) : fetch(url, init)) : aiFetch("chat", url, init));
  return managedSend({ base, key, once, signal, deadline, retry, label, onEvent });
}

/** a model tier: "large" drafts (AI_MODEL), "small" structures a short answer (AI_MODEL_SMALL, else AI_MODEL) — Phase 6 */
export type AiModelTier = "small" | "large";

/** The model the Studio / runtime is configured to call, by tier (the large tier when none is named). */
export function aiModelName(tier: AiModelTier = "large"): string {
  const u = userChat();
  if (u) return tier === "small" ? (u.modelSmall || u.model) : u.model;
  const large = (process.env.AI_MODEL ?? "").trim() || "gpt-4o-mini";
  if (tier === "small") return (process.env.AI_MODEL_SMALL ?? "").trim() || large;
  return large;
}

/** A fake-provider call reports the shape of a real one so the meter can show what it WOULD cost. */
function reportFake(kind: "chat", promptText: string, outputTokens: number): void {
  reportUsage({ kind, provider: "fake", model: "fake", inputTokens: approxTokens(promptText) + 60, outputTokens, requests: 1, estimated: true });
}

/**
 * ONE JSON REPLY FROM THE MODEL, UNINTERPRETED.
 *
 * `complete` below is the narrow version every existing caller uses — it
 * returns the three keys the survey product asks for. The interview analysis
 * asks for a different shape entirely (a list of claims, each with a quote),
 * and widening `complete`'s return type would make every existing call site
 * carry a union it does not care about.
 *
 * So this is the general one and `complete` is a thin reading of it. Same
 * request, same metering, same timeout: there is one place that talks to a
 * chat provider, not two that will drift.
 */
/** the output ceiling a provider named for a base + model, so the next call starts there */
const OUTPUT_CEILING = new Map<string, number>();
/**
 * The ceiling a provider's refusal names, when the request asked for more:
 * the largest number in the message below what was asked ("supports at
 * most 16384 completion tokens, whereas you provided 32000" → 16384;
 * "max_tokens: 32000 > 8192, which is the maximum allowed" → 8192). Null
 * when the message is not about the output limit, or names no smaller number.
 */
export function outputCeilingFrom(detail: string, asked: number): number | null {
  if (!/max_?tokens|completion tokens|output tokens|output limit|max_completion_tokens/i.test(detail)) return null;
  const ns = (detail.match(/\d{2,7}/g) ?? []).map(Number).filter((n) => n >= 16 && n < asked);
  return ns.length ? Math.max(...ns) : null;
}
/** forget the ceilings providers named (tests) */
export function resetOutputCeilings(): void { OUTPUT_CEILING.clear(); }

export interface CompleteJsonOptions {
  /**
   * How long to wait. Defaults to the survey product's `TIMEOUT_MS` (8 s),
   * which is right for a one-line classification and wrong for a 24k-token
   * analysis; a background job passes what it can afford. Capped at 300 s.
   */
  timeoutMs?: number;
  /**
   * A JSON schema for the reply, sent as `response_format: json_schema` to
   * providers that have it (OpenAI-style; Anthropic's compatibility layer
   * names it in its own refusal of `json_object`). A provider that refuses it
   * is sent `json_object`, or nothing, exactly as before — the schema is a
   * nicety for the provider, never a requirement.
   */
  schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /**
   * When the provider stops at `max_tokens` (`finish_reason: "length"`), ask
   * it to continue from where it stopped, up to this many times, and read
   * the pieces as one reply. Default 2 — enough for a questionnaire twice
   * the budget; a reply still cut off after that is reported as truncated
   * rather than parsed as nothing. 0 disables continuation.
   */
  continuations?: number;
  /** the tier to call — the small model for a short structuring reply (Phase 6); the large tier when absent */
  tier?: AiModelTier;
  /**
   * Retries on a 429, a 5xx, a dropped connection (default 3, so four
   * attempts; 0 turns it off) and the first pause in ms (default 800; each
   * retry doubles the window, with jitter; the provider's `Retry-After` wins).
   * Never past `deadline`/`timeoutMs`: a wait that does not fit ends the call
   * with a `ProviderError` that says how long to come back.
   */
  retries?: number;
  retryDelayMs?: number;
  /**
   * The caller's own time limit as an absolute time (ms since the epoch) — a
   * serverless route that must answer within its platform limit passes it so
   * the call, its retries and its queueing end in time to say what happened,
   * instead of being cut off by the platform with no answer at all.
   */
  deadline?: number;
  /** told what happened on the way (a retry and its wait, a recovery, the fallback) — for a caller that shows progress */
  onEvent?: (e: ProviderEvent) => void;
  /** a name for the log line ("copilot_plan") */
  operation?: string;
  /**
   * Ask the provider to cache the system blocks (see `promptCacheEnabled`).
   * Default: on when `system` is given as a list of blocks — the caller has
   * said which text is stable — and off for a plain string, so a one-off call
   * never pays a cache write it will not read back. Only on does Anthropic go
   * through its native Messages API; off, every provider is called exactly as
   * before. (OpenAI caches a long prefix by itself either way.)
   */
  promptCache?: boolean;
}

/**
 * WHY A REPLY COULD NOT BE READ — said in a code the caller can act on,
 * instead of `null`, which told the Studio nothing (Research Engine audit,
 * Phase 1: "the model's answer had nothing I could use" covered a truncated
 * questionnaire, a prose answer and an empty answer alike).
 *
 *   truncated    the provider stopped at max_tokens and the pieces did not
 *                make one JSON object, even after continuing
 *   unparseable  the provider answered, in words, with no JSON object in it,
 *                twice (the second time asked for the object alone)
 *   empty        the provider answered with no content at all
 */
export type AiReplyFailure = "truncated" | "unparseable" | "empty";
export class AiReplyError extends Error {
  constructor(public readonly code: AiReplyFailure, message: string, public readonly detail: { outputTokens?: number; maxTokens?: number; continuations?: number; sample?: string } = {}) {
    super(message);
    this.name = "AiReplyError";
  }
}
export function isAiReplyError(e: unknown): e is AiReplyError {
  return e instanceof AiReplyError || (!!e && typeof e === "object" && (e as { name?: string }).name === "AiReplyError");
}

/**
 * `system` may be a list of blocks: the STABLE text of the request (the
 * instructions, the guides), first and unchanging between calls, so the
 * provider's prompt cache can serve it (see `promptCacheEnabled`). To an
 * OpenAI-style provider the blocks are one system message, joined by a blank
 * line — exactly the text a single string would have been.
 */
export async function completeJson(
  system: string | readonly string[],
  user: string,
  maxTokens = 160,
  options: CompleteJsonOptions = {},
): Promise<unknown | null> {
  const base = chatBase();
  const model = aiModelName(options.tier);
  const key = chatKey();
  if (!base) return null;
  const systemParts: readonly string[] = typeof system === "string" ? [system] : system.map(String);
  const systemText = systemParts.join("\n\n");
  const cachePrefix = options.promptCache ?? typeof system !== "string";

  if (aiProviderName() === "fake") {
    /*
     * The fake answers with an empty object rather than inventing claims. An
     * analysis fake that produced findings would be a fake that puts words in
     * a candidate's mouth, and `verifyEvidence` would then have to drop them
     * — which is the right behaviour, exercised on made-up input.
     */
    reportFake("chat", systemText + user, 20);
    return {};
  }

  const startedAt = Date.now();
  const askedMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
    ? Math.min(300_000, Math.round(options.timeoutMs as number))
    : TIMEOUT_MS;
  /* the caller's deadline shortens the time allowed; there is always a second, so a late call fails fast and says so */
  const timeoutMs = Number.isFinite(options.deadline) ? Math.max(1_000, Math.min(askedMs, Math.round((options.deadline as number) - startedAt))) : askedMs;
  const deadline = startedAt + timeoutMs;
  const continuations = Number.isFinite(options.continuations) ? Math.max(0, Math.min(8, Math.round(options.continuations as number))) : 2;
  /*
   * THE OUTPUT LIMIT IS THE PROVIDER'S, NOT OURS (Research Engine audit,
   * Phase 7). The Studio asks for as much output as the answer needs; a
   * provider that caps `max_tokens` below that refuses with a 400 naming its
   * ceiling ("supports at most 16384 completion tokens", "max_tokens: 32000
   * > 8192, which is the maximum"), and the call is sent again at that
   * ceiling — once, remembered per base and model — rather than failing a
   * researcher's request over a number. Continuations then carry an answer
   * past the ceiling, as before.
   */
  let limit = Math.max(1, Math.round(maxTokens));
  const known = OUTPUT_CEILING.get(`${base} ${model}`);
  if (known && known < limit) limit = known;
  const retry: RetryPolicy = { retries: Number.isFinite(options.retries) ? Math.max(0, Math.min(6, Math.round(options.retries as number))) : DEFAULT_RETRY.retries, delayMs: Number.isFinite(options.retryDelayMs) ? Math.max(0, Math.min(5000, Math.round(options.retryDelayMs as number))) : DEFAULT_RETRY.delayMs, maxWaitMs: DEFAULT_RETRY.maxWaitMs };
  /*
   * WHERE THE NEXT CALL GOES. Outside a user's connection: the installation's
   * provider, then the operator's fallback (AI_FALLBACK_*), once. Inside one:
   * the user's provider, then ONLY the fallbacks the user's own configuration
   * lists, in order — the operator's fallback and the installation's key are
   * never reached on a user's behalf unless the user explicitly allowed the
   * platform as a last resort (it is then one of their listed fallbacks).
   */
  const mine = userChat();
  type Hop = { base: string; key: string; model: string; via?: Via; source: ConnectionSource; provider: string };
  const primary: Hop = { base, key, model, source: mine ? mine.source : "platform", provider: mine ? mine.provider : "openai-compatible" };
  const env = fallbackProvider();
  const fbs: Hop[] = mine
    ? mine.fallbacks.map((f: Target) => ({ base: trimBase(f.base), key: f.key, model: options.tier === "small" ? f.modelSmall || f.model : f.model, source: (f.platform ? "platform" : "user") as ConnectionSource, provider: f.provider, via: { headers: f.platform ? envExtraHeaders() : f.headers ?? {}, guard: !f.platform, allowPrivate: currentAiScope()?.allowPrivate } }))
    : env ? [{ base: env.base, key: env.key, model: options.tier === "small" ? env.modelSmall : env.model, source: "platform" as ConnectionSource, provider: "openai-compatible" }] : [];
  let target: Hop = primary;
  let next = 0;
  let onFallback = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  type Msg = Turn;
  const format = options.schema
    ? { type: "json_schema", json_schema: { name: options.schema.name, schema: options.schema.schema, ...(options.schema.strict ? { strict: true } : {}) } }
    : { type: "json_object" };
  /*
   * THE SECOND PROVIDER, WHEN ONE IS CONFIGURED. A failure the first provider
   * cannot cure on its own — it is rate-limiting past our patience, its
   * credit is spent, its key is refused, it is down — goes once to the
   * fallback the operator named, for the rest of this call. A request the
   * first provider found malformed, or a model that does not exist, would
   * fail there too and is not forwarded.
   */
  const viaFallback = async <T,>(e: ProviderError, again: () => Promise<T>): Promise<T> => {
    const f = fbs[next];
    if (!f || !e.fallbackable) throw e;
    next++;
    onFallback = true;
    target = f;
    limit = Math.min(Math.max(1, Math.round(maxTokens)), OUTPUT_CEILING.get(`${target.base} ${target.model}`) ?? Infinity);
    const toHost = (() => { try { return new URL(f.base).host; } catch { return "provider"; } })();
    logProvider("fallback", { from: e.host, kind: e.kind, status: e.status, to: toHost, model: target.model, operation: options.operation, source: f.source });
    options.onEvent?.({ type: "fallback", from: e.kind, host: toHost });
    try { return await again(); }
    catch (e2) { if (isProviderError(e2)) throw new ProviderError({ kind: e2.kind, status: e2.status, detail: `${e2.detail} (the fallback provider also failed; the first failed with ${e.kind})`, retryAfterMs: e2.retryAfterMs ?? e.retryAfterMs, host: e2.host, exhausted: true, attempts: e2.attempts, viaFallback: true }); throw e2; }
  };
  /*
   * one call, its content and why it stopped — usage reported per call, so a
   * continuation is metered like any other (and, inside one `collectUsage`,
   * summed into the ONE charge of the logical call). `messages` are the turns
   * after the system blocks, which every call of this request repeats first.
   */
  const call = async (messages: Msg[], lowered = false): Promise<{ content: string; finish: string | null; outputTokens: number }> => {
    let r: Response, refused: string | undefined;
    const native = cachePrefix && anthropicNative(target.base);
    const label = options.operation ? `${options.operation} ${target.model}` : target.model;
    try {
      if (native) r = await postMessages(target.base, target.key, anthropicRequest(target.model, limit, systemParts, messages), ctrl.signal, retry, deadline, label, options.onEvent, target.via);
      else ({ r, detail: refused } = await postChat(target.base, target.key, { model: target.model, temperature: 0, max_tokens: limit, response_format: format, messages: [{ role: "system", content: systemText }, ...messages] }, ctrl.signal, retry, deadline, label, options.onEvent, target.via));
    } catch (e) {
      if (isProviderError(e)) return viaFallback(e, () => call(messages, lowered));
      throw e;
    }
    if (!r.ok) {
      const detail = (refused ?? (await r.text().catch(() => ""))).trim().slice(0, 300);
      const ceiling = r.status === 400 && !lowered ? outputCeilingFrom(detail, limit) : null;
      if (ceiling) { OUTPUT_CEILING.set(`${target.base} ${target.model}`, ceiling); limit = ceiling; return call(messages, true); }
      const err = classifyResponse(r.status, r.headers, detail);
      /* the native API refused the request's SHAPE (not its size, not the account): the OpenAI-compatible endpoint, as before — once, and remembered */
      if (native && ((err.kind === "bad_request" && !err.contextTooLong) || err.kind === "not_found")) {
        NO_NATIVE.add(target.base);
        logProvider("native_refused", { host: (() => { try { return new URL(target.base).host; } catch { return "provider"; } })(), label, status: r.status, said: redact(detail, 200), reason: "sent again through the OpenAI-compatible endpoint; prompt caching is off for this provider until restart" });
        return call(messages, lowered);
      }
      const exhausted = new ProviderError({ kind: err.kind, status: r.status, detail: detail.slice(0, 200), retryAfterMs: err.retryAfterMs, host: err.host, exhausted: err.retryable, viaFallback: onFallback, contextTooLong: err.contextTooLong });
      /* a refusal of the request itself is the one failure the request manager does not log (json-mode probing would flood it): the ladder is over, so what the provider said is logged here — once, redacted — because it is the only way an administrator learns why */
      if (exhausted.kind === "bad_request") logProvider("refused", { host: exhausted.host ?? (() => { try { return new URL(target.base).host; } catch { return "provider"; } })(), label: options.operation ? `${options.operation} ${target.model}` : target.model, kind: "bad_request", status: r.status, said: exhausted.detail.slice(0, 200), maxTokens: limit, schema: !!options.schema, attempts: 1, reason: "the request was refused" });
      return viaFallback(exhausted, () => call(messages, lowered));
    }
    const j = await r.json().catch(() => null) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      content?: { type?: string; text?: string }[];
      stop_reason?: string | null;
      usage?: unknown;
      model?: string;
    } | null;
    /* the Messages API answers in content blocks and says `max_tokens` where an OpenAI-style one says `length` */
    const content = native ? (j?.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("") : j?.choices?.[0]?.message?.content ?? "";
    const finish = native ? (j?.stop_reason === "max_tokens" ? "length" : j?.stop_reason ?? null) : j?.choices?.[0]?.finish_reason ?? null;
    const u = chatUsageFrom(j?.usage);
    const outputTokens = typeof u.outputTokens === "number" ? u.outputTokens : approxTokens(content);
    reportUsage({
      kind: "chat", provider: "openai-compatible", model: j?.model || target.model, source: target.source, providerId: target.provider, ...(onFallback ? { usedFallback: true } : {}),
      inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : approxTokens(systemText + messages.map((m) => m.content).join("")),
      outputTokens,
      ...(u.cachedInputTokens ? { cachedInputTokens: u.cachedInputTokens } : {}),
      ...(u.cacheWriteTokens ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
      requests: 1, estimated: typeof u.inputTokens !== "number",
    });
    return { content, finish, outputTokens };
  };
  const read = (content: string): unknown | null => {
    try { return JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch { return parseJsonReply(content); }   /* without json mode the object can come after a sentence */
  };
  try {
    const messages: Msg[] = [{ role: "user", content: user }];
    let { content, finish, outputTokens } = await call(messages);
    /*
     * CUT OFF AT THE OUTPUT BUDGET. A survey of forty questions with options,
     * roles and a plan does not fit the budget the copilot allows, and the
     * cut-off JSON parsed as nothing: "the model's answer had nothing I could
     * use" for a question of size. The provider says why it stopped
     * (`finish_reason: "length"`), so the reply is continued — the partial
     * answer sent back as the assistant's, with one instruction to go on from
     * exactly where it stopped — and the pieces are read as one.
     */
    let continued = 0;
    let total = outputTokens;
    while (finish === "length" && continued < continuations) {
      const more = await call([...messages, { role: "assistant", content }, { role: "user", content: "Your answer was cut off. Continue EXACTLY from where it stopped — output only the remaining characters of the same JSON, with no preamble, no repetition and no code fence." }]);
      content += more.content;
      finish = more.finish;
      total += more.outputTokens;
      continued += 1;
    }
    if (!content.trim()) throw new AiReplyError("empty", "the model answered with no content", { outputTokens: total, maxTokens });
    let value = read(content);
    if (value == null && finish === "length") {
      throw new AiReplyError("truncated", `the model's answer was cut off at the output limit (${limit} tokens${continued ? `, continued ${continued}×` : ""}) and could not be read as one JSON object`, { outputTokens: total, maxTokens: limit, continuations: continued, sample: content.slice(-200) });
    }
    /*
     * WORDS, NOT AN OBJECT. Asked once more, for the object alone, before
     * giving up — a provider without json mode answers in prose now and then,
     * and the second ask is cheaper than a researcher retyping the request.
     */
    if (value == null) {
      const again = await call([...messages, { role: "assistant", content }, { role: "user", content: "That was not a JSON object. Reply again with ONLY the JSON object — no words before or after it, no code fence." }]);
      total += again.outputTokens;
      value = again.content.trim() ? read(again.content) : null;
      if (value == null) throw new AiReplyError("unparseable", "the model answered in words, not in the JSON shape the Studio reads, twice", { outputTokens: total, maxTokens, sample: content.slice(0, 200) });
    }
    return value;
  } catch (e) {
    /*
     * "This operation was aborted" tells a job runner nothing. Say what
     * happened in words it can classify: a timeout is transient, and the
     * number lets whoever reads the log see whether the budget was the problem.
     */
    if ((e as Error)?.name === "AbortError") {
      throw new ProviderError({ kind: "timeout", detail: `${Math.round(timeoutMs / 1000)} seconds`, exhausted: true });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ vision OCR and embeddings (the copilot's research store) */

/** The model that reads page images: AI_VISION_MODEL, else the chat model (most current chat models are multimodal). */
export function aiVisionModelName(): string {
  const u = userChat();
  if (u) return u.visionModel || u.model;
  return (process.env.AI_VISION_MODEL ?? "").trim() || aiModelName();
}
/** Embeddings are optional: only with AI_EMBEDDINGS_MODEL set. Without them retrieval is BM25 alone. */
export function aiEmbeddingsModelName(): string | null {
  const u = userChat();
  if (u) return u.embeddingsModel || null;
  return (process.env.AI_EMBEDDINGS_MODEL ?? "").trim() || null;
}

const OCR_PROMPT = "You transcribe scanned document pages. Return the page's text exactly as printed, in reading order, one paragraph per line; keep headings on their own line prefixed with '## '; write tables as rows of cells separated by ' | '. Do not summarise, translate, correct or comment. If the page has no legible text, return nothing.";

/**
 * OCR ONE PAGE IMAGE through the configured model (OpenAI-compatible vision
 * message). The research store calls it for the pages of a scanned PDF that
 * have no text layer. Returns the text, or "" when the page is blank. The
 * FAKE provider reads nothing — it cannot see — and says so by returning "".
 */
export async function ocrImage(bytes: Uint8Array, mime: string, opts: CompleteJsonOptions = {}): Promise<string> {
  const base = chatBase();
  if (!base) throw new Error("no AI provider is configured for OCR");
  if (aiProviderName() === "fake") { reportFake("chat", OCR_PROMPT + "x".repeat(3000), 0); return ""; }
  const key = chatKey();
  const model = aiVisionModelName();
  const ctrl = new AbortController();
  const timeoutMs = Math.min(300_000, opts.timeoutMs ?? 90_000);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await managedSend({ base, key, signal: ctrl.signal, deadline: Date.now() + timeoutMs, label: "ocr", once: () => aiFetch("chat", `${base}/chat/completions`, {
      method: "POST", signal: ctrl.signal, cache: "no-store",
      headers: providerHeaders(key),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: 4000,
        messages: [
          { role: "system", content: OCR_PROMPT },
          { role: "user", content: [{ type: "text", text: "Transcribe this page." }, { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } }] },
        ],
      }),
    }) });
    if (!r.ok) { const detail = (await r.text().catch(() => "")).trim().slice(0, 200); const err = new Error(`the OCR model refused the page (${r.status}) ${detail}`.trim()); (err as Error & { status?: number }).status = r.status; throw err; }
    const j = await r.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string } | null;
    const content = j?.choices?.[0]?.message?.content ?? "";
    reportUsage({ kind: "chat", provider: "openai-compatible", model: j?.model || model, inputTokens: j?.usage?.prompt_tokens ?? 1200, outputTokens: j?.usage?.completion_tokens ?? approxTokens(content), requests: 1, estimated: typeof j?.usage?.prompt_tokens !== "number" });
    return content.trim();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`the OCR model did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    throw e;
  } finally { clearTimeout(timer); }
}

/**
 * EMBEDDINGS for retrieval, when an embeddings model is configured
 * (OpenAI-compatible `/embeddings`). Null when none is — the caller then
 * ranks by BM25 alone. The fake provider has none.
 */
export async function embedTexts(texts: string[], opts: CompleteJsonOptions = {}): Promise<number[][] | null> {
  const base = chatBase();
  const model = aiEmbeddingsModelName();
  if (!base || !model || aiProviderName() === "fake" || !texts.length) return null;
  const key = chatKey();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(120_000, opts.timeoutMs ?? 30_000));
  try {
    const r = await managedSend({ base, key, signal: ctrl.signal, deadline: Date.now() + Math.min(120_000, opts.timeoutMs ?? 30_000), retry: { retries: 1, delayMs: 500, maxWaitMs: 4000 }, label: "embeddings", once: () => aiFetch("chat", `${base}/embeddings`, {
      method: "POST", signal: ctrl.signal, cache: "no-store",
      headers: providerHeaders(key),
      body: JSON.stringify({ model, input: texts.map((t) => t.slice(0, 8000)) }),
    }) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null) as { data?: { embedding?: number[]; index?: number }[]; usage?: { prompt_tokens?: number } } | null;
    const rows = (j?.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding ?? []);
    reportUsage({ kind: "chat", provider: "openai-compatible", model, inputTokens: j?.usage?.prompt_tokens ?? approxTokens(texts.join(" ")), outputTokens: 0, requests: 1, estimated: typeof j?.usage?.prompt_tokens !== "number" });
    return rows.length === texts.length && rows.every((x) => x.length) ? rows : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function complete(system: string, user: string, maxTokens = 160): Promise<{ label?: unknown; question?: unknown; translations?: unknown } | null> {
  const base = chatBase();
  const model = aiModelName();
  const key = chatKey();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const { r } = await postChat(base, key, {
      model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }, ctrl.signal, { retries: 1, delayMs: 400, maxWaitMs: 2000 }, Date.now() + TIMEOUT_MS, "respondent");
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
export { PROTOCOLS, type ServiceProtocol, type ServiceProtocolId } from "./translateServices.js";
export * from "./usage.js";

/* ------------------------------------------------------ the configuration check */

export interface ProbeStep { ok: boolean; kind?: string; status?: number; /** the provider's own words, redacted — for an administrator */ said?: string; ms: number }
export interface ProbeResult {
  configured: boolean;
  provider: "fake" | "openai-compatible" | null;
  host?: string;
  model?: string;
  /** a one-line verdict for the administrator */
  verdict: string;
  /** a tiny request with no format asked for: does the key, the model and the account work? */
  plain?: ProbeStep;
  /** the same with a JSON schema, the way the copilot asks: does this provider take it (or fall back cleanly)? */
  schema?: ProbeStep;
  /** the output ceiling the copilot asks for, and whether the provider accepts it */
  ceiling?: ProbeStep & { asked: number };
}

/**
 * ASK THE PROVIDER, IN MINIATURE, THE THREE THINGS A COPILOT REQUEST DEPENDS
 * ON — and report what it said. "The AI service could not process this
 * request" was a refusal whose reason only the provider knew and nobody could
 * see; this makes it visible in one click, for an administrator, without
 * reading a log and without pasting a key anywhere. Costs a few tokens.
 */
export async function probeProvider(opts: { maxTokens?: number } = {}): Promise<ProbeResult> {
  const base = chatBase();
  if (!base) return { configured: false, provider: null, verdict: "No AI provider is configured (AI_API_URL)." };
  const provider = aiProviderName();
  if (provider === "fake") return { configured: true, provider, model: "fake", verdict: "The built-in test provider is configured — nothing is sent anywhere." };
  const model = aiModelName();
  let host: string | undefined; try { host = new URL(base).host; } catch { /* shown as configured, unparsed */ }
  const step = async (run: () => Promise<unknown>): Promise<ProbeStep> => {
    const t = Date.now();
    try { await run(); return { ok: true, ms: Date.now() - t }; }
    catch (e) {
      if (isProviderError(e)) return { ok: false, kind: e.kind, status: e.status, said: e.detail, ms: Date.now() - t };
      if (e instanceof AiReplyError) return { ok: true, ms: Date.now() - t }; /* it answered; what it said was not JSON — the provider is reachable and accepted the request */
      return { ok: false, kind: "error", said: redact((e as Error)?.message ?? "", 200), ms: Date.now() - t };
    }
  };
  const quiet = { retries: 0, timeoutMs: 20_000, continuations: 0 } as const;
  const plain = await step(() => completeJson("Reply with the JSON object {\"ok\":true}.", "ping", 16, { ...quiet, operation: "probe_plain" }));
  /* nothing further to learn when the key, the account or the model is the problem */
  const stop = !plain.ok && ["auth", "forbidden", "quota_exhausted", "not_found", "network", "timeout"].includes(plain.kind ?? "");
  const schema = stop ? undefined : await step(() => completeJson("Reply with the JSON object {\"ok\":true}.", "ping", 32, { ...quiet, operation: "probe_schema", schema: { name: "probe", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }));
  const asked = Math.max(16, Math.round(opts.maxTokens ?? 32_000));
  const ceiling = stop ? undefined : { asked, ...(await step(() => completeJson("Reply with the JSON object {\"ok\":true}.", "ping", asked, { ...quiet, operation: "probe_ceiling" }))) };
  const verdict = plain.ok && schema?.ok && ceiling?.ok ? "The provider accepted every kind of request the copilot makes."
    : !plain.ok ? ({ auth: "The provider rejected the key (AI_API_KEY).", forbidden: "The provider refused this key's access (model, workspace or organization).", quota_exhausted: "The provider's account is out of credit or at its spending limit — add credit with the provider.", not_found: `The provider does not know the model “${model}” (AI_MODEL).`, network: "The Studio could not reach the provider (AI_API_URL).", timeout: "The provider did not answer in time.", bad_request: "The provider refused even a minimal request — read what it said below.", rate_limited: "The provider is rate-limiting this key right now.", overloaded: "The provider is overloaded right now.", server: "The provider reported an error on its side." } as Record<string, string>)[plain.kind ?? ""] ?? "The provider did not accept a minimal request — read what it said below."
    : !schema?.ok ? "A plain request works, but a request with a JSON schema is refused — read what the provider said below."
    : `A plain request works, but asking for ${asked} output tokens is refused — set AI_MAX_OUTPUT_TOKENS to what ${model} allows.`;
  return { configured: true, provider, ...(host ? { host } : {}), model, verdict, plain, ...(schema ? { schema } : {}), ...(ceiling ? { ceiling } : {}) };
}
