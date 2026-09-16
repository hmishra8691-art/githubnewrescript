/**
 * REQUIREMENTS, EVIDENCE, AND THE THING THE MODEL IS NOT ALLOWED TO DO.
 *
 * §15 is unusually specific: for each requirement, return evidence found /
 * partial / insufficient, with an explanation, a supporting passage, the
 * question, a timestamp, and — the sentence the whole file exists for — *the
 * system must never invent candidate evidence*.
 *
 * A language model asked "does this person have AWS experience?" will produce
 * a confident paragraph whether or not the transcript mentions AWS. So the
 * defence cannot be a phrase in the prompt. It has to be a check on the
 * output, and it has to be one the model cannot satisfy by being fluent:
 *
 *   **every claim carries a quote, and every quote must appear verbatim in
 *   the transcript it is attributed to.**
 *
 * `verifyEvidence` does exactly that, and downgrades anything that fails to
 * `insufficient` with a reason. A model that hallucinates a quote produces a
 * finding of "we did not find enough to say", which is the correct answer,
 * rather than a fabrication with a citation.
 *
 * The third verdict is `insufficient`, not `not_met`. "We did not find enough
 * in this interview to say" and "this person does not have this skill" are
 * different claims, and only the first one is supportable from twenty minutes
 * of recorded answers. A schema and a vocabulary that cannot express the
 * difference guarantee a product that does not either.
 */

export const VERDICTS = ["evidence", "partial", "insufficient"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_SAY: Record<Verdict, string> = {
  evidence: "Evidence found",
  partial: "Partial evidence",
  insufficient: "Insufficient evidence",
};

/** What a reviewer is told the verdict means, in full. */
export const VERDICT_MEANS: Record<Verdict, string> = {
  evidence:
    "The candidate said something that directly addresses this requirement.",
  partial:
    "The candidate touched on this without saying enough to judge it.",
  insufficient:
    "Nothing in this interview addresses this requirement. That is not a "
    + "statement about the candidate — only about what these answers covered.",
};

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
}

export interface RequirementSpec {
  id: string;
  code: string;
  title: string;
  criteria?: string;
  weight?: number;
}

export interface TranscriptSource {
  responseId: string;
  questionId: string;
  questionCode: string;
  text: string;
  /** [{start, end, text}] where the provider gave timings. */
  segments?: { start: number; end: number; text: string }[] | null;
}

/** What the model returned, before anything has been checked. */
export interface ClaimedEvidence {
  requirementId: string;
  responseId: string | null;
  verdict: Verdict;
  explanation: string;
  quote?: string | null;
  confidence?: number | null;
}

export interface VerifiedEvidence extends ClaimedEvidence {
  quoteStartSeconds: number | null;
  quoteEndSeconds: number | null;
  questionId: string | null;
  /** Set when the claim was downgraded, saying exactly why. */
  downgradedFrom?: Verdict;
  downgradeReason?: string;
}

/**
 * Loose enough to survive a provider that tidies punctuation, strict enough
 * that an invented sentence does not pass.
 *
 * Whitespace collapses, curly quotes and dashes normalise, case is ignored,
 * and terminal punctuation is trimmed. What is NOT allowed is a different
 * word order, a paraphrase, or a sentence that is merely plausible — those
 * are the fabrications this exists to catch.
 */
export function normaliseForMatch(text: string): string {
  return (text ?? "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    /* terminal punctuation last, and after trimming — a quote copied with a
       trailing space would otherwise keep its full stop and match nothing */
    .replace(/[.,;:!?"']+$/g, "")
    .trim()
    .toLowerCase();
}

/** Where a quote occurs in a transcript, in seconds, when the timings exist. */
export function locateQuote(
  source: TranscriptSource, quote: string,
): { start: number | null; end: number | null } {
  const segments = source.segments ?? [];
  if (!segments.length) return { start: null, end: null };
  const needle = normaliseForMatch(quote);
  if (!needle) return { start: null, end: null };

  /* the simple case: one segment contains the whole quote */
  for (const s of segments) {
    if (normaliseForMatch(s.text).includes(needle)) return { start: s.start, end: s.end };
  }
  /*
   * Otherwise the quote spans segments. The run has to be the TIGHTEST one:
   * starting at the first segment always "works" — the whole transcript
   * contains the quote — and would timestamp every citation at zero, which
   * is worse than no timestamp because it looks like an answer.
   */
  for (let i = 0; i < segments.length; i++) {
    let joined = "";
    for (let j = i; j < segments.length; j++) {
      joined = `${joined} ${segments[j]!.text}`;
      if (!normaliseForMatch(joined).includes(needle)) continue;
      /* pull the start forward as far as it will go and still match */
      let from = i;
      while (from < j) {
        const shorter = segments.slice(from + 1, j + 1).map((s) => s.text).join(" ");
        if (!normaliseForMatch(shorter).includes(needle)) break;
        from++;
      }
      return { start: segments[from]!.start, end: segments[j]!.end };
    }
  }
  return { start: null, end: null };
}

/**
 * Check every claim against the transcript it names, and downgrade what
 * cannot be supported.
 *
 * The rules, in order:
 *
 *  1. A claim naming a response that is not in this interview is dropped —
 *     the model has cited something that does not exist.
 *  2. A claim of `evidence` or `partial` with NO quote is downgraded. An
 *     assertion without a citation is exactly the thing §15 forbids.
 *  3. A claim whose quote does not appear in the transcript is downgraded,
 *     and the reason says so. This is the hallucination check.
 *  4. `insufficient` needs no quote — there is nothing to cite.
 */
export function verifyEvidence(
  claims: readonly ClaimedEvidence[],
  sources: readonly TranscriptSource[],
  requirements: readonly RequirementSpec[],
): { evidence: VerifiedEvidence[]; dropped: { claim: ClaimedEvidence; reason: string }[] } {
  const byResponse = new Map(sources.map((s) => [s.responseId, s]));
  const knownRequirement = new Set(requirements.map((r) => r.id));
  const evidence: VerifiedEvidence[] = [];
  const dropped: { claim: ClaimedEvidence; reason: string }[] = [];

  for (const claim of claims) {
    if (!knownRequirement.has(claim.requirementId)) {
      dropped.push({ claim, reason: "names a requirement this project does not have" });
      continue;
    }

    const source = claim.responseId ? byResponse.get(claim.responseId) ?? null : null;
    if (claim.responseId && !source) {
      dropped.push({ claim, reason: "cites an answer that is not part of this interview" });
      continue;
    }

    const base: VerifiedEvidence = {
      ...claim,
      quote: claim.quote ?? null,
      questionId: source?.questionId ?? null,
      quoteStartSeconds: null,
      quoteEndSeconds: null,
    };

    if (claim.verdict === "insufficient") {
      /* nothing to support, so nothing to check — but a quote attached to an
         "insufficient" finding is still checked, because a wrong one here
         would be just as misleading */
      if (base.quote && source && !normaliseForMatch(source.text).includes(normaliseForMatch(base.quote))) {
        base.quote = null;
      } else if (base.quote && source) {
        const at = locateQuote(source, base.quote);
        base.quoteStartSeconds = at.start;
        base.quoteEndSeconds = at.end;
      }
      evidence.push(base);
      continue;
    }

    const quote = (claim.quote ?? "").trim();
    if (!quote) {
      evidence.push({
        ...base,
        verdict: "insufficient",
        downgradedFrom: claim.verdict,
        downgradeReason: "no supporting passage was given",
        explanation: claim.explanation,
        quote: null,
      });
      continue;
    }
    if (!source) {
      evidence.push({
        ...base,
        verdict: "insufficient",
        downgradedFrom: claim.verdict,
        downgradeReason: "the passage was not attributed to an answer",
        quote: null,
      });
      continue;
    }
    if (!normaliseForMatch(source.text).includes(normaliseForMatch(quote))) {
      evidence.push({
        ...base,
        verdict: "insufficient",
        downgradedFrom: claim.verdict,
        downgradeReason: "the quoted passage does not appear in that answer",
        quote: null,
      });
      continue;
    }

    const at = locateQuote(source, quote);
    evidence.push({ ...base, quote, quoteStartSeconds: at.start, quoteEndSeconds: at.end });
  }

  return { evidence, dropped };
}

/**
 * The per-requirement roll-up.
 *
 * The strongest verdict across the answers wins, because a requirement met in
 * one answer is met — a candidate does not un-demonstrate a skill by not
 * mentioning it again in the next question.
 */
const RANK: Record<Verdict, number> = { insufficient: 0, partial: 1, evidence: 2 };

export interface RequirementSummary {
  requirementId: string;
  code: string;
  title: string;
  verdict: Verdict;
  say: string;
  evidenceCount: number;
  /** Findings that were downgraded, so a reviewer can see the model was checked. */
  downgraded: number;
}

export function summariseRequirements(
  requirements: readonly RequirementSpec[],
  evidence: readonly VerifiedEvidence[],
): RequirementSummary[] {
  return requirements.map((r) => {
    const mine = evidence.filter((e) => e.requirementId === r.id);
    const best = mine.reduce<Verdict>(
      (acc, e) => (RANK[e.verdict] > RANK[acc] ? e.verdict : acc), "insufficient",
    );
    return {
      requirementId: r.id, code: r.code, title: r.title,
      verdict: best, say: VERDICT_SAY[best],
      evidenceCount: mine.filter((e) => e.verdict !== "insufficient").length,
      downgraded: mine.filter((e) => e.downgradedFrom).length,
    };
  });
}

/**
 * The sentence that goes above any analysis, anywhere it is shown.
 *
 * §16: the AI is decision support. Like `SIGNALS_CAVEAT`, this is a constant
 * rather than copy in a component so that it cannot be present on one screen
 * and quietly absent on the one somebody actually makes decisions from.
 */
export const ANALYSIS_CAVEAT =
  "This analysis is a reading of the transcripts, produced automatically to "
  + "help you find the relevant parts of an interview faster. Every finding is "
  + "linked to the candidate's own words, and anything that could not be linked "
  + "is reported as insufficient evidence rather than guessed at. It is not an "
  + "assessment of the candidate and must not be used as one.";

/**
 * What the analysis is NOT permitted to consider — §16's list, in one place,
 * so the prompt that enforces it and the documentation that promises it
 * cannot drift apart.
 */
export const FORBIDDEN_INFERENCES: readonly string[] = [
  "facial appearance", "emotion", "accent", "eye movement", "facial expression",
  "disability", "personality", "age", "gender", "ethnicity", "attractiveness",
  "perceived confidence", "background or surroundings",
];
