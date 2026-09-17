import { VERDICT_SAY, type Verdict } from "./evidence.js";

/**
 * A SCORE THAT CAN ALWAYS BE EXPANDED INTO THE WORDS THAT PRODUCED IT.
 *
 * This product has stated, in writing, that it must never emit a number that
 * reads as a verdict on a person from evidence that cannot support it. The
 * brief asks for scores. The decision that reconciles them — taken by the
 * product owner, not here — is EVIDENCE-GATED scoring:
 *
 *   · a score is composed ONLY from requirement verdicts that passed
 *     quote-verification against the transcript. `verifyEvidence` has already
 *     downgraded every claim it could not anchor to the candidate's own words,
 *     so by the time evidence reaches this file it is either quoted or it is
 *     `insufficient`. Nothing here reads telemetry, video, or the model's
 *     impression, and nothing here has a way to;
 *   · every number carries the ids of the evidence rows it was composed from,
 *     so a reader can open any score and find the quotes;
 *   · a requirement with weight zero is assessed and shown but moves nothing;
 *   · the words around each number say what it is — "requirements with quoted
 *     evidence", not "candidate quality" — and `SCORE_CAVEAT` goes wherever a
 *     score goes;
 *   · there is no recommendation to hire or not. That remains a person's, on
 *     the human review, where it always was.
 *
 * ## The arithmetic, and why it is this simple
 *
 * A verdict maps to a point value: evidence 1, partial 0.5, insufficient 0.
 * A requirement's score is its best verdict across the answers — the same
 * strongest-wins rule `summariseRequirements` uses, because a skill shown in
 * one answer is shown. A category's score is the weighted mean of its
 * requirements' points; the overall score is the weighted mean of all of them.
 * Weighted mean, not sum, so adding a requirement does not silently move
 * everybody's total, and 0–100 so a reader does not have to know the scale.
 *
 * Anything cleverer — noisy-OR, decay, calibration — would be a model of the
 * person. This is a tally of quoted evidence, and it should look like one.
 */

export const POINTS: Record<Verdict, number> = { evidence: 1, partial: 0.5, insufficient: 0 };

/** The buckets requirements are grouped under. `general` is the unlabelled default. */
export const REQUIREMENT_CATEGORIES = [
  "technical", "communication", "problem_solving", "domain", "behavioural", "role", "general",
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const CATEGORY_SAY: Record<RequirementCategory, string> = {
  technical: "Technical skills",
  communication: "Communication",
  problem_solving: "Problem solving",
  domain: "Domain knowledge",
  behavioural: "Behavioural",
  role: "Role-specific",
  general: "General",
};

export function isRequirementCategory(v: unknown): v is RequirementCategory {
  return typeof v === "string" && (REQUIREMENT_CATEGORIES as readonly string[]).includes(v);
}

export interface ScoredRequirementInput {
  id: string;
  code: string;
  title: string;
  criteria?: string | null;
  weight: number;
  category?: string | null;
}

export interface ScoredEvidenceInput {
  id: string;
  requirementId: string;
  responseId: string | null;
  questionId?: string | null;
  verdict: Verdict;
  quote?: string | null;
  explanation?: string | null;
}

export interface RequirementScore {
  requirementId: string;
  code: string;
  title: string;
  category: RequirementCategory;
  weight: number;
  verdict: Verdict;
  say: string;
  /** 0, 50 or 100 — the best verdict's points */
  points: number;
  /** the evidence rows this verdict rests on; empty for insufficient */
  evidenceIds: string[];
  /** the quotes, so a reader never has to go looking */
  quotes: { evidenceId: string; responseId: string | null; questionId: string | null; quote: string }[];
  /** what a stronger answer would have contained, taken from the criteria — never invented */
  wouldHaveShown: string | null;
}

export interface CategoryScore {
  category: RequirementCategory;
  say: string;
  /** weighted mean of the category's requirement points, 0–100; null when nothing in it carries weight */
  score: number | null;
  requirements: string[];
  weight: number;
}

export interface QuestionScore {
  questionId: string;
  responseId: string;
  /** requirements this answer produced quoted evidence for */
  demonstrated: string[];
  partial: string[];
  /** points from this answer's evidence alone, 0–100; null when no requirement was addressed */
  score: number | null;
  evidenceIds: string[];
}

export interface Scorecard {
  /** 0–100, weighted over requirements with weight > 0; null when none carry weight */
  overall: number | null;
  /** what the number is made of, in the reader's words */
  basis: string;
  categories: CategoryScore[];
  requirements: RequirementScore[];
  questions: QuestionScore[];
  coverage: { met: number; partial: number; notDemonstrated: number; total: number; unscored: number };
  strengths: RequirementScore[];
  gaps: RequirementScore[];
  improvements: RequirementScore[];
  /** ids of every evidence row that moved any number here */
  evidenceIds: string[];
  computedAt: string;
}

/**
 * The sentence that travels with every score.
 *
 * A constant, like `ANALYSIS_CAVEAT`, so it cannot be present on the review
 * page and absent from the PDF somebody actually forwards.
 */
export const SCORE_CAVEAT =
  "These scores are an AI-assisted tally of how many of the configured requirements "
  + "had quoted evidence in the candidate's own words. A requirement scores nothing "
  + "when no passage could be quoted for it — which means the words were not found, "
  + "not that the person lacks the skill. They are not a ranking and not a decision.";

const RANK: Record<Verdict, number> = { insufficient: 0, partial: 1, evidence: 2 };

function normCategory(v: unknown): RequirementCategory {
  return isRequirementCategory(v) ? v : "general";
}

/**
 * Compose the scorecard.
 *
 * Every input is data already in the database — requirements and verified
 * evidence rows — and the output names the rows it used. Run on the server
 * after analysis and stored as a snapshot; run again on read if anybody wants
 * to check the arithmetic.
 */
export function buildScorecard(
  requirements: readonly ScoredRequirementInput[],
  evidence: readonly ScoredEvidenceInput[],
  now: Date = new Date(),
): Scorecard {
  const reqScores: RequirementScore[] = requirements.map((r) => {
    const mine = evidence.filter((e) => e.requirementId === r.id);
    const best = mine.reduce<Verdict>((acc, e) => (RANK[e.verdict] > RANK[acc] ? e.verdict : acc), "insufficient");
    /*
     * Only rows AT the best verdict support it. A partial finding does not
     * support an `evidence` verdict, and listing it as if it did would make
     * the expansion say more than the number does.
     */
    const supporting = best === "insufficient" ? [] : mine.filter((e) => e.verdict === best && e.quote);
    return {
      requirementId: r.id,
      code: r.code,
      title: r.title,
      category: normCategory(r.category),
      weight: Math.max(0, Number(r.weight) || 0),
      verdict: best,
      say: VERDICT_SAY[best],
      points: Math.round(POINTS[best] * 100),
      evidenceIds: supporting.map((e) => e.id),
      quotes: supporting.map((e) => ({
        evidenceId: e.id, responseId: e.responseId, questionId: e.questionId ?? null, quote: e.quote!,
      })),
      wouldHaveShown: best === "evidence" ? null : (r.criteria?.trim() || null),
    };
  });

  const weighted = reqScores.filter((r) => r.weight > 0);
  const overall = weighted.length
    ? Math.round(weighted.reduce((s, r) => s + r.points * r.weight, 0) / weighted.reduce((s, r) => s + r.weight, 0))
    : null;

  const categories: CategoryScore[] = REQUIREMENT_CATEGORIES
    .map((category) => {
      const inCat = reqScores.filter((r) => r.category === category);
      const w = inCat.filter((r) => r.weight > 0);
      const weight = w.reduce((s, r) => s + r.weight, 0);
      return {
        category, say: CATEGORY_SAY[category],
        score: weight ? Math.round(w.reduce((s, r) => s + r.points * r.weight, 0) / weight) : null,
        requirements: inCat.map((r) => r.requirementId),
        weight,
      };
    })
    .filter((c) => c.requirements.length > 0);

  /*
   * Per question: what THIS answer produced. Not "the candidate's score on
   * question 3" — a question is not a test with a mark — but which
   * requirements this particular answer gave quoted evidence for, which is
   * what a recruiter scanning answers actually wants to know.
   */
  const byResponse = new Map<string, ScoredEvidenceInput[]>();
  for (const e of evidence) {
    if (!e.responseId) continue;
    const list = byResponse.get(e.responseId) ?? [];
    list.push(e);
    byResponse.set(e.responseId, list);
  }
  const questions: QuestionScore[] = [...byResponse.entries()].map(([responseId, rows]) => {
    const quoted = rows.filter((e) => e.verdict !== "insufficient" && e.quote);
    const demonstrated = [...new Set(quoted.filter((e) => e.verdict === "evidence").map((e) => e.requirementId))];
    const partial = [...new Set(quoted.filter((e) => e.verdict === "partial").map((e) => e.requirementId))]
      .filter((id) => !demonstrated.includes(id));
    const addressed = new Set(rows.map((e) => e.requirementId));
    const pts = [...addressed].map((id) => {
      const best = rows.filter((e) => e.requirementId === id)
        .reduce<Verdict>((acc, e) => (RANK[e.verdict] > RANK[acc] ? e.verdict : acc), "insufficient");
      return POINTS[best];
    });
    return {
      questionId: rows[0]?.questionId ?? "",
      responseId,
      demonstrated, partial,
      score: pts.length ? Math.round((pts.reduce((a, b) => a + b, 0) / pts.length) * 100) : null,
      evidenceIds: quoted.map((e) => e.id),
    };
  });

  const scored = reqScores.filter((r) => r.weight > 0);
  return {
    overall,
    basis: weighted.length
      ? `${weighted.filter((r) => r.verdict === "evidence").length} of ${weighted.length} weighted requirements had quoted evidence; ${weighted.filter((r) => r.verdict === "partial").length} partial.`
      : "No requirement carries weight, so there is no overall score — only coverage.",
    categories,
    requirements: reqScores,
    questions,
    coverage: {
      met: reqScores.filter((r) => r.verdict === "evidence").length,
      partial: reqScores.filter((r) => r.verdict === "partial").length,
      notDemonstrated: reqScores.filter((r) => r.verdict === "insufficient").length,
      total: reqScores.length,
      unscored: reqScores.length - scored.length,
    },
    strengths: reqScores.filter((r) => r.verdict === "evidence"),
    gaps: reqScores.filter((r) => r.verdict === "insufficient"),
    improvements: reqScores.filter((r) => r.verdict === "partial"),
    evidenceIds: [...new Set(reqScores.flatMap((r) => r.evidenceIds))],
    computedAt: now.toISOString(),
  };
}

/**
 * Read a stored scorecard back, defensively.
 *
 * It is jsonb written by this file's older or newer self. Anything malformed
 * is `null`, and the page shows "not scored" rather than a broken card.
 */
export function readScorecard(raw: unknown): Scorecard | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<Scorecard>;
  if (!Array.isArray(s.requirements) || !s.coverage) return null;
  return s as Scorecard;
}

/** A one-line reading of the overall, in words a reader will not mistake for a grade. */
export function describeOverall(card: Scorecard): string {
  if (card.overall === null) return "No overall score — no requirement carries weight.";
  return `${card.overall} of 100 · ${card.coverage.met} of ${card.coverage.total} requirements with quoted evidence`;
}
