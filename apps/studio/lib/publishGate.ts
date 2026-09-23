import { SurveyDefinition } from "@rescript/schema";
import { runQualityCheck, describeQualityCheck, type QualityCheckResult } from "@rescript/engine";

/**
 * R10 — THE LINT HAD NO GATE.
 *
 * `runQualityCheck` has been complete and correct for a long time, and until
 * now it had exactly one call site: a panel a programmer opens if they think
 * to. So a survey whose mask resolves to the empty set — which renders a page
 * with NO OPTIONS on it — could be versioned and deployed without anything
 * objecting, and the first thing that noticed was a respondent.
 *
 * A check nobody runs at the moment that matters is documentation, not a
 * check. This module is the moment that matters, in the two places a
 * definition stops being a draft:
 *
 *   · cutting a version   — the snapshot the runtime and every export read
 *   · deploying           — the link a respondent opens
 *
 * Both call the SAME function on the SAME definition, so a survey cannot pass
 * one gate and fail the other.
 */

export interface GateVerdict {
  ok: boolean;
  result: QualityCheckResult;
  /** the failing issues, flattened and capped — enough to act on, not a dump */
  problems: { area: string; message: string }[];
  summary: string;
}

/** Cap on the issues returned: a list nobody reads is the same as no list. */
const MAX_PROBLEMS = 20;

export function publishGate(def: SurveyDefinition): GateVerdict {
  let result: QualityCheckResult;
  try {
    result = runQualityCheck(def);
  } catch (e) {
    /*
     * A lint that throws must not become a lint that passes. The whole point
     * of this module is that nothing reaches a respondent unchecked, and
     * "the checker crashed" is the least reassuring reason to wave something
     * through — so it fails closed, and says so.
     */
    const message = `The quality check could not run: ${e instanceof Error ? e.message : String(e)}`;
    return {
      ok: false,
      result: {
        status: "fail", errors: 1, warnings: 0, areas: [], deployable: false,
        checkedAt: new Date().toISOString(),
      },
      problems: [{ area: "check", message }],
      summary: message,
    };
  }

  const problems = result.areas
    .flatMap((a) => a.issues.filter((i) => i.level === "error").map((i) => ({ area: a.key, message: i.message })))
    .slice(0, MAX_PROBLEMS);

  return {
    ok: result.deployable,
    result,
    problems,
    summary: describeQualityCheck(result),
  };
}

/**
 * The body of a refusal, in the shape the Studio already reads for errors.
 *
 * `blocking` names the areas rather than repeating them, so a panel can open
 * straight to the first one.
 */
export function gateRefusal(verdict: GateVerdict, what: string) {
  return {
    /*
     * It said "Fix them in the Quality panel". There is no Quality panel for
     * this: `runQualityCheck` is the SURVEY lint and it is rendered by the
     * Logic panel, while the panel actually called Quality scores collected
     * responses for speeding and straightlining. A programmer following this
     * sentence went to the wrong place and found nothing wrong there.
     *
     * "See the list below" was also a promise the Studio did not keep — it
     * rendered this string as a toast and dropped `lint.problems` entirely.
     * Both halves of the sentence are now true.
     */
    error:
      `This survey has ${verdict.result.errors} problem${verdict.result.errors === 1 ? "" : "s"} that would ` +
      `reach respondents, so it was not ${what}. They are listed below, and the Logic panel's checks ` +
      `show them in context.`,
    lint: {
      status: verdict.result.status,
      errors: verdict.result.errors,
      warnings: verdict.result.warnings,
      summary: verdict.summary,
      problems: verdict.problems,
      blocking: Array.from(new Set(verdict.problems.map((p) => p.area))),
    },
  };
}
