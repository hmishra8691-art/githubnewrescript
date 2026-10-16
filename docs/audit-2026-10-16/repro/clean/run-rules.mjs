/**
 * Audit repro (CLEAN): run @rescript/quality over a synthetic set of 30
 * responses — 23 careful people, 3 speeders, 2 straight-liners, 2 duplicates —
 * and report what every rule flags and with what reason text.
 *
 * Imports the built package; nothing in the repo is modified.
 */
import { assessSurvey, datasetDefinition, telemetry, variedAnswers, HUMAN_SECS, enabledRuleIds, resolveConfig } from "/home/claude/rescript/packages/quality/dist/index.js";
import { pick } from "/home/claude/rescript/packages/quality/dist/dataset.js";
// per-(person, page) multiplier from the package's own hash — no two people share a profile
const jitter = (i, k, lo, hi) => lo + (pick(i, 100 + k, 1000) - 1) / 999 * (hi - lo);

const def = datasetDefinition({ enabled: true, strictness: "standard" });
const START = 1_700_000_000_000;
const iso = (ms) => new Date(ms).toISOString();

function person(i, { pageSecs = HUMAN_SECS, answers, device = {}, deviceHash, ipHash, latencyMs } = {}) {
  const t = telemetry(pageSecs, { startOffsetSec: i * 600, device, latencyMs });
  return {
    sessionId: `s${String(i).padStart(3, "0")}`,
    status: "complete",
    answers: answers ?? variedAnswers(i),
    startedAt: iso(t.startedAt),
    completedAt: iso(t.submittedAt),
    telemetry: t,
    deviceHash: deviceHash ?? `dev-${i}`,
    ipHash: ipHash ?? `ip-${i}`,
  };
}

const labels = new Map();
const responses = [];
// 23 careful respondents with a little natural variation in pace
for (let i = 0; i < 23; i++) {
  // each page gets its own deterministic jitter (0.7 … 1.3) so no two people share a timing profile
  responses.push(person(i, { pageSecs: HUMAN_SECS.map((s, k) => Math.max(2, Math.round(s * jitter(i, k, 0.7, 1.3)))) }));
  labels.set(`s${String(i).padStart(3, "0")}`, "valid");
}
// 3 speeders: every page at ~15% of a careful person's time, instant reactions
for (let i = 23; i < 26; i++) {
  responses.push(person(i, { pageSecs: HUMAN_SECS.map((s, k) => Math.max(1, Math.round(s * 0.15 * jitter(i, k, 0.8, 1.2)))), latencyMs: 350 }));
  labels.set(`s${String(i).padStart(3, "0")}`, "speeder");
}
// 2 straight-liners: the same column on every row of both grids (and the scale items)
for (let i = 26; i < 28; i++) {
  const a = variedAnswers(i);
  const col = i === 26 ? "4" : "3";
  a.grid = Object.fromEntries(Object.keys(a.grid).map((r) => [r, col]));
  a.grid2 = Object.fromEntries(Object.keys(a.grid2).map((r) => [r, col]));
  responses.push(person(i, { answers: a, pageSecs: HUMAN_SECS.map((s, k) => Math.max(2, Math.round(s * jitter(i, k, 0.7, 1.3)))) }));
  labels.set(`s${String(i).padStart(3, "0")}`, "straight-liner");
}
// 2 duplicates: s028 = s005's answers from the same device (multi-signal); s029 = s006's answers, nothing else shared
responses.push(person(28, { answers: JSON.parse(JSON.stringify(responses[5].answers)), deviceHash: "dev-5", ipHash: "ip-5", pageSecs: HUMAN_SECS.map((s, k) => Math.max(2, Math.round(s * jitter(28, k, 0.7, 1.3)))) }));
labels.set("s028", "duplicate (of s005, same device+IP)");
responses.push(person(29, { answers: JSON.parse(JSON.stringify(responses[6].answers)), pageSecs: HUMAN_SECS.map((s, k) => Math.max(2, Math.round(s * jitter(29, k, 0.7, 1.3)))) }));
labels.set("s029", "duplicate (of s006, answers only)");

const cfg = resolveConfig(def);
console.log(`strictness=${cfg.strictness} enabled rules=${enabledRuleIds(cfg).length} minPeers=${cfg.evidence.minPeers} bands=${JSON.stringify(cfg.bands)}`);
console.log(`responses=${responses.length}\n`);

const sa = assessSurvey(def, responses, undefined, START + 10 * 24 * 3600 * 1000);
const byRule = new Map();
const rows = [];
for (const r of responses) {
  const a = sa.bySession.get(r.sessionId);
  rows.push({ id: r.sessionId, label: labels.get(r.sessionId), verdict: a.verdict, cls: a.classification, risk: a.riskScore, quality: a.qualityScore, flags: a.flags });
  for (const f of a.flags) {
    const e = byRule.get(f.ruleId) ?? { n: 0, who: [], samples: [] };
    e.n++; e.who.push(`${r.sessionId}[${labels.get(r.sessionId).split(" ")[0]}]`);
    if (e.samples.length < 2) e.samples.push({ observed: f.observed, expected: f.expected, explanation: f.explanation, role: f.role, strength: f.strength, confidence: f.confidence, caveat: f.caveat, riskPoints: f.riskPoints, qualityPenalty: f.qualityPenalty });
    byRule.set(f.ruleId, e);
  }
}

console.log("== Per respondent ==");
for (const r of rows) {
  console.log(`${r.id}  ${r.label.padEnd(34)} verdict=${r.verdict.padEnd(7)} class=${r.cls.padEnd(17)} risk=${String(r.risk).padStart(3)} quality=${String(r.quality).padStart(3)}  flags=[${r.flags.map((f) => f.ruleId + (f.role === "informational" ? "(info)" : "")).join(", ")}]`);
}

console.log("\n== Per rule: who it flagged and the reason text ==");
for (const [rule, e] of [...byRule.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`\n${rule}  (${e.n} firings): ${e.who.join(", ")}`);
  for (const s of e.samples) {
    console.log(`   observed: ${s.observed}`);
    if (s.expected) console.log(`   expected: ${s.expected}`);
    console.log(`   explanation: ${s.explanation}`);
    console.log(`   role=${s.role} strength=${s.strength} confidence=${s.confidence} risk+${s.riskPoints} quality-${s.qualityPenalty}${s.caveat ? ` caveat: ${s.caveat}` : ""}`);
  }
}

// summary against the planted labels
const flaggedOf = (lab) => rows.filter((r) => r.label.startsWith(lab));
const summary = (lab) => { const xs = flaggedOf(lab); return `${lab}: ${xs.length} planted → ${xs.filter((r) => r.verdict === "FLAGGED").length} FLAGGED, ${xs.filter((r) => r.verdict === "REVIEW").length} REVIEW, ${xs.filter((r) => r.verdict === "PASS").length} PASS`; };
console.log("\n== Summary ==");
for (const lab of ["valid", "speeder", "straight-liner", "duplicate"]) console.log(summary(lab));
console.log(`clusters: ${sa.clusters.size ? [...new Set([...sa.clusters.values()].map((c) => c.clusterId + ":" + c.members.join("+")))].join("; ") : "none"}`);
