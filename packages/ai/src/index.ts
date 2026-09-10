import { pickCategory, pickSentiment, fakeClassify, fakeSentiment, fakeProbe } from "@rescript/engine";

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
  if (aiProviderName() === "fake") return fakeClassify(t, categories);
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
  if (aiProviderName() === "fake") return fakeSentiment(t);
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
}): Promise<string | null> {
  const answer = input.answer.slice(0, MAX_TEXT);
  if (aiProviderName() === "fake") return fakeProbe(answer, input.n, input.instruction);
  const history = input.transcript.map((t, i) => `Follow-up ${i + 1}: ${t.prompt}\nAnswer: ${t.answer || "(no answer)"}`).join("\n");
  const out = await complete(
    "You are a survey interviewer writing ONE short, neutral follow-up question (a probe) to learn more about a respondent's open-ended answer. "
    + "Do not lead, do not suggest answers, do not express approval or disapproval, do not persuade, do not repeat a follow-up already asked, and stay within the interviewer's instruction. Reply with JSON only: {\"question\": \"<the follow-up>\"}.",
    `Original question: ${stripTags(input.questionText)}\nAnswer: """${answer}"""\n`
    + (history ? `${history}\n` : "")
    + (input.instruction ? `Interviewer's instruction: ${input.instruction}\n` : "")
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
  if (aiProviderName() === "fake") return fakeRephrase(text, input.variation ?? "low");
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

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/* ------------------------------------------------------- the http client */

async function complete(system: string, user: string): Promise<{ label?: unknown; question?: unknown } | null> {
  const base = (process.env.AI_API_URL ?? "").trim().replace(/\/+$/, "");
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
        model: (process.env.AI_MODEL ?? "").trim() || "gpt-4o-mini",
        temperature: 0,
        max_tokens: 160,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) {
      console.warn("[rescript:ai] provider error", JSON.stringify({ status: r.status }));
      return null;
    }
    const j = await r.json().catch(() => null) as { choices?: { message?: { content?: string } }[] } | null;
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
  } catch (e) {
    console.warn("[rescript:ai] provider unreachable", JSON.stringify({ error: (e as Error).name }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
