import { FORBIDDEN_INFERENCES, type RequirementSpec, type TranscriptSource } from "./evidence.js";

/**
 * WHAT THE MODEL IS ASKED, AND WHAT IT IS FORBIDDEN.
 *
 * Kept here, beside `verifyEvidence`, because the two are one mechanism. The
 * prompt asks for a quote with every claim; the verifier drops any claim whose
 * quote is not in the transcript verbatim. Neither is sufficient alone — a
 * prompt is a request and a model can decline it silently, and a verifier with
 * nothing to verify against has no opinion. Together they make the rule real:
 * a finding either points at words the candidate said, or it is reported as
 * insufficient evidence.
 *
 * ## Why the forbidden list is in the prompt AND in the documentation
 *
 * `FORBIDDEN_INFERENCES` is one array. It is read into the system message
 * below, and read into the caveat a reviewer is shown. If it were written
 * twice, the day somebody adds "tone of voice" to one is the day the product
 * promises something the model was never told.
 *
 * ## The transcripts go in whole
 *
 * Not summarised, not truncated at a word boundary that might land mid-quote.
 * A quote the model produces must be findable in what the verifier holds, and
 * the surest way to break that is to show the model a different text from the
 * one that gets checked. Where a transcript is too long for the context, the
 * ANSWER is dropped whole and named in `omitted` rather than cut — a claim
 * about an answer nobody sent is worse than an answer nobody analysed.
 */

/** Rough characters per token, for deciding what fits. Deliberately pessimistic. */
const CHARS_PER_TOKEN = 3.5;

export interface PromptPlan {
  system: string;
  user: string;
  /** response ids left out because the whole set would not fit */
  omitted: string[];
  approxTokens: number;
}

export function analysisSystemPrompt(): string {
  return [
    "You read interview transcripts and report where a requirement is evidenced.",
    "",
    "Rules, all of them absolute:",
    "1. Every finding MUST quote the transcript verbatim. Copy the words exactly;",
    "   do not paraphrase, correct grammar, tidy punctuation or join separated",
    "   sentences. A quote that is not character-for-character present will be",
    "   discarded and your finding with it.",
    "2. Quote from ONE answer and name that answer's responseId.",
    "3. If you cannot find words that evidence a requirement, say so with the",
    "   verdict \"insufficient\". That is a correct and useful answer. Do not",
    "   stretch a quote to fit.",
    "4. Judge only what was SAID. You must not comment on, infer from or take",
    `   into account: ${FORBIDDEN_INFERENCES.join(", ")}.`,
    "5. You are not assessing the person and must not recommend a decision about",
    "   them. You are pointing a reader at the relevant part of a transcript.",
    "",
    "Answer with JSON only:",
    '{"claims":[{"requirementId":"...","responseId":"...","verdict":"evidence|partial|insufficient",',
    '"quote":"exact words from that answer","explanation":"one sentence on why these words evidence it"}],',
    '"narrative":"two or three sentences summarising what the transcripts cover, with no judgement of the person"}',
  ].join("\n");
}

export function analysisUserPrompt(
  requirements: readonly RequirementSpec[],
  sources: readonly TranscriptSource[],
): string {
  const reqs = requirements.map((r) =>
    `- requirementId: ${r.id}\n  code: ${r.code}\n  title: ${r.title}` +
    (r.criteria ? `\n  what meeting it looks like: ${r.criteria}` : ""),
  ).join("\n");

  const answers = sources.map((s) =>
    `--- responseId: ${s.responseId} (question ${s.questionCode}) ---\n${s.text}`,
  ).join("\n\n");

  return [
    "REQUIREMENTS",
    reqs || "(none)",
    "",
    "TRANSCRIPTS",
    answers || "(none)",
  ].join("\n");
}

/**
 * Build the whole prompt, dropping whole answers if it will not fit.
 *
 * Longest-first would keep the most answers, and is wrong: the order the
 * questions were asked in is the order a reader expects, and an analysis that
 * silently prefers short answers is one that finds evidence where people were
 * brief. So answers are kept in sequence and the overflow is dropped from the
 * end, named in `omitted`, and reported to the reviewer.
 */
export function planAnalysisPrompt(
  requirements: readonly RequirementSpec[],
  sources: readonly TranscriptSource[],
  budgetTokens = 24_000,
): PromptPlan {
  const system = analysisSystemPrompt();
  const kept: TranscriptSource[] = [];
  const omitted: string[] = [];

  for (const s of sources) {
    const trial = analysisUserPrompt(requirements, [...kept, s]);
    const tokens = Math.ceil((system.length + trial.length) / CHARS_PER_TOKEN);
    if (kept.length && tokens > budgetTokens) omitted.push(s.responseId);
    else kept.push(s);
  }

  const user = analysisUserPrompt(requirements, kept);
  return {
    system,
    user,
    omitted,
    approxTokens: Math.ceil((system.length + user.length) / CHARS_PER_TOKEN),
  };
}

/* ------------------------------------------------------ reading the reply */

export interface RawClaim {
  requirementId: string;
  responseId: string | null;
  verdict: string;
  quote?: string | null;
  explanation?: string | null;
}

/**
 * Pull claims out of whatever the model actually returned.
 *
 * Tolerant about the wrapper — `{claims:[…]}`, a bare array, `{findings:[…]}` —
 * and strict about each claim, because a claim missing its requirement or its
 * verdict is one `verifyEvidence` would drop anyway and it is cheaper to say
 * so here.
 *
 * It does NOT repair a quote. A model that returns a nearly-right quote has
 * produced a nearly-right finding, and "nearly" is the thing this whole
 * mechanism exists to refuse.
 */
export function readClaims(reply: unknown): { claims: RawClaim[]; narrative: string | null } {
  if (!reply || typeof reply !== "object") return { claims: [], narrative: null };
  const obj = reply as Record<string, unknown>;

  const list =
    Array.isArray(obj.claims) ? obj.claims
      : Array.isArray(obj.findings) ? obj.findings
        : Array.isArray(reply) ? (reply as unknown[])
          : [];

  const claims: RawClaim[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const requirementId = String(c.requirementId ?? c.requirement_id ?? "").trim();
    const verdict = String(c.verdict ?? "").trim().toLowerCase();
    if (!requirementId || !verdict) continue;
    claims.push({
      requirementId,
      responseId: String(c.responseId ?? c.response_id ?? "").trim() || null,
      verdict,
      quote: typeof c.quote === "string" ? c.quote : null,
      explanation: typeof c.explanation === "string" ? c.explanation : null,
    });
  }

  const narrative = typeof obj.narrative === "string" && obj.narrative.trim()
    ? obj.narrative.trim()
    : null;

  return { claims, narrative };
}
