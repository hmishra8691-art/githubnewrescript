/**
 * Number formatting that does not depend on where the server happens to run.
 *
 * `(250000).toLocaleString()` with no locale takes the one the Node process
 * was started under. The same analysis therefore rendered "250,000" on a
 * server in Virginia and "2,50,000" on a machine with Indian settings — and
 * since report text, table labels and PowerPoint exports are all built
 * server-side, the output a client receives depended on the deployment
 * region rather than on the data. It first surfaced as a test that passed in
 * CI and failed on a developer's own laptop.
 *
 * `fmtNum` in `analyses/common.ts` had always pinned "en-US"; twenty-one
 * other call sites never got the same treatment. This is the one constant
 * they now share.
 *
 * This is for SERVER-SIDE report output, which must be reproducible. Text
 * shown to a respondent is a different question with a different answer —
 * that follows the survey's own locale, not this one.
 */
export const REPORT_LOCALE = "en-US";
