import test from "node:test";
import assert from "node:assert/strict";
import { assessSurvey } from "./engine.js";
import { buildEarlyFieldworkDataset, buildQualityDataset, datasetDefinition, summarizeDataset, variedAnswers, type DatasetOutcome } from "./dataset.js";
import { arrivedBefore } from "./arrival.js";
import { RULES } from "./catalogue.js";

/**
 * THE ENGINE, AGAINST PEOPLE WHOSE QUALITY IS KNOWN.
 *
 * This is the test the rework is for. Before it, an ordinary respondent who
 * was quick, from an office IP, on a common laptop, who pasted one answer and
 * agreed with every satisfaction item, accumulated enough weak, correlated
 * signals to be HIGHLY SUSPICIOUS. The population in `dataset.ts` has 158
 * such people written to be valid, 20 borderline, 46 written to be caught.
 */
function run() {
  const { def, respondents } = buildQualityDataset();
  const { bySession } = assessSurvey(def, respondents.map((r) => r.response), undefined, 1_700_000_000_000 + 3_600_000);
  const outcomes: DatasetOutcome[] = respondents.map((r) => {
    const a = bySession.get(r.response.sessionId)!;
    return {
      label: r.label, persona: r.persona, sessionId: r.response.sessionId,
      verdict: a.verdict, classification: a.classification, risk: a.riskScore, quality: a.qualityScore,
      because: a.evidence.because, rules: a.flags.map((f) => `${f.ruleId}${f.role === "informational" ? "(i)" : ""}:${f.riskPoints}`),
    };
  });
  return summarizeDataset(outcomes);
}

const report = run();
const say = (o: DatasetOutcome) => `${o.sessionId} ${o.persona} → ${o.verdict} (${o.classification}, risk ${o.risk}) ${o.rules.join(" ")} — ${o.because}`;

test("THE POPULATION IS WHAT IT SAYS: 164 valid, 20 borderline, 40 invalid (the six originals of the duplicate pairs are valid — CLEAN-09)", () => {
  assert.equal(report.byLabel.valid.n, 164);
  assert.equal(report.byLabel.borderline.n, 20);
  assert.equal(report.byLabel.invalid.n, 40);
});

test("DUPLICATE PAIRS: the later copy is FLAGGED, the original survives as CLEAN with the duplicate flag kept as evidence", () => {
  const originals = report.outcomes.filter((o) => o.persona === "duplicate submission (original)");
  const copies = report.outcomes.filter((o) => o.persona === "duplicate submission (copy)");
  assert.equal(originals.length, 6);
  assert.equal(copies.length, 6);
  for (const o of originals) {
    assert.equal(o.verdict, "PASS", say(o));
    assert.equal(o.classification, "CLEAN", say(o));
    assert.ok(o.rules.some((r) => r.startsWith("duplicate.") && r.includes("(i)")), `the original still records the duplicate, as information: ${say(o)}`);
  }
  for (const o of copies) assert.equal(o.verdict, "FLAGGED", say(o));
});

test("arrivedBefore: strictly earlier by completion, ties broken by session id so exactly one of a pair is the original; unknown order is never 'earlier'", () => {
  const a = { sessionId: "a", completedAt: "2026-01-01T10:00:00Z", startedAt: "2026-01-01T09:50:00Z" };
  const b = { sessionId: "b", completedAt: "2026-01-01T10:05:00Z", startedAt: "2026-01-01T09:40:00Z" };
  assert.equal(arrivedBefore(a, b), true);
  assert.equal(arrivedBefore(b, a), false);
  const t1 = { sessionId: "x1", completedAt: "2026-01-01T10:00:00Z" }, t2 = { sessionId: "x2", completedAt: "2026-01-01T10:00:00Z" };
  assert.equal(arrivedBefore(t1, t2) !== arrivedBefore(t2, t1), true, "a tie still has exactly one earlier");
  assert.equal(arrivedBefore({ sessionId: "n", completedAt: null, startedAt: null }, a), false);
  assert.equal(arrivedBefore(a, { sessionId: "n", completedAt: null, startedAt: null }), false);
  assert.equal(arrivedBefore({ sessionId: "s1", completedAt: null, startedAt: "2026-01-01T09:00:00Z" }, a), true, "falls back to the start time");
});

test("DUPLICATE PAIR WITH IDENTICAL TIMESTAMPS: exactly one is excluded from the clean set, never both, never neither", () => {
  const { def, respondents } = buildQualityDataset();
  const base = respondents.find((r) => r.persona === "duplicate submission (original)")!.response;
  const answers = variedAnswers(900);
  const twin = (sessionId: string) => ({ ...base, sessionId, answers: { ...answers }, deviceHash: "dev-tie", ipHash: "ip-tie", telemetry: null });
  const all = [...respondents.map((r) => r.response), twin("tie-a"), twin("tie-b")];
  const { bySession } = assessSurvey(def, all, undefined, 1_700_000_000_000 + 3_600_000);
  const a = bySession.get("tie-a")!, b = bySession.get("tie-b")!;
  const kept = [a, b].filter((x) => x.classification === "CLEAN");
  const dropped = [a, b].filter((x) => x.classification !== "CLEAN");
  assert.equal(kept.length, 1, `one survives: ${a.classification}/${b.classification} ${a.reasons.join("|")} // ${b.reasons.join("|")}`);
  assert.equal(dropped.length, 1);
  assert.ok(a.flags.some((f) => f.ruleId.startsWith("duplicate.")) && b.flags.some((f) => f.ruleId.startsWith("duplicate.")), "both still record the duplicate as evidence");
  assert.equal(kept[0], a, "the lower session id is the original when timestamps tie");
});

test("a researcher who set the duplicate rules to 'classifying' still keeps the original: arrival order wins over the configured role, but a coordinated ring is flagged whole", () => {
  const rules = { "duplicate.answers": { role: "classifying" as const }, "duplicate.multi_signal": { role: "classifying" as const }, "openend.duplicate": { role: "classifying" as const }, "matrix.signature_match": { role: "classifying" as const }, "timing.pattern_match": { role: "classifying" as const } };
  const def = datasetDefinition({ enabled: true, strictness: "standard", rules });
  const { respondents } = buildQualityDataset();
  const base = respondents.find((r) => r.persona === "duplicate submission (original)")!.response;
  const twin = (sessionId: string, completedAt: string) => ({ ...base, sessionId, answers: { ...variedAnswers(901) }, deviceHash: "dev-role", ipHash: "ip-role", telemetry: null, completedAt });
  const pair = [twin("role-a", "2026-01-02T10:00:00Z"), twin("role-b", "2026-01-02T10:30:00Z")];
  const { bySession } = assessSurvey(def, [...respondents.map((r) => r.response), ...pair], undefined, 1_700_000_000_000 + 3_600_000);
  assert.equal(bySession.get("role-a")!.classification, "CLEAN", "the earlier arrival is the original");
  assert.notEqual(bySession.get("role-b")!.classification, "CLEAN", "the later arrival is the copy");
  assert.ok(bySession.get("role-a")!.flags.some((f) => f.ruleId.startsWith("duplicate.") && f.role === "informational"));
});

test("NORMAL RESPONDENTS ARE NOT MARKED BAD: no valid respondent is FLAGGED, and at least 90% simply PASS", () => {
  const flagged = report.outcomes.filter((o) => o.label === "valid" && o.verdict === "FLAGGED");
  assert.equal(flagged.length, 0, `valid respondents flagged:\n${flagged.map(say).join("\n")}`);
  assert.ok(report.validPassRate >= 90, `valid PASS rate ${report.validPassRate}%:\n${report.outcomes.filter((o) => o.label === "valid" && o.verdict !== "PASS").map(say).join("\n")}`);
});

test("the people the brief names are fine: fast readers, agree-alls, one tab switch, a skipped optional, an office IP", () => {
  for (const persona of ["fast but legitimate reader", "satisfied customer who agrees with every positive item", "switched tabs once", "skipped the optional question", "office worker behind a shared IP", "went back once, reloaded once", "slow, careful respondent"]) {
    const p = report.byPersona[persona]!;
    assert.ok(p, `persona missing: ${persona}`);
    assert.equal(p.FLAGGED, 0, `${persona}: ${JSON.stringify(p)}`);
  }
});

test("BORDERLINE IS REVIEW AT WORST — never FLAGGED on one weak or correlated signal", () => {
  const flagged = report.outcomes.filter((o) => o.label === "borderline" && o.verdict === "FLAGGED");
  assert.equal(flagged.length, 0, `borderline respondents flagged:\n${flagged.map(say).join("\n")}`);
});

test("INVALID RESPONDENTS ARE CAUGHT: at least 85% FLAGGED, none PASS", () => {
  const passed = report.outcomes.filter((o) => o.label === "invalid" && o.verdict === "PASS");
  assert.equal(passed.length, 0, `invalid respondents that passed:\n${passed.map(say).join("\n")}`);
  assert.ok(report.invalidFlaggedRate >= 85, `invalid FLAGGED rate ${report.invalidFlaggedRate}%:\n${report.outcomes.filter((o) => o.label === "invalid" && o.verdict !== "FLAGGED").map(say).join("\n")}`);
});

test("every verdict says why, and a FLAGGED one names the evidence that carried it", () => {
  for (const o of report.outcomes) {
    assert.ok(o.because.length > 10, say(o));
    if (o.verdict === "FLAGGED") assert.ok(o.rules.length >= 1 && /Strong evidence|Independent signals|custom rule/i.test(o.because), say(o));
  }
});

test("the classification never disagrees with the verdict", () => {
  for (const o of report.outcomes) {
    if (o.verdict === "PASS") assert.equal(o.classification, "CLEAN", say(o));
    if (o.verdict === "REVIEW") assert.equal(o.classification, "REVIEW", say(o));
    if (o.verdict === "FLAGGED") assert.ok(["SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"].includes(o.classification), say(o));
  }
});

/* ------------------------------------------------------ the production symptom */

function runEarly(def = datasetDefinition()) {
  const { respondents } = buildEarlyFieldworkDataset();
  const { bySession } = assessSurvey(def, respondents.map((r) => r.response), undefined, 1_700_000_000_000 + 24 * 3_600_000);
  return respondents.map((r) => {
    const a = bySession.get(r.response.sessionId)!;
    return { sessionId: r.response.sessionId, verdict: a.verdict, classification: a.classification, risk: a.riskScore, because: a.evidence.because, rules: a.flags.map((f) => `${f.ruleId}${f.role === "informational" ? "(i)" : ""}:${f.riskPoints}`) };
  });
}

/** The engine as it was: every signal independent and classifying, bands alone decide, medians trusted from 8 completes, shares from 5. */
function oldModel() {
  const rules: Record<string, { role: "classifying" }> = {};
  for (const r of RULES) rules[r.id] = { role: "classifying" };
  return datasetDefinition({
    enabled: true, strictness: "standard", rules,
    evidence: { combination: "independent", flagged: "bands_only", minPeers: 8, minPopulation: 5, estimateConfidence: 1, flaggedMinCategories: 1 },
  });
}

test("THE OFFICE THAT TESTED ITS OWN SURVEY: twelve quick colleagues on one IP are not fraud", () => {
  const out = runEarly();
  const flagged = out.filter((o) => o.verdict === "FLAGGED");
  assert.equal(flagged.length, 0, flagged.map((o) => `${o.sessionId} → ${o.verdict} (${o.classification}, risk ${o.risk}) ${o.rules.join(" ")} — ${o.because}`).join("\n"));
  const pass = out.filter((o) => o.verdict === "PASS").length;
  assert.ok(pass >= 9, `expected most to PASS, got ${pass} of 12:\n${out.map((o) => `${o.sessionId} ${o.verdict} ${o.rules.join(" ")}`).join("\n")}`);
  /* and the shared-network observations are still THERE, as information */
  assert.ok(out.some((o) => o.rules.some((r) => r.startsWith("network.ip_density(i)") || r.startsWith("network.duplicate_ip(i)"))), "the shared IP is noted, not counted");
});

test("…and the model as it was would have flagged most of them — the regression this guards", () => {
  const out = runEarly(oldModel());
  const flagged = out.filter((o) => o.verdict === "FLAGGED").length;
  assert.ok(flagged >= 6, `old model flagged ${flagged} of 12; the symptom should reproduce:\n${out.map((o) => `${o.sessionId} ${o.verdict} risk ${o.risk} ${o.rules.join(" ")}`).join("\n")}`);
});
