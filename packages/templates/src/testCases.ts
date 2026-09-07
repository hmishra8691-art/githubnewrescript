import type { ListFillCounts, QuotaCounts } from "@rescript/engine";
import { flattenVariables } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import { simulateRespondent, type SimulationResult } from "./simulate.js";

/**
 * TEST CASES AND REGRESSION TESTING (§55, §56).
 *
 * A survey programmer's real question before a release is not "does this
 * survey run" — `runQualityCheck` answers that from the definition alone. It
 * is "does it still do what it did yesterday, for the twelve respondents I
 * care about": the 17-year-old who must be screened out, the non-user who
 * must skip the whole usage block, the respondent whose quota is full.
 *
 * Nothing answered that. The pieces were all here — `simulateRespondent` is a
 * complete headless respondent, `survey_versions` keeps every definition —
 * and no one had joined them, so the only way to check a change had not
 * broken path C was to click through path C.
 *
 * ## The model, and why it has four verdicts rather than two
 *
 * A test case is an INPUT (answers, embedded data, a seed) plus, optionally,
 * DECLARED EXPECTATIONS. Running it produces an OUTCOME. The interesting part
 * is what to do with an outcome that is merely *different*:
 *
 *   fail     a declared expectation is violated. The programmer said this
 *            respondent must be screened out and they completed. Unambiguous.
 *
 *   changed  nothing declared is broken, but the outcome differs from the
 *            blessed baseline: a page appeared, a variable moved, a piped
 *            name changed. This is the regression signal, and it needs a
 *            HUMAN — "yes, I meant that" (re-bless it) or "no, that is a
 *            bug". Calling it a failure would train people to ignore it;
 *            calling it a pass would make the suite worthless.
 *
 *   stale    the case names questions the definition no longer has. Reported
 *            rather than passed, because `simulateRespondent` substitutes a
 *            default answer for a question it cannot find — so a stale case
 *            quietly starts testing a different respondent.
 *
 *   pass     expectations hold and the outcome matches the baseline (or there
 *            is no baseline yet, which is honest rather than green).
 *
 * That distinction between *fail* and *changed* is the whole difference
 * between a test suite and a snapshot diff, and it is why declared
 * expectations are worth writing even though the baseline catches more.
 *
 * ## Pure, and JSON-only
 *
 * No dates, no randomness beyond the case's own seed, no I/O. The input is
 * JSON because it is stored as JSON — which is also why `answers` here cannot
 * be the per-iteration FUNCTION that `SimulationOptions` allows.
 */

/* ------------------------------------------------------------------ types */

export interface TestCaseInput {
  /** answers by question id. JSON only — see the note above. */
  answers: Record<string, unknown>;
  embedded?: Record<string, string>;
  /**
   * Fixed per case, and that is the point: randomisation, design version
   * assignment and option order are all seeded, so a case with a seed is
   * reproducible and one without would report a change every time it ran.
   */
  seed?: number;
  quotaCounts?: QuotaCounts;
  listFillCounts?: ListFillCounts;
}

export interface TestExpectations {
  endStatus?: "complete" | "screened" | "quota_full" | "terminated";
  /** page ids this respondent must reach */
  visits?: string[];
  /** page ids this respondent must NOT reach — the skip that matters */
  notVisits?: string[];
  /** question ids that must be ASKED (visible), wherever they live */
  asks?: string[];
  /** question ids that must not be asked */
  skips?: string[];
  /** exported variable name → the value it must hold at the end */
  variables?: Record<string, string | number | boolean | null>;
  /** the walk must not stop on a validation or script error */
  completes?: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  notes?: string;
  enabled?: boolean;
  input: TestCaseInput;
  expectations?: TestExpectations;
  /** the outcome a person has blessed, if any */
  baseline?: TestOutcome | null;
}

export interface TestOutcome {
  /** page ids in the order they were shown, loop iterations included */
  path: string[];
  /** pageId → the question ids that were actually visible on it */
  asked: Record<string, string[]>;
  endStatus: string;
  blocked: { pageId: string; messages: string[] } | null;
  scriptErrors: string[];
  /** the exported columns, as a finished response would carry them */
  variables: Record<string, string | number | boolean | null>;
  /** questionId → the text after piping, as the respondent read it */
  texts: Record<string, string>;
  /** pages walked, for a suite summary that means something */
  pageCount: number;
  fingerprint: string;
}

export type TestVerdict = "pass" | "changed" | "fail" | "stale";

export interface OutcomeChange {
  kind: "path" | "end_status" | "variable" | "asked" | "text" | "blocked";
  /** a sentence a programmer can act on, not a diff fragment */
  detail: string;
  ref?: string;
  from?: unknown;
  to?: unknown;
}

export interface TestCaseResult {
  caseId: string;
  name: string;
  verdict: TestVerdict;
  outcome: TestOutcome;
  /** expectations that were violated, in words */
  failures: string[];
  /** how this run differs from the baseline */
  changes: OutcomeChange[];
  /** question ids the case answers that the definition no longer has */
  staleRefs: string[];
}

/* ------------------------------------------------------- the fingerprint */

/**
 * Stable JSON: object keys sorted at every depth.
 *
 * Without it the fingerprint depends on insertion order, so the same outcome
 * hashes differently after an unrelated refactor of the walk — and every
 * case in the suite reports "changed" for no reason. A regression suite that
 * cries wolf once is a regression suite nobody reads again.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * A 96-bit fingerprint, and deliberately NOT sha256.
 *
 * `node:crypto` is unavailable in the browser bundle, and this module is
 * re-exported from a package the Studio imports on the client. Two
 * independent hashes over the same canonical string give 96 bits, which is
 * ample for a few thousand outcomes per survey — and a collision could not
 * hide a regression anyway, because the full outcome is stored beside the
 * fingerprint and `diffOutcomes` compares THAT. The fingerprint is a fast
 * "has anything changed at all", not the evidence.
 */
export function fingerprint(value: unknown): string {
  const s = canonicalJson(value);
  /* FNV-1a, 64-bit, in two 32-bit halves so it stays exact in JS numbers */
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  /* djb2 for the third word — a different mixing function, not a rerun */
  let h3 = 5381;
  for (let i = 0; i < s.length; i++) h3 = (Math.imul(h3, 33) ^ s.charCodeAt(i)) >>> 0;
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(h1)}${hex(h2)}${hex(h3)}`;
}

/**
 * What the fingerprint covers.
 *
 * The path, what was asked, where it ended, and every exported variable —
 * the four things "the survey behaves the same" means. Piped TEXTS are in the
 * outcome and in the diff but NOT in the fingerprint, because a definition
 * with a date token in a question would otherwise report a change every day
 * and drown the signal. A broken piping token still shows up as a text change
 * in the diff, which is where a person can judge it.
 */
function fingerprintable(o: Omit<TestOutcome, "fingerprint">): unknown {
  return { path: o.path, asked: o.asked, endStatus: o.endStatus, variables: o.variables, blocked: o.blocked };
}

/* ------------------------------------------------------------- running */

/** The outcome of one walk, in the shape that gets stored and compared. */
export function outcomeOf(def: SurveyDefinition, sim: SimulationResult): TestOutcome {
  const asked: Record<string, string[]> = {};
  const texts: Record<string, string> = {};
  for (const p of sim.pages) {
    asked[p.pageId] = p.questionIds;
    for (const [qid, text] of Object.entries(p.texts)) texts[qid] = text;
  }
  /*
   * The exported columns rather than the raw answer map: those are what a
   * client receives and what an analysis reads, so a change there is a change
   * that matters. The raw map also carries loop-suffixed keys whose spelling
   * is an internal detail.
   */
  const flat = flattenVariables(def, sim.state) as Record<string, string | number | boolean | null>;
  const variables: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(flat).sort()) {
    const v = flat[key];
    variables[key] = v === undefined ? null : v;
  }

  const partial: Omit<TestOutcome, "fingerprint"> = {
    path: sim.pages.map((p) => p.pageId),
    asked,
    endStatus: sim.endStatus ?? sim.state.status,
    blocked: sim.blocked
      ? { pageId: sim.blocked.pageId, messages: sim.blocked.errors.map((e) => e.message).sort() }
      : null,
    scriptErrors: sim.scriptErrors.flatMap((s) => s.errors.map((e) => `${s.pageId}: ${e.message}`)).sort(),
    variables,
    texts,
    pageCount: sim.pages.length,
  };
  return { ...partial, fingerprint: fingerprint(fingerprintable(partial)) };
}

/** Question ids a case answers that the definition no longer declares. */
export function staleReferences(def: SurveyDefinition, input: TestCaseInput): string[] {
  const known = new Set((def.questions ?? []).map((q) => q.id));
  return Object.keys(input.answers ?? {}).filter((id) => !known.has(id)).sort();
}

/**
 * Check the declared expectations.
 *
 * Every message names the thing that was asked for and what happened, because
 * "expectation failed" in a list of forty is a message that costs more time
 * than it saves.
 */
export function checkExpectations(
  def: SurveyDefinition,
  outcome: TestOutcome,
  expect: TestExpectations | undefined,
): string[] {
  if (!expect) return [];
  const out: string[] = [];
  const codeOf = (qid: string) => def.questions.find((q) => q.id === qid)?.code ?? qid;
  const visited = new Set(outcome.path.map((p) => p.split("@")[0]));
  const askedIds = new Set(Object.values(outcome.asked).flat());

  if (expect.endStatus && outcome.endStatus !== expect.endStatus) {
    out.push(`Expected to end as ${expect.endStatus}, ended as ${outcome.endStatus}.`);
  }
  if (expect.completes && outcome.blocked) {
    out.push(`Expected to run through, but stopped on ${outcome.blocked.pageId}: ${outcome.blocked.messages.join("; ")}`);
  }
  for (const pageId of expect.visits ?? []) {
    if (!visited.has(pageId)) out.push(`Expected to reach page ${pageId}, and did not.`);
  }
  for (const pageId of expect.notVisits ?? []) {
    if (visited.has(pageId)) out.push(`Expected NOT to reach page ${pageId}, and did.`);
  }
  for (const qid of expect.asks ?? []) {
    if (!askedIds.has(qid)) out.push(`Expected to be asked ${codeOf(qid)}, and was not.`);
  }
  for (const qid of expect.skips ?? []) {
    if (askedIds.has(qid)) out.push(`Expected NOT to be asked ${codeOf(qid)}, and was.`);
  }
  for (const [name, want] of Object.entries(expect.variables ?? {})) {
    const got = outcome.variables[name];
    if (got === undefined) {
      out.push(`Expected ${name} to be ${format(want)}, but the survey exports no such variable.`);
    } else if (String(got) !== String(want)) {
      out.push(`Expected ${name} to be ${format(want)}, got ${format(got)}.`);
    }
  }
  return out;
}

const format = (v: unknown): string =>
  v === null || v === undefined ? "empty" : typeof v === "string" ? `“${v}”` : String(v);

/**
 * What changed, in a programmer's terms.
 *
 * Ordered so the most explanatory change comes first: a different path is
 * usually the CAUSE of the variable differences below it, and a list that
 * leads with forty changed columns buries the one fact that explains them.
 */
export function diffOutcomes(baseline: TestOutcome, current: TestOutcome): OutcomeChange[] {
  const out: OutcomeChange[] = [];

  if (baseline.endStatus !== current.endStatus) {
    out.push({
      kind: "end_status",
      detail: `Ends as ${current.endStatus} now, was ${baseline.endStatus}.`,
      from: baseline.endStatus, to: current.endStatus,
    });
  }

  if (canonicalJson(baseline.path) !== canonicalJson(current.path)) {
    /* name the first divergence — the rest of the path usually follows from it */
    let i = 0;
    while (i < baseline.path.length && i < current.path.length && baseline.path[i] === current.path[i]) i++;
    const was = baseline.path[i], now = current.path[i];
    const detail = was == null
      ? `The path is ${current.path.length - baseline.path.length} page(s) longer — it now continues to ${now}.`
      : now == null
        ? `The path ends ${baseline.path.length - current.path.length} page(s) earlier — it used to continue to ${was}.`
        : `After ${i} page(s) the path diverges: ${now} instead of ${was}.`;
    out.push({ kind: "path", detail, from: baseline.path, to: current.path });
  }

  if (canonicalJson(baseline.blocked) !== canonicalJson(current.blocked)) {
    out.push({
      kind: "blocked",
      detail: current.blocked
        ? `Now stops on ${current.blocked.pageId}: ${current.blocked.messages.join("; ")}`
        : `No longer stops on ${baseline.blocked?.pageId} — the validation it used to fail now passes.`,
      from: baseline.blocked, to: current.blocked,
    });
  }

  for (const pageId of new Set([...Object.keys(baseline.asked), ...Object.keys(current.asked)])) {
    const before = baseline.asked[pageId] ?? [];
    const after = current.asked[pageId] ?? [];
    const added = after.filter((q) => !before.includes(q));
    const removed = before.filter((q) => !after.includes(q));
    if (!added.length && !removed.length) continue;
    const bits: string[] = [];
    if (added.length) bits.push(`now also asks ${added.join(", ")}`);
    if (removed.length) bits.push(`no longer asks ${removed.join(", ")}`);
    out.push({ kind: "asked", ref: pageId, detail: `Page ${pageId} ${bits.join(" and ")}.`, from: before, to: after });
  }

  for (const name of new Set([...Object.keys(baseline.variables), ...Object.keys(current.variables)])) {
    const before = baseline.variables[name];
    const after = current.variables[name];
    if (String(before ?? "") === String(after ?? "")) continue;
    out.push({
      kind: "variable", ref: name,
      detail: name in current.variables
        ? name in baseline.variables
          ? `${name} is ${format(after)} now, was ${format(before)}.`
          : `${name} is a new exported variable, ${format(after)}.`
        : `${name} is no longer exported (was ${format(before)}).`,
      from: before, to: after,
    });
  }

  for (const qid of new Set([...Object.keys(baseline.texts), ...Object.keys(current.texts)])) {
    const before = baseline.texts[qid], after = current.texts[qid];
    if (before === after) continue;
    if (before === undefined || after === undefined) continue; /* covered by `asked` */
    out.push({
      kind: "text", ref: qid,
      detail: `${qid} now reads “${truncate(after)}” (was “${truncate(before)}”).`,
      from: before, to: after,
    });
  }

  return out;
}

const truncate = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Run one case.
 *
 * The verdict order is deliberate: STALE first, because a case that names a
 * deleted question is no longer testing what it says it tests — and
 * `simulateRespondent` will happily substitute a default answer and produce a
 * confident green. Then FAIL, then CHANGED.
 */
export function runTestCase(def: SurveyDefinition, testCase: TestCase): TestCaseResult {
  const staleRefs = staleReferences(def, testCase.input);
  const sim = simulateRespondent(def, {
    answers: testCase.input.answers ?? {},
    seed: testCase.input.seed ?? 1,
    embedded: testCase.input.embedded ?? {},
    quotaCounts: testCase.input.quotaCounts ?? {},
    listFillCounts: testCase.input.listFillCounts ?? {},
  });
  const outcome = outcomeOf(def, sim);
  const failures = checkExpectations(def, outcome, testCase.expectations);
  const changes = testCase.baseline ? diffOutcomes(testCase.baseline, outcome) : [];

  const verdict: TestVerdict =
    staleRefs.length ? "stale"
      : failures.length ? "fail"
        : changes.length ? "changed"
          : "pass";

  return { caseId: testCase.id, name: testCase.name, verdict, outcome, failures, changes, staleRefs };
}

/* ---------------------------------------------------------------- a suite */

export interface SuiteSummary {
  total: number;
  pass: number;
  changed: number;
  fail: number;
  stale: number;
  /** disabled cases are counted but not run */
  skipped: number;
  /** true when nothing needs a person's attention */
  clean: boolean;
  /** true when nothing is broken, though something may need blessing */
  releasable: boolean;
}

export interface SuiteResult {
  results: TestCaseResult[];
  summary: SuiteSummary;
}

export function runSuite(def: SurveyDefinition, cases: TestCase[]): SuiteResult {
  const results: TestCaseResult[] = [];
  let skipped = 0;
  for (const c of cases) {
    if (c.enabled === false) { skipped++; continue; }
    results.push(runTestCase(def, c));
  }
  const count = (v: TestVerdict) => results.filter((r) => r.verdict === v).length;
  const fail = count("fail"), stale = count("stale"), changed = count("changed");
  return {
    results,
    summary: {
      total: cases.length,
      pass: count("pass"), changed, fail, stale, skipped,
      clean: fail === 0 && stale === 0 && changed === 0,
      /*
       * A CHANGED case does not block a release on its own — it may be the
       * change the programmer just made on purpose. A FAIL or a STALE one
       * does: one says a stated requirement is broken, the other says a test
       * is no longer testing what it claims.
       */
      releasable: fail === 0 && stale === 0,
    },
  };
}

/** One line, for a toast, a commit message or an audit entry. */
export function describeSuite(s: SuiteSummary): string {
  if (!s.total) return "No test cases yet.";
  if (s.clean && !s.skipped) {
    /* "All 1 test case pass" is the kind of sentence that makes a tool feel unfinished */
    return s.total === 1 ? "All 1 test case passes." : `All ${s.total} test cases pass.`;
  }
  const bits: string[] = [`${s.pass} of ${s.total} pass`];
  if (s.fail) bits.push(`${s.fail} failed`);
  if (s.changed) bits.push(`${s.changed} changed and need review`);
  if (s.stale) bits.push(`${s.stale} out of date`);
  if (s.skipped) bits.push(`${s.skipped} disabled`);
  return `${bits.join(", ")}.`;
}
