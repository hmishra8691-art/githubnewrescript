import test from "node:test";
import assert from "node:assert/strict";
import { assessSurvey } from "./engine.js";
import { buildEarlyFieldworkDataset, buildQualityDataset, datasetDefinition, summarizeDataset, type DatasetOutcome } from "./dataset.js";
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

test("THE POPULATION IS WHAT IT SAYS: 158 valid, 20 borderline, 46 invalid", () => {
  assert.equal(report.byLabel.valid.n, 158);
  assert.equal(report.byLabel.borderline.n, 20);
  assert.equal(report.byLabel.invalid.n, 46);
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
