import type { Scorecard, RequirementScore } from "./scoring.js";

/**
 * WHAT TO TELL SOMEBODY WHO JUST PRACTISED.
 *
 * A mock interview is the one place in this product where the analysis is
 * shown to the person it is about. Everything here is derived from the
 * scorecard, which is derived from quoted evidence — so every sentence below
 * can be traced to something the person actually said, or to a requirement
 * they configured for themselves. Nothing is inferred about them.
 *
 * ## Recommendations are about the ANSWER, not the person
 *
 * "A stronger answer would include …" is taken from the requirement's own
 * `criteria` — what meeting it looks like, as the author wrote it. That is
 * advice about what to say next time. "You lack …" would be a claim about a
 * person from an absence of words, which is the inference this product
 * refuses to make. The distinction is the whole of this file.
 */

export interface FeedbackItem {
  requirementId: string;
  code: string;
  title: string;
  /** the words that earned it, when there are any */
  quotes: string[];
  /** taken from criteria; what the answer would have contained */
  advice: string | null;
}

export interface Feedback {
  overall: number | null;
  headline: string;
  didWell: FeedbackItem[];
  needsWork: FeedbackItem[];
  nearlyThere: FeedbackItem[];
  /** concrete, criteria-derived changes to make next time */
  recommendedChanges: string[];
  /** template keys to practise next — the caller resolves them to names */
  practiceNext: { reason: string; categories: string[] };
  caveat: string;
}

export const FEEDBACK_CAVEAT =
  "This feedback is an automated reading of your own words against the requirements you "
  + "chose to practise. Where it found no matching passage it says so — that means the words "
  + "were not there, not that you cannot do the thing. Use it to decide what to say next time.";

const item = (r: RequirementScore): FeedbackItem => ({
  requirementId: r.requirementId, code: r.code, title: r.title,
  quotes: r.quotes.map((q) => q.quote),
  advice: r.wouldHaveShown,
});

export function buildFeedback(card: Scorecard): Feedback {
  const didWell = card.strengths.map(item);
  const needsWork = card.gaps.map(item);
  const nearlyThere = card.improvements.map(item);

  const headline = card.overall === null
    ? "Your answers were recorded and read. Nothing here is weighted, so there is no overall score — see the requirements below."
    : card.overall >= 75
      ? `Strong session: quoted evidence for ${card.coverage.met} of ${card.coverage.total} requirements.`
      : card.overall >= 40
        ? `Solid start: ${card.coverage.met} of ${card.coverage.total} requirements clearly shown, ${card.coverage.partial} partly.`
        : `Room to grow: ${card.coverage.met} of ${card.coverage.total} requirements had quoted evidence. The list below says what to add.`;

  /*
   * One change per gap, worded as a thing to SAY. Gaps first, then partials,
   * because a requirement with nothing behind it is the bigger win. Capped, so
   * a twenty-requirement rubric does not hand somebody a wall of text.
   */
  const recommendedChanges = [...needsWork, ...nearlyThere]
    .filter((f) => f.advice)
    .slice(0, 6)
    .map((f) => `For "${f.title}": a stronger answer would include ${lowerFirst(f.advice!)}`);

  const weakCategories = card.categories
    .filter((c) => c.score !== null && c.score < 50)
    .map((c) => c.category);

  return {
    overall: card.overall,
    headline,
    didWell, needsWork, nearlyThere,
    recommendedChanges,
    practiceNext: {
      reason: weakCategories.length
        ? `The requirements you scored lowest on were ${weakCategories.map((c) => c.replace("_", " ")).join(" and ")}.`
        : "Try a different set to broaden what you have practised.",
      categories: weakCategories,
    },
    caveat: FEEDBACK_CAVEAT,
  };
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s).replace(/\.\s*$/, "") + ".";
