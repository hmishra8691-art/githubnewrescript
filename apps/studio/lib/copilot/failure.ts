/**
 * WHY A TURN FAILED, SAID PRECISELY (Research Engine audit, Phase 1).
 *
 * Every way the model path could fail — no model configured, the wallet
 * refusing, the provider down or slow, an answer cut off at the output
 * budget, an answer in prose, a valid object with nothing in it — reached
 * the researcher as the grammar's
 * "I did not understand that. Try 'show Q5 only when Q3 = Yes'…", which says
 * the Studio cannot read English when the truth was a configuration, a
 * budget or a provider. A failure is now one of these codes, with a title,
 * a sentence that names the cause, and what to do next — built here, in one
 * place, for the route, the card and the history.
 */
export type FailureCode =
  | "not_configured"   // no AI_API_URL on this Studio
  | "wallet"           // the meter refused (balance, limit, read-only)
  | "timeout"          // the provider did not answer in time
  | "provider"         // the provider refused the request (4xx/5xx)
  | "network"          // the request never reached the provider
  | "truncated"        // the answer was cut off at max_tokens, even after continuing
  | "unparseable"      // the answer was words, not the JSON the Studio reads
  | "empty"            // the answer had no content
  | "unusable"         // valid JSON with no reply, actions or findings
  | "engine_unparsed"; // no model, and the engine could not read the sentence

export interface TurnFailure {
  code: FailureCode;
  /** the card's kicker, upper case */
  title: string;
  /** one or two sentences naming the cause */
  message: string;
  /** what the researcher can do now */
  next: string[];
  /** a detail the message may quote (a budget, a provider status, a refusal) */
  detail?: string;
}

const TITLES: Record<FailureCode, string> = {
  not_configured: "NO LANGUAGE MODEL CONFIGURED",
  wallet: "THE WALLET REFUSED THIS CALL",
  timeout: "THE MODEL DID NOT ANSWER IN TIME",
  provider: "THE PROVIDER REFUSED THE REQUEST",
  network: "THE MODEL COULD NOT BE REACHED",
  truncated: "THE MODEL'S ANSWER WAS CUT OFF",
  unparseable: "THE MODEL ANSWERED IN WORDS, NOT CHANGES",
  empty: "THE MODEL ANSWERED WITH NOTHING",
  unusable: "THE MODEL'S ANSWER HAD NOTHING TO APPLY",
  engine_unparsed: "THE ENGINE COULD NOT READ THIS",
};

/** The failure for a code, with the cause and the next steps written for the researcher. */
export function describeFailure(code: FailureCode, detail?: string): TurnFailure {
  const d = detail?.trim() || undefined;
  switch (code) {
    case "not_configured":
      return { code, title: TITLES[code], detail: d,
        message: "This Studio has no language model configured, so only the engine's own reading is available — it handles instructions that name their objects (codes, variable names, option labels, logic words).",
        next: ["Set AI_API_URL, AI_API_KEY and AI_MODEL on the server (see .env.example) to read sentences like this one.", "Or rephrase with the objects named: “Terminate if Q1 < 25”, “Change Q7's options to 1–5”, “Add a crosstab of AGE by BRAND_PREF”."] };
    case "wallet":
      return { code, title: TITLES[code], detail: d,
        message: d ? `The meter refused this call: ${d}` : "The meter refused this call before it was made.",
        next: ["Check the wallet balance and the project's spending limit under Usage.", "Nothing was sent to the model and nothing was changed."] };
    case "timeout":
      return { code, title: TITLES[code], detail: d,
        message: d ? `The provider did not answer in time (${d}).` : "The provider did not answer within the time allowed.",
        next: ["Try again — a slow provider is usually transient.", "For a large request (a whole questionnaire), ask for one block at a time."] };
    case "provider":
      return { code, title: TITLES[code], detail: d,
        message: d ? `The provider refused the request: ${d}` : "The provider refused the request.",
        next: ["A 401/403 is the key or workspace; a 404 is the model name (AI_MODEL); a 429 is the provider's rate limit.", "Nothing was changed."] };
    case "network":
      return { code, title: TITLES[code], detail: d,
        message: d ? `The request did not reach the provider: ${d}` : "The request did not reach the provider.",
        next: ["Check AI_API_URL and the server's network access, then try again."] };
    case "truncated":
      return { code, title: TITLES[code], detail: d,
        message: d ? `The answer was longer than the output budget allows (${d}), even after asking the model to continue, so no change could be read from it.` : "The answer was longer than the output budget allows, even after asking the model to continue, so no change could be read from it.",
        next: ["Ask for less at once — one block, one section of the questionnaire, or the design first and the questions after.", "Nothing was changed, and the partial answer was not applied."] };
    case "unparseable":
      return { code, title: TITLES[code], detail: d,
        message: "The model answered in prose instead of the structured changes the Studio applies, and did so again when asked for the structure alone.",
        next: ["Try the request again, or say what you want changed in terms of questions, options and logic.", d ? `It began: “${d}”` : "Nothing was changed."] };
    case "empty":
      return { code, title: TITLES[code], detail: d,
        message: "The model returned an empty answer.",
        next: ["Try again. If it repeats, the model (AI_MODEL) may not serve this request shape — check the provider's logs."] };
    case "unusable":
      return { code, title: TITLES[code], detail: d,
        message: d && d.length > 20 ? d : "The model's answer was well-formed but carried no reply, no changes and no findings.",
        next: ["Rephrase with what you want to see change, or ask a question about the survey.", "Nothing was changed."] };
    case "engine_unparsed":
      return { code, title: TITLES[code], detail: d,
        message: "The engine reads instructions that name their objects — a question by code or variable, an option by label, a condition with its operator. It could not resolve this one on its own.",
        next: ["Examples it reads: “Terminate if Q1 < 25”, “Show Q12 only if Q1 is Male”, “Make Q5 required”, “Add an Other option to Q3”, “What will break if I delete Q6?”.", "With a language model configured, descriptive requests are read by the model and applied through the same review."] };
  }
}

/** A provider exception, read into a code: timeouts, refusals and network errors are told apart by their message. */
export function failureFromError(message: string): TurnFailure {
  const m = message || "";
  if (/did not answer within (\d+) seconds/i.test(m)) return describeFailure("timeout", /within (\d+ seconds)/i.exec(m)?.[1]);
  const refused = /refused the request \((\d{3})\)\s*(.*)$/i.exec(m);
  if (refused) return describeFailure("provider", `${refused[1]}${refused[2] ? ` ${refused[2].slice(0, 160)}` : ""}`);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket|ECONNRESET|TLS|certificate/i.test(m)) return describeFailure("network", m.slice(0, 160));
  return describeFailure("provider", m.slice(0, 200));
}

/** The failure a structured reply error carries (the ai package's AiReplyError). */
export function failureFromReplyError(code: "truncated" | "unparseable" | "empty", detail: { outputTokens?: number; maxTokens?: number; continuations?: number; sample?: string } = {}): TurnFailure {
  if (code === "truncated") return describeFailure("truncated", `${detail.maxTokens ?? "?"} tokens${detail.continuations ? `, continued ${detail.continuations}×` : ""}`);
  if (code === "unparseable") return describeFailure("unparseable", detail.sample?.replace(/\s+/g, " ").slice(0, 120));
  return describeFailure("empty");
}

/** Is this the shape a route returns for a failed turn? */
export function isTurnFailure(x: unknown): x is TurnFailure {
  const f = x as TurnFailure | null;
  return !!f && typeof f === "object" && typeof f.code === "string" && f.code in TITLES && typeof f.message === "string" && Array.isArray(f.next);
}
