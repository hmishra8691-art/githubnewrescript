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
  | "provider"         // the provider could not process this request (a malformed or unacceptable one)
  | "capacity"         // the provider is busy or rate-limiting: temporary — the work is kept and resumes
  | "auth"             // the Studio's credentials for the provider are invalid, expired or missing (an administrator's fix)
  | "forbidden"        // the provider refused this account/workspace/model (an administrator's fix)
  | "quota"            // the provider account's credit or usage limit is spent (an administrator's fix)
  | "not_found"        // the model or endpoint the Studio is configured for does not exist
  | "interrupted"      // the page was closed or reloaded mid-generation: the request and what was built are kept
  | "network"          // the request never reached the provider
  | "truncated"        // the answer was cut off at max_tokens, even after continuing
  | "unparseable"      // the answer was words, not the JSON the Studio reads
  | "empty"            // the answer had no content
  | "unusable"         // valid JSON with no reply, actions or findings
  | "engine_unparsed"  // no model, and the engine could not read the sentence
  | "internal_mode"    // the project runs internally: no model is called (Phase 6)
  | "connection"       // the user chose their own AI provider and it cannot be used (no key, workspace policy, missing capability)
  | "signed_out"       // the Studio's own route refused: no session (expired, signed out elsewhere)
  | "bad_request"      // the Studio's own route could not read what the page sent (400)
  | "too_long"         // the request was larger than the model (or the platform) accepts
  | "unreachable"      // the page could not reach the Studio's server at all (offline, server restarting)
  | "refused"          // the Studio's own route refused for its own reason: a locked project, a disabled account, an unknown project
  | "unexpected";      // an exception in the page itself — never shown as raw JavaScript

export interface TurnFailure {
  code: FailureCode;
  /** the card's kicker, upper case */
  title: string;
  /** one or two sentences naming the cause */
  message: string;
  /** what the researcher can do now */
  next: string[];
  /** a detail the message may quote (a budget, a refusal) — never a provider's raw response */
  detail?: string;
  /** a try again, later or at once, can succeed: the Studio resumes by itself where it can */
  retryable?: boolean;
  /** how long the provider asked us to wait, in ms, when it said */
  retryAfterMs?: number;
  /** what an administrator should check — shown apart from the researcher's message, and carries no status code or provider text */
  admin?: string;
}

const TITLES: Record<FailureCode, string> = {
  not_configured: "NO LANGUAGE MODEL CONFIGURED",
  wallet: "THE WALLET REFUSED THIS CALL",
  timeout: "THE MODEL DID NOT ANSWER IN TIME",
  provider: "THE AI SERVICE COULD NOT PROCESS THIS REQUEST",
  capacity: "WAITING FOR AI CAPACITY",
  auth: "THE AI CONNECTION NEEDS ATTENTION",
  forbidden: "THE AI SERVICE DID NOT ALLOW THIS REQUEST",
  quota: "THE AI SERVICE'S USAGE LIMIT WAS REACHED",
  not_found: "THE CONFIGURED AI MODEL WAS NOT FOUND",
  interrupted: "YOUR GENERATION WAS INTERRUPTED",
  network: "THE MODEL COULD NOT BE REACHED",
  truncated: "THE MODEL'S ANSWER WAS CUT OFF",
  unparseable: "THE MODEL ANSWERED IN WORDS, NOT CHANGES",
  empty: "THE MODEL ANSWERED WITH NOTHING",
  unusable: "THE MODEL'S ANSWER HAD NOTHING TO APPLY",
  engine_unparsed: "THE ENGINE COULD NOT READ THIS",
  internal_mode: "INTERNAL MODE — NO MODEL CALLED",
  connection: "YOUR AI PROVIDER IS NOT READY",
  signed_out: "YOU'RE SIGNED OUT",
  bad_request: "THE STUDIO COULD NOT READ THIS REQUEST",
  too_long: "THIS REQUEST IS TOO LONG FOR THE MODEL",
  unreachable: "THE STUDIO COULD NOT BE REACHED",
  refused: "THE STUDIO DID NOT ALLOW THIS REQUEST",
  unexpected: "SOMETHING WENT WRONG IN THE STUDIO",
};

/** the cards for a failure on the USER'S OWN provider: the fix is theirs, in Settings — not "ask your administrator" */
const OWN_TITLES: Partial<Record<FailureCode, string>> = {
  auth: "YOUR AI PROVIDER REJECTED YOUR KEY",
  forbidden: "YOUR AI PROVIDER DID NOT ALLOW THIS REQUEST",
  quota: "YOUR AI PROVIDER'S USAGE LIMIT WAS REACHED",
  not_found: "YOUR CHOSEN AI MODEL WAS NOT FOUND",
};
const SETTINGS = "Settings → AI & Integrations → AI Provider Configuration";

function ownOverride(f: TurnFailure, own: string): TurnFailure {
  const saved = "Your request and anything already generated are saved.";
  const press = "Then press Resume — nothing needs to be typed again.";
  const { admin: _admin, ...rest } = f;
  switch (f.code) {
    case "auth": return { ...rest, title: OWN_TITLES.auth!, message: `${own} did not accept your API key. ${saved}`, next: [`Open ${SETTINGS} and replace the key — the old one may have been revoked, expired or copied wrongly. Use Test connection to check it.`, press] };
    case "forbidden": return { ...rest, title: OWN_TITLES.forbidden!, message: `${own} accepted your key but did not allow this request — usually the key's permissions, project or region, or access to this model. ${saved}`, next: [`Check the key's permissions with ${own}, or choose another model in ${SETTINGS}.`, press] };
    case "quota": return { ...rest, title: OWN_TITLES.quota!, message: `Your ${own} account has no credit left or has reached its spending limit. ${saved} Nothing was charged for the failed call.`, next: [`Add credit or raise the limit with ${own}.`, `Or, in ${SETTINGS}, allow the platform's AI as a backstop, or switch this feature to the platform's AI.`, press] };
    case "not_found": return { ...rest, title: OWN_TITLES.not_found!, message: `${own} does not know the model you chose, or your key cannot use it. ${saved}`, next: [`Choose another model in ${SETTINGS} (the model list there shows what your key can use).`, press] };
    case "provider": return { ...rest, message: `${own} could not process this request. Nothing was changed, and your request is kept.`, next: ["Try rephrasing, or ask for one block at a time.", `Use Test connection in ${SETTINGS} to check the key and model.`] };
    default: return rest;
  }
}

/** The failure for a code, with the cause and the next steps written for the researcher. */
export function describeFailure(code: FailureCode, detail?: string, extra: { retryAfterMs?: number; /** the user's own provider's name, when the failing call was on it */ own?: string } = {}): TurnFailure {
  const f0 = describeCode(code, detail);
  const f = extra.own ? ownOverride(f0, extra.own) : f0;
  const retryable = code === "capacity" || code === "network" || code === "timeout" || code === "unreachable";
  return { ...f, ...(retryable ? { retryable: true } : {}), ...(extra.retryAfterMs ? { retryAfterMs: Math.round(extra.retryAfterMs) } : {}) };
}

function describeCode(code: FailureCode, detail?: string): TurnFailure {
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
        message: d ? `The AI service did not answer in time (${d}). Your request and anything already generated are saved.` : "The AI service did not answer within the time allowed. Your request and anything already generated are saved.",
        next: ["Resume — a slow answer is usually temporary.", "For a very large request, build it item by item with Plan first, or ask for one block at a time."] };
    case "provider":
      return { code, title: TITLES[code], detail: d,
        message: "The AI service could not process this request. Nothing was changed, and your request is kept.",
        next: ["Try rephrasing, or ask for one block at a time.", "If it keeps happening, tell your administrator — the Studio's log has the details."],
        admin: "The provider refused the request itself. Open Administration → AI connection → “Check the AI connection” to see what the provider said (credit, key, model, ceiling or schema), or read the “[rescript:ai] refused” line in the server log (field “said”)." };
    case "capacity":
      return { code, title: TITLES[code], detail: d,
        message: "The AI service is busy right now. Your work has been saved and nothing was lost.",
        next: ["The Studio resumes by itself when capacity returns — or press Resume to try now.", "Anything already generated is kept and can be reviewed."] };
    case "auth":
      return { code, title: TITLES[code], detail: d,
        message: "The Studio could not sign in to the AI service, so no more can be generated until its connection is fixed. Your request and anything already generated are saved.",
        next: ["Ask your workspace administrator to check the AI connection.", "Then press Resume — nothing needs to be typed again."],
        admin: "The provider rejected the Studio's credentials: check AI_API_KEY (and AI_WORKSPACE_ID) on the server, then redeploy." };
    case "forbidden":
      return { code, title: TITLES[code], detail: d,
        message: "The AI service did not allow this request for this workspace or model. Your request and anything already generated are saved.",
        next: ["Ask your workspace administrator to check the AI service's access settings.", "Then press Resume — nothing needs to be typed again."],
        admin: "The provider refused the key's permission (not a rate limit): check that AI_MODEL is enabled for the key's workspace/project and region, and AI_WORKSPACE_ID." };
    case "quota":
      return { code, title: TITLES[code], detail: d,
        message: "The AI provider account behind this Studio has reached its usage or credit limit. Your request and anything already generated are saved, and nothing was charged to your wallet for the failed call.",
        next: ["Ask your workspace administrator to raise the limit or add credit with the AI provider.", "Then press Resume — nothing needs to be typed again."],
        admin: "The provider reports the account's quota or credit as spent: check billing and spend limits with the AI provider (or configure AI_FALLBACK_* for a second provider)." };
    case "not_found":
      return { code, title: TITLES[code], detail: d,
        message: "The AI model this Studio is configured for could not be found. Your request and anything already generated are saved.",
        next: ["Ask your workspace administrator to check the configured model.", "Then press Resume — nothing needs to be typed again."],
        admin: "The provider does not know the model: check AI_MODEL (and AI_MODEL_SMALL) against the provider's model list." };
    case "interrupted":
      return { code, title: TITLES[code], detail: d,
        message: "The page was closed or reloaded while your request was being answered. Your request is saved.",
        next: ["Resume continues from where it stopped — nothing needs to be typed again."] };
    case "network":
      return { code, title: TITLES[code], detail: d,
        message: "The connection to the AI service was interrupted. Your request and anything already generated are saved.",
        next: ["The Studio will try again — or press Resume to try now.", "If it keeps failing, check the server's network access to the AI service."],
        ...(d ? { admin: `Network detail: ${d.slice(0, 120)}` } : {}) };
    case "truncated":
      return { code, title: TITLES[code], detail: d,
        message: d ? `The answer outgrew the provider's output ceiling (${d}), even after asking the model to continue, so no change could be read from it. The Studio does not ration output — the ceiling is the provider's.` : "The answer outgrew the provider's output ceiling, even after asking the model to continue, so no change could be read from it. The Studio does not ration output — the ceiling is the provider's.",
        next: ["Ask for less at once — one block, one section of the questionnaire, or the design first and the questions after — or use Plan first, which builds each item with its own call.", "A higher ceiling can be set on the Studio (AI_MAX_OUTPUT_TOKENS) when the provider allows more.", "Nothing was changed, and the partial answer was not applied."] };
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
    case "connection":
      return { code, title: TITLES[code], detail: d,
        message: d ?? "The AI provider you chose for this feature cannot be used right now.",
        next: [`Open ${SETTINGS} to fix it — or switch this feature to the platform's AI there.`, "Nothing was sent to a model and nothing was changed."] };
    case "signed_out":
      return { code, title: TITLES[code], detail: d,
        message: "You're signed out — sign in and send again. Your request is kept; nothing was changed.",
        next: ["Sign in again (open the sign-in page in another tab if you want to keep this one open).", "Then press Resume — nothing needs to be typed again."] };
    case "bad_request":
      return { code, title: TITLES[code], detail: d,
        message: d ?? "The Studio could not read what this page sent — the editor and the server may be out of step. Nothing was changed, and your request is kept.",
        next: d ? ["Type what you want changed and send it again."] : ["Reload the page, open Intelligent mode again and send it again.", "If it keeps happening, keep a copy of your request and report it — the editor and the server need to be on the same version."] };
    case "too_long":
      return { code, title: TITLES[code], detail: d,
        message: "That request was too long for the model — shorten it or split it. Nothing was changed, and your request is kept.",
        next: ["Ask for one block or one section of the questionnaire at a time, or shorten the pasted text.", "Or use Plan first, which builds each item with its own, smaller call."] };
    case "unreachable":
      return { code, title: TITLES[code], detail: d,
        message: "Could not reach the server — check your connection and try again. Your request is kept; nothing was changed.",
        next: ["Check that you are online, then press Resume — nothing needs to be typed again.", "If you are online and it keeps failing, the Studio may be restarting: wait a minute and try again."] };
    case "refused":
      return { code, title: TITLES[code], detail: d,
        message: d ?? "The Studio did not allow this request. Nothing was changed, and your request is kept.",
        next: ["Check that you still have access to this project and that it is not locked.", "Then press Resume — or ask the project's owner to unlock it."] };
    case "unexpected":
      return { code, title: TITLES[code], detail: d,
        message: "Something went wrong in the Studio before the AI could answer. Nothing was changed, and your request is kept.",
        next: ["Press Resume to try again — if it keeps happening, reload the page.", "If it is still there after a reload, tell your administrator what you asked for."] };
    case "internal_mode":
      return { code, title: TITLES[code], detail: d,
        message: "This project runs in internal mode: nothing is sent to a language model, so only the engine's own reading is available — instructions that name their objects, the standard items, the research workflow's own steps.",
        next: ["Switch the project to cloud execution in the Workflow tab (or for this one request) to send sentences like this one to the model.", "Or rephrase with the objects named: “Terminate if Q1 < 25”, “Add a crosstab of AGE by BRAND_PREF”, “Add a question to measure purchase intent”."] };
  }
}

/** a ProviderError's kind, as the card's code */
const CODE_OF_KIND: Record<string, FailureCode> = {
  rate_limited: "capacity", overloaded: "capacity", server: "capacity", busy: "capacity",
  network: "network", timeout: "timeout",
  auth: "auth", forbidden: "forbidden", quota_exhausted: "quota", not_found: "not_found", bad_request: "provider",
};

/** how providers say the prompt outgrew the model's context window */
const TOO_LONG = /too long|too large|context[ _-]?(length|window)|maximum context|too many tokens|exceeds? the (maximum|limit)|prompt is too|input is too|request_too_large/i;

/**
 * A provider exception, read into a card. A `ProviderError` (the ai package's
 * request manager) carries its kind and how long to wait; an older message is
 * read by its words. Either way the researcher's card names the situation —
 * busy, a connection to fix, a limit reached — and never quotes the
 * provider's status code or response body (those are in the server log).
 */
export function failureFromError(input: string | { message?: string; kind?: string; retryAfterMs?: number; status?: number; detail?: string; name?: string }, opts: { own?: string; /** the exception was not the provider's (no ProviderError): words that name no provider failure are the Studio's own fault, not "the AI service could not process this" */ studio?: boolean } = {}): TurnFailure {
  if (input && typeof input === "object" && typeof input.kind === "string" && input.kind in CODE_OF_KIND) {
    if (input.kind === "bad_request" && TOO_LONG.test(`${input.message ?? ""} ${input.detail ?? ""}`)) return describeFailure("too_long");
    const code = CODE_OF_KIND[input.kind];
    const secs = /within (\d+ seconds)/i.exec(input.message ?? "")?.[1];
    return describeFailure(code, code === "timeout" ? secs : code === "network" ? input.detail : undefined, { retryAfterMs: input.retryAfterMs, ...(opts.own ? { own: opts.own } : {}) });
  }
  const m = typeof input === "string" ? input : input?.message ?? "";
  if (/did not answer within (\d+) seconds/i.test(m)) return describeFailure("timeout", /within (\d+ seconds)/i.exec(m)?.[1]);
  const status = /\((\d{3})\)/.exec(m)?.[1];
  const refused = /refused the request \((\d{3})\)/i.exec(m);
  if (refused && refused[1] === "400" && TOO_LONG.test(m)) return describeFailure("too_long");
  if (refused) return describeFailure(refused[1] === "401" ? "auth" : refused[1] === "403" ? "forbidden" : refused[1] === "404" ? "not_found" : "provider", undefined, opts.own ? { own: opts.own } : {});
  if (/rate-limiting|is unavailable \(|overloaded/i.test(m) || status === "429") return describeFailure("capacity");
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket|ECONNRESET|TLS|certificate|could not reach/i.test(m)) return describeFailure("network", m.slice(0, 160));
  /*
   * AN EXCEPTION IN THE STUDIO IS NOT THE PROVIDER'S REFUSAL (2026-10-17). A route bug, a scope that was not set,
   * a TypeError while building the call — none of these reached the AI service, yet they fell through to "THE AI
   * SERVICE COULD NOT PROCESS THIS REQUEST … try rephrasing", which sent researchers to rephrase a sentence that
   * was never the problem. The words stay in the server log, never on the card.
   */
  if (opts.studio) return describeFailure("unexpected");
  return describeFailure("provider");
}

/** What to show when the server's answer was not the JSON it always sends — the platform cut the request off, or the connection dropped (HTTP status 0 = never answered) */
export function failureFromTransport(status: number): TurnFailure {
  if (status === 0) return describeFailure("unreachable");
  if (status === 413) return describeFailure("too_long");
  if (status === 408 || status === 504) return describeFailure("timeout", "the request ran past the time the platform allows");
  return describeFailure("capacity");
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

/**
 * THE STUDIO'S OWN ROUTE REFUSED (not the provider): a 401 when the session
 * ended, a 400 when the page's request could not be read, a 423 on a locked
 * project. These carry only `{error, code}` — no `failure` — and used to reach
 * the card as "THE AI SERVICE COULD NOT PROCESS THIS REQUEST … tell your
 * administrator", blaming the provider for a session that expired (AI-04).
 * Each is now a sentence the researcher can act on, with a retry (Resume).
 * Null for a status this does not know: the caller's own fallback applies.
 */
export function failureFromRefusal(status: number, body?: { error?: unknown; code?: unknown } | null): TurnFailure | null {
  const text = typeof body?.error === "string" ? body.error : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (status === 401) {
    if (!code && /api key|provider|credential/i.test(text)) {
      return { ...describeFailure("auth"), title: "THE AI PROVIDER REFUSED THE KEY", message: "The AI provider refused the key — check Settings → AI, then send again. Your request and anything already generated are saved.", next: [`Open ${SETTINGS} and replace the key, then use Test connection.`, "Then press Resume — nothing needs to be typed again."] };
    }
    return describeFailure("signed_out");
  }
  if (status === 402) return describeFailure("wallet", text.slice(0, 200) || undefined);
  if (status === 413) return describeFailure("too_long");
  if (status === 400) {
    if (TOO_LONG.test(text)) return describeFailure("too_long");
    if (/say what you want/i.test(text)) return describeFailure("bad_request", "There was nothing to send — type what you want changed, then send it again.");
    return describeFailure("bad_request");
  }
  if (status === 403) return describeFailure("refused", code === "account_disabled" ? "This account has been disabled — your administrator can re-enable it. Nothing was changed." : code === "not_admin" ? "This needs a platform administrator. Nothing was changed." : undefined);
  if (status === 404) return describeFailure("refused", "That project could not be found — reload the page or open it again from the project list. Nothing was changed.");
  if (status === 423) return describeFailure("refused", "This project has been locked by its owner and cannot be changed. Ask the owner to unlock it, then press Resume.");
  return null;
}

/**
 * An exception thrown in the page while a turn was running, as a card — never
 * the raw JavaScript message ("Cannot read properties of undefined"), which
 * means nothing to a researcher and was shown under "COULD NOT ANSWER".
 */
export function failureFromException(e: unknown): TurnFailure {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError" || /aborted/i.test(m)) return describeFailure("timeout", "the request was cancelled before it finished");
  if (/failed to fetch|networkerror|load failed|fetch failed|network request failed|ERR_INTERNET|ERR_NETWORK|ECONN/i.test(m)) return describeFailure("unreachable", m.slice(0, 120));
  return describeFailure("unexpected", m.slice(0, 160) || undefined);
}
