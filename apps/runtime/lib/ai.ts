import "server-only";
import { pickCategory, pickSentiment, fakeClassify, fakeSentiment } from "@rescript/engine";

/**
 * THE AI PROVIDER — one function per AI calc function, behind one client.
 *
 * ## Configuration (server env, never in the browser)
 *
 *   AI_API_URL   base URL of an OpenAI-compatible chat-completions API,
 *                e.g. https://api.openai.com/v1 — or the literal `fake:` to
 *                use the deterministic in-process provider below
 *   AI_API_KEY   bearer token for that API
 *   AI_MODEL     model name (default gpt-4o-mini)
 *
 * Unset means AI is OFF: `aiConfigured()` is false, `/api/session/ai` answers
 * 501, the derived variables stay unset, and the survey runs exactly as it
 * would without them. Like mail, nothing here degrades a respondent's
 * experience when the provider is absent — the classification is missing,
 * the interview is not.
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
 * "helpfully" adds an Other. If the model returns something not on the list,
 * the value is null and the miss is logged, because a category the analyst
 * did not define is worse than a blank cell. `sentiment` is the same over
 * positive / neutral / negative.
 *
 * Every call has a hard timeout. A slow provider must not stall a page
 * transition; the value simply stays unset and the respondent moves on.
 *
 * ## The fake provider
 *
 * `AI_API_URL=fake:` selects a deterministic keyword classifier. It exists so
 * the browser suite can prove the whole path — Studio expression → save-time
 * resolution → variable in logic → export — without a network or a key, and
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

/* ------------------------------------------------------- the http client */

async function complete(system: string, user: string): Promise<{ label?: unknown } | null> {
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
        max_tokens: 40,
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
