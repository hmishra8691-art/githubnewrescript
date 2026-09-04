/**
 * Browser suite — Response Quality & Fraud Detection.
 *
 *   1. Survey settings → Quality checks: toggle, strictness, bands, a rule
 *      override, a custom rule, telemetry switches — all land in def.quality.
 *   2. Question editor: mark an attention check with expected codes.
 *   3. Runtime event collector: a preview run records page visits, question
 *      latency, pastes (lengths only), back moves, device — never clipboard text.
 *   4. Data → Quality dashboard (route-intercepted): counts, signal chips,
 *      cluster chips, filter, review drawer with explained flags, KEEP /
 *      REMOVE decisions PATCHed with a reason, audit tab, dataset selector
 *      and export links carrying the dataset filter.
 *
 *   STUDIO_URL=http://localhost:3000 RUNTIME_URL=http://localhost:3001 node scripts/quality-test.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const { page } = h;
const runtime = process.env.RUNTIME_URL ?? "http://localhost:3001";

const scale = ["1", "2", "3", "4", "5"].map((c, i) => ({ code: c, label: ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"][i] }));
const def = () => ({
  meta: { id: "sandbox", code: "SANDBOX", title: "Quality", version: "1.0" },
  quality: { enabled: false },
  questions: [
    { id: "own", code: "S1", variableName: "S1", type: "single_select", text: "Do you own a car?", options: [{ code: "y", label: "Yes" }, { code: "n", label: "No" }], settings: {} },
    { id: "att", code: "Q1", variableName: "Q1", type: "single_select", text: "Please select 'Beta' to continue.", options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }], settings: {} },
    { id: "grid", code: "Q2", variableName: "Q2", type: "matrix_single", text: "Agree?", rows: [{ code: "r1", label: "Reliable" }, { code: "r2", label: "Comfortable" }, { code: "r3", label: "Not worth the money" }, { code: "r4", label: "Fun" }], options: scale, settings: {} },
    { id: "oe", code: "Q3", variableName: "Q3", type: "long_text", text: "Why?", settings: {} },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["own"] },
    { type: "page", id: "p2", questionIds: ["att", "grid"] },
    { type: "page", id: "p3", questionIds: ["oe"] },
    { type: "end", id: "e", status: "complete" },
  ],
});
await h.loadDef(def());

/* ============================================================ 1. settings */
await h.goTab("Survey Settings");
await page.waitForSelector('[data-testid="quality-settings"]');
assert.equal(await page.isChecked('[data-testid="quality-enabled"]'), false);
await page.click('[data-testid="quality-enabled"]');
await page.waitForSelector('[data-testid="quality-strictness"]');
await page.selectOption('[data-testid="quality-strictness"]', "strict");
await page.fill('[data-testid="qband-review"]', "15");
await page.fill('[data-testid="qband-critical"]', "85");
// open the timing rules, disable one, change a threshold
await page.click('[data-testid="qrules-timing"] .row');
await page.click('[data-testid="qrule-timing.uniform"] [data-testid="qrule-enabled"]');
await page.click('[data-testid="qrule-timing.overall_speeding"] >> text=edit');
await page.fill('[data-testid="qrule-timing.overall_speeding"] [data-testid="qparam-ratio"]', "0.55");
await page.selectOption('[data-testid="qrule-timing.overall_speeding"] [data-testid="qrule-severity"]', "critical");
// telemetry switch + disclosure
await page.click('[data-testid="qtel-clipboard"]');
await page.fill('[data-testid="qtel-disclosure"]', "We record timing to protect data quality.");
// custom rule
await page.click('[data-testid="qcustom-add"]');
await page.waitForSelector('[data-testid="qcustom-rule"]');
await page.fill('[data-testid="qcustom-rule"] [data-testid="qcustom-name"]', "Fast and inattentive");
await page.fill('[data-testid="qcustom-rule"] [data-testid="qcustom-risk"]', "40");
await page.selectOption('[data-testid="qcustom-rule"] [data-testid="qcustom-minclass"]', "HIGHLY_SUSPICIOUS");
await page.waitForTimeout(400);
let d = await h.readDef();
assert.equal(d.quality.enabled, true);
assert.equal(d.quality.strictness, "strict");
assert.equal(d.quality.bands.review, 15);
assert.equal(d.quality.bands.critical, 85);
assert.equal(d.quality.rules["timing.uniform"].enabled, false, "a rule can be switched off");
assert.equal(d.quality.rules["timing.overall_speeding"].params.ratio, 0.55, "a threshold override is stored");
assert.equal(d.quality.rules["timing.overall_speeding"].severity, "critical");
assert.equal(d.quality.telemetry.clipboard, false);
assert.equal(d.quality.telemetry.disclosure, "We record timing to protect data quality.");
assert.equal(d.quality.customRules.length, 1);
assert.equal(d.quality.customRules[0].name, "Fast and inattentive");
assert.equal(d.quality.customRules[0].riskPoints, 40);
assert.equal(d.quality.customRules[0].minClass, "HIGHLY_SUSPICIOUS");
assert.equal(d.quality.customRules[0].when.children[0].source.kind, "calculation", "custom rules test calc.SYSTEM_* metrics");
console.log("✔ Survey settings → Quality checks: toggle, strictness, bands, rule override, telemetry, custom rule all persist in def.quality");

/* ------------------------------------------------ 1b. save status, saved-rule display, layout */
// the settings panel states the draft's save state beside the controls (the sandbox has no database row)
assert.match(await page.textContent('[data-testid="quality-save-state"]'), /Sandbox/);
// a custom rule over calc.SYSTEM_* displays as that metric, not as the "pick a question" placeholder
{
  const selected = await page.$eval('[data-testid="qcustom-rule"] select.ref-select', (el) => el.options[el.selectedIndex]?.textContent ?? "");
  assert.match(selected, /SYSTEM_DURATION_RATIO/, `custom-rule source shows the saved metric (got "${selected}")`);
}
// the "Re-assess" button keeps its label inside its box and clear of the help text
{
  const btn = await page.$('[data-testid="q-preview-impact"]');
  const fits = await btn.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert.ok(fits, "the Re-assess button is not narrower than its label");
  const b = await btn.boundingBox();
  const help = await page.$('[data-testid="q-preview-impact"] ~ .qs-help');
  const hb = await help.boundingBox();
  assert.ok(hb.y >= b.y + b.height - 1 || hb.x >= b.x + b.width - 1, "help text does not overlap the button");
}
// no horizontal overflow anywhere in the settings panel
{
  const overflow = await page.$eval('[data-testid="quality-settings"]', (root) => {
    const right = root.getBoundingClientRect().right + 1;
    return [...root.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > right && getComputedStyle(el).position !== "absolute")
      .slice(0, 6).map((el) => `${el.tagName}.${el.className} right=${Math.round(el.getBoundingClientRect().right)} vs ${Math.round(right)} "${(el.textContent || "").slice(0, 40)}"`);
  });
  assert.deepEqual(overflow, [], "no element extends past the panel's right edge");
}
// clearing a numeric field does not snap to a default while typing; the stored value survives a reload of the panel
await page.fill('[data-testid="qband-review"]', "15");
await h.goTab("Questions");
await h.goTab("Survey Settings");
assert.equal(await page.inputValue('[data-testid="qband-review"]'), "15", "band value re-rendered from def.quality after leaving and returning");
assert.equal(await page.inputValue('[data-testid="quality-strictness"]'), "strict");
assert.equal(await page.isChecked('[data-testid="qtel-clipboard"]'), false);
console.log("✔ settings panel: save state shown, saved SYSTEM_* rule displayed as itself, Re-assess button/help text laid out without overlap, values survive leaving and returning");

// applying a built-in profile
await h.goTab("Survey Settings");
await page.selectOption('[data-testid="quality-profile-select"]', "b2b_relaxed");
await page.waitForTimeout(300);
d = await h.readDef();
assert.equal(d.quality.strictness, "relaxed");
assert.equal(d.quality.profile, "B2B — Relaxed");
assert.equal(d.quality.rules["network.duplicate_ip"].enabled, false, "the profile's rule overrides are applied");
console.log("✔ a quality profile applies strictness and rule overrides");

/* ============================================================ 2. attention check */
await h.goTab("Questions");
await page.waitForSelector('[data-testid="block"]');
await page.click('[data-testid="block"] >> nth=1 >> .qcard-text >> nth=0');
await page.waitForSelector('.qcard.selected [data-testid="attention-toggle"]');
await page.click('.qcard.selected [data-testid="attention-toggle"]');
await page.waitForSelector('.qcard.selected [data-testid="attention-kind"]');
await page.selectOption('.qcard.selected [data-testid="attention-kind"]', "instruction");
await page.click('.qcard.selected [data-testid="attention-expected"] label:has-text("b: Beta") input');
await page.fill('.qcard.selected [data-testid="attention-risk"]', "30");
await page.waitForTimeout(300);
d = await h.readDef();
const att = d.questions.find((q) => q.id === "att");
assert.deepEqual(att.attentionCheck, { kind: "instruction", expected: ["b"], severity: "high", riskPoints: 30, qualityPenalty: 20 });
await h.goTab("Survey Settings");
assert.match(await page.textContent('[data-testid="quality-attention-summary"]'), /Q1 · instruction · expects b/);
console.log("✔ a question marked as an attention check stores kind, expected codes, severity and points; the settings page lists it");

/* ============================================================ 3. event collector */
d = await h.readDef();
d.quality.enabled = true;
d.quality.telemetry.clipboard = true;
d.quality.telemetry.disclosure = "We record timing to protect data quality.";
await h.loadDef(d);
const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
await pv.goto(`${runtime}/preview`, { waitUntil: "networkidle" });
await pv.evaluate((dd) => window.postMessage({ type: "rescript:preview", definition: dd }, "*"), d);
await pv.waitForSelector('[data-qid="own"]');
assert.equal(await pv.textContent('[data-testid="rs-quality-disclosure"]'), "We record timing to protect data quality.", "the disclosure shows in the runtime footer");
await pv.waitForTimeout(700);
await pv.click('[data-qid="own"] input[value="y"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="att"]');
await pv.click('[data-qid="att"] input[value="a"]');
// paste into the open end after going forward
for (const r of ["r1", "r2", "r3", "r4"]) await pv.click(`[data-qid="grid"] input[name="grid_${r}"][value="4"], [data-qid="grid"] [data-row="${r}"] input[value="4"]`).catch(() => {});
// a grid may render differently; answer through state if the click selectors missed
await pv.evaluate(() => { const st = window.__rescriptState; if (!st.answers.grid) st.answers.grid = { r1: "4", r2: "4", r3: "4", r4: "4" }; });
// back and forward to record navigation
await pv.click(".rs-nav .rs-btn.secondary");
await pv.waitForSelector('[data-qid="own"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="att"]');
await h.next(pv);
await pv.waitForSelector('[data-qid="oe"]');
const ta = await pv.$('[data-qid="oe"] textarea, [data-qid="oe"] input');
await ta.focus();
await pv.keyboard.type("Because ");
// simulate a paste event with real clipboard data (the collector records the LENGTH only)
await pv.evaluate(() => {
  const el = document.querySelector('[data-qid="oe"] textarea, [data-qid="oe"] input');
  const dt = new DataTransfer();
  dt.setData("text/plain", "this secret sentence must never be stored");
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
});
await pv.keyboard.type("it works.");
const tel = await pv.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptTelemetry)));
assert.equal(tel.v, 1);
assert.ok(tel.pages.length >= 5, `page visits recorded (${tel.pages.length})`);
assert.equal(tel.pages[0].pageId, "p1");
assert.equal(tel.pages[0].via, "start");
assert.ok(tel.pages.some((v) => v.via === "back"), "the back move is a visit");
assert.equal(tel.navigation.back, 1);
assert.ok(tel.questions.own.latencyMs >= 500, `latency from page entry to first answer recorded (${tel.questions.own.latencyMs})`);
assert.equal(tel.questions.own.changes, 1);
assert.equal(tel.clipboard.pastes, 1);
assert.equal(tel.clipboard.pasteChars, "this secret sentence must never be stored".length);
assert.equal(tel.questions.oe.pastes, 1);
assert.ok(!JSON.stringify(tel).includes("secret sentence"), "clipboard CONTENT is never in the telemetry");
assert.ok(tel.interaction.pointerEvents > 0 && tel.interaction.keyEvents > 0);
assert.equal(tel.device.type, "desktop");
assert.ok(tel.device.timezone && tel.device.language, "device class recorded");
assert.deepEqual(tel.disabled, []);
await pv.close();
console.log("✔ runtime event collector: visits, back moves, question latency, paste counts & lengths (never text), interaction counts, device class");

// telemetry switches are honoured by the collector
d.quality.telemetry.clipboard = false;
d.quality.telemetry.device = false;
const pv2 = await h.browser.newPage();
await pv2.goto(`${runtime}/preview`, { waitUntil: "networkidle" });
await pv2.evaluate((dd) => window.postMessage({ type: "rescript:preview", definition: dd }, "*"), d);
await pv2.waitForSelector('[data-qid="own"]');
await pv2.evaluate(() => {
  const dt = new DataTransfer(); dt.setData("text/plain", "abc");
  document.querySelector('[data-qid="own"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
});
const tel2 = await pv2.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptTelemetry)));
assert.equal(tel2.clipboard.pastes, 0, "clipboard off → nothing counted");
assert.equal(tel2.device, undefined, "device off → nothing recorded");
assert.deepEqual(tel2.disabled.sort(), ["clipboard", "device"]);
await pv2.close();
console.log("✔ telemetry switches: disabled categories record nothing and are listed as not measured");

/* ============================================================ 4. dashboard (route-intercepted) */
const flag = (ruleId, category, severity, title, observed, expected, explanation, riskPoints, qualityPenalty, questionIds = [], relatedSessionIds) =>
  ({ ruleId, category, severity, title, observed, expected, explanation, riskPoints, qualityPenalty, questionIds, relatedSessionIds, at: "2026-09-04T00:00:00Z" });
const assessment = (over) => ({
  version: 1, computedAt: "2026-09-04T00:00:00Z", strictness: "standard", enabled: true,
  qualityScore: 100, riskScore: 0, classification: "CLEAN", categories: {}, flags: [], reasons: [], recommendation: "INCLUDE",
  system: { SYSTEM_TOTAL_DURATION: 200, SYSTEM_MEDIAN_DURATION: 210, SYSTEM_DURATION_RATIO: 0.95 }, cluster: { clusterId: null, similarityScore: 0, similarSessionIds: [], clusterRisk: 0, size: 1, sharedSignals: [] },
  notMeasured: [], benchmarks: { peers: 40, medianDurationSec: 210 }, ...over,
});
const badFlags = [
  flag("timing.overall_speeding", "timing", "high", "Overall speeding", "3:14", "≥ 8:24 (median of 40 completes 11:40)", "Completion time was 72% below the benchmark (median of 40 completes).", 35, 30),
  flag("matrix.straightline", "matrix", "medium", "Straight-lining", "2 of 2 grids straight-lined (Q2)", "fewer than 51% of grids", "The same column was chosen for almost every row of the grid.", 15, 20, ["grid"]),
  flag("attention.failed", "attention", "high", "Attention check failed (Q1)", "Alpha", "Beta", "The instruction in Q1 was not followed.", 25, 20, ["att"]),
  flag("duplicate.answers", "duplicate", "high", "Near-identical answers to another respondent", "91% of 22 comparable answers agree with respondent 10476aaa", "weighted agreement < 93%", "Closed-question answers agree with another respondent far beyond what the survey's answer distribution predicts.", 30, 0, [], ["10476aaa11112222"]),
  flag("device.duplicate", "device", "medium", "Same device signature across responses", "3 other complete responses share this device signature", "< 3", "The same browser family, platform, screen, timezone and language produced other responses.", 15, 0, [], ["10476aaa11112222", "10477bbb11112222"]),
  flag("openend.duplicate", "open_end", "high", "Duplicate / near-duplicate text across respondents", "Q3 92% similar to 1 other", "similarity < 85%", "An open-ended answer is the same, or nearly the same, as another respondent's.", 25, 10, ["oe"], ["10476aaa11112222"]),
];
const bad = assessment({
  qualityScore: 38, riskScore: 81, classification: "HIGHLY_SUSPICIOUS", recommendation: "LIKELY EXCLUDE",
  categories: { timing: 35, matrix: 15, attention: 25, duplicate: 30, device: 15, open_end: 25 },
  flags: badFlags, reasons: badFlags.map((f) => `${f.title}: ${f.observed} (expected ${f.expected}).`),
  system: { SYSTEM_TOTAL_DURATION: 194, SYSTEM_MEDIAN_DURATION: 700, SYSTEM_DURATION_RATIO: 0.28 },
  cluster: { clusterId: "c_deadbeef", similarityScore: 91, similarSessionIds: ["10476aaa11112222", "10477bbb11112222"], clusterRisk: 72, size: 3, sharedSignals: ["device signature"] },
});
const rowsDb = {
  "10482aaa11112222": { status: "complete", quality: bad, review: null },
  "10476aaa11112222": { status: "complete", quality: assessment({ qualityScore: 62, riskScore: 55, classification: "SUSPICIOUS", recommendation: "REVIEW BEFORE INCLUSION", categories: { duplicate: 30, device: 15 }, flags: badFlags.slice(3, 5), reasons: badFlags.slice(3, 5).map((f) => `${f.title}: ${f.observed}.`), cluster: { clusterId: "c_deadbeef", similarityScore: 91, similarSessionIds: ["10482aaa11112222", "10477bbb11112222"], clusterRisk: 72, size: 3, sharedSignals: ["device signature"] } }), review: null },
  "10477bbb11112222": { status: "complete", quality: assessment({ qualityScore: 70, riskScore: 22, classification: "REVIEW", recommendation: "REVIEW BEFORE INCLUSION", categories: { device: 15 }, flags: [badFlags[4]], reasons: [`${badFlags[4].title}: ${badFlags[4].observed}.`], cluster: { clusterId: "c_deadbeef", similarityScore: 60, similarSessionIds: ["10482aaa11112222"], clusterRisk: 72, size: 3, sharedSignals: ["device signature"] } }), review: null },
  "20001ccc11112222": { status: "complete", quality: assessment({}), review: "KEEP" },
  "20002ddd11112222": { status: "complete", quality: assessment({}), review: null, olderSettings: true },
  "20003eee11112222": { status: "screened", quality: null, review: null },
};
const compact = (sid, r) => {
  const a = r.quality;
  return { sessionId: sid, status: r.status, startedAt: "2026-09-03T10:00:00Z", completedAt: "2026-09-03T10:05:00Z", durationSec: a?.system?.SYSTEM_TOTAL_DURATION ?? 300, assessed: !!a,
    configHash: a ? (r.olderSettings ? "0ld5e771" : CONFIG_HASH) : null, computedAt: a?.computedAt ?? null,
    qualityScore: a?.qualityScore ?? null, riskScore: a?.riskScore ?? null, classification: a?.classification ?? null, recommendation: a?.recommendation ?? null,
    categories: a?.categories ?? {}, flags: (a?.flags ?? []).map((f) => ({ ruleId: f.ruleId, category: f.category, severity: f.severity, title: f.title })),
    clusterId: a?.cluster?.clusterId ?? null, clusterSize: a?.cluster?.size ?? 1, reasons: a?.reasons ?? [],
    reviewStatus: r.review, reviewReason: r.reviewReason ?? null, reviewedAt: r.review ? "2026-09-03T11:00:00Z" : null, reviewedBy: r.review ? "researcher" : null };
};
const patches = [];
const CONFIG_HASH = "a1b2c3d4";
const summaryPayload = () => {
  const rows = Object.entries(rowsDb).map(([sid, r]) => compact(sid, r));
  const byClass = { CLEAN: 0, REVIEW: 0, SUSPICIOUS: 0, HIGHLY_SUSPICIOUS: 0, CRITICAL: 0, UNSCORED: 0 };
  const byReview = { KEEP: 0, REMOVE: 0, REVIEW_LATER: 0, NONE: 0 };
  const signals = {}; const histogram = new Array(10).fill(0);
  for (const r of rows) { byClass[r.classification ?? "UNSCORED"]++; byReview[r.reviewStatus ?? "NONE"]++; for (const c of new Set(r.flags.map((f) => f.category))) signals[c] = (signals[c] ?? 0) + 1; if (r.riskScore !== null) histogram[Math.min(9, Math.floor(r.riskScore / 10))]++; }
  const bands = { review: 20, suspicious: 40, highlySuspicious: 60, critical: 80 };
  return {
    enabled: true, strictness: "standard", bands, source: "draft", revision: 120, savedAt: "2026-09-04T12:36:47Z", version: "1.3",
    config: { enabled: true, strictness: "standard", profile: "Consumer Research — Standard", bands, rulesOn: 52, rulesTotal: 64, rulesCustomised: 2, customRules: 1, telemetryOff: ["clipboard"], maxPeers: 3000, configHash: CONFIG_HASH },
    live: { version: "1.2", versionId: "v12", config: { enabled: false, strictness: "standard", profile: null, bands, rulesOn: 0, rulesTotal: 64, rulesCustomised: 0, customRules: 0, telemetryOff: [], maxPeers: 3000, configHash: "ffffffff" } },
    staleAssessed: rows.filter((r) => r.assessed && r.configHash !== CONFIG_HASH).length,
    total: rows.length, byClass, byReview, signals, histogram, clusters: [{ id: "c_deadbeef", size: 3 }], rows,
  };
};
const dataRequests = [];
await page.route("**/api/surveys/*/quality/**", async (route) => {
  const req = route.request(); const url = new URL(req.url());
  const m = url.pathname.match(/\/quality\/([^/]+)$/);
  if (m && m[1] !== "recompute" && req.method() === "GET") {
    const sid = m[1]; const r = rowsDb[sid];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionId: sid, status: r.status, isTest: false, startedAt: "2026-09-03T10:00:00Z", completedAt: "2026-09-03T10:05:00Z", answers: { own: "y", att: "a" }, vars: { S1: "y", Q1: "a", Q2_r1: "4", Q3: "Because it works." }, quality: r.quality, review: { status: r.review, reason: r.reviewReason ?? null, by: r.review ? "researcher" : null, at: r.review ? "2026-09-03T11:00:00Z" : null }, reviews: patches.filter((p) => p.sid === sid).map((p) => ({ decision: p.decision, reason: p.reason, decided_by: "researcher", decided_at: "2026-09-04T00:00:00Z" })).reverse(), telemetry: { pages: 5, focus: { blurs: 1, totalOutOfFocusMs: 4000 }, clipboard: { copies: 0, pastes: 1, pasteChars: 41 }, navigation: { back: 1, reloads: 0, sequence: ["p1>", "p2>", "p1<", "p2>", "p3>"] }, interaction: { pointerEvents: 12, keyEvents: 30, scrollEvents: 2 }, device: { type: "desktop", browser: "Chrome", os: "macOS", screen: "1440x900", timezone: "Europe/London", locale: "en-GB", webdriver: false }, disabled: [] }, hashes: { ip: "ab12cd34ef", device: "9f8e7d6c5b" } }) });
  }
  if (m && req.method() === "PATCH") {
    const sid = m[1]; const body = JSON.parse(req.postData());
    patches.push({ sid, ...body });
    rowsDb[sid].review = body.decision === "CLEAR" ? null : body.decision;
    rowsDb[sid].reviewReason = body.reason ?? (body.decision === "REMOVE" ? "HIGH_QUALITY_RISK" : null);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, review: { status: rowsDb[sid].review, reason: rowsDb[sid].reviewReason } }) });
  }
  if (url.pathname.endsWith("/quality/recompute")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, results: { live: { assessed: 6, byClass: { CLEAN: 2 } } } }) });
  if (url.pathname.endsWith("/quality/profiles")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ builtin: [], saved: [] }) });
  return route.continue();
});
await page.route("**/api/surveys/*/quality?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summaryPayload()) }));
await page.route("**/api/surveys/*/responses*", (route) => {
  const url = new URL(route.request().url());
  dataRequests.push(url.search);
  if (url.searchParams.get("format") === "summary") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ live: { in_progress: 0, complete: 5, screened: 1, quota_full: 0, terminated: 0, total: 6 }, test: { in_progress: 0, complete: 0, screened: 0, quota_full: 0, terminated: 0, total: 0 } }) });
  const ds = url.searchParams.get("dataset") ?? "all";
  const rows = Object.entries(rowsDb).filter(([, r]) => ds === "all" ? true : r.review === "REMOVE" ? false : r.review === "KEEP" ? true : ds === "clean" ? (r.quality?.classification ?? "CLEAN") === "CLEAN" : !ds.slice(7).split(",").includes(r.quality?.classification ?? "UNSCORED"))
    .map(([sid, r]) => ({ sessionId: sid, status: r.status, isTest: false, startedAt: "2026-09-03T10:00:00Z", completedAt: "2026-09-03T10:05:00Z", durationSec: 300, flags: [], vars: { S1: "y" }, quality: r.quality ? { classification: r.quality.classification, qualityScore: r.quality.qualityScore, riskScore: r.quality.riskScore, flags: r.quality.flags.length } : null, review: r.review }));
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "1.0", columns: ["S1", "Q1", "Q2_r1", "Q3"], rows, dataset: ds.startsWith("custom") ? "custom" : ds, total: Object.keys(rowsDb).length, included: rows.length }) });
});

// the sandbox has no surveyDbId → these fetches hit /api/surveys/sandbox/... and are intercepted
await h.goTab("Data");
await page.waitForSelector('[data-testid="data-view-quality"]');
assert.ok(await page.$('[data-testid="export-xlsx"]'), "an XLSX (data + quality) export is offered");
assert.ok(await page.$('[data-testid="dataset-select"]'), "the dataset selector is on the Responses view");
// quality columns appear on the responses table
await page.waitForSelector("table.grid th:has-text('Risk')");
await page.click('[data-testid="data-view-quality"]');
await page.waitForSelector('[data-testid="quality-panel"]');
assert.equal(await page.textContent('[data-testid="q-total"]'), "6");
// the settings in effect are stated from the persisted configuration, with their source
assert.match(await page.textContent('[data-testid="q-config-enabled"]'), /enabled/);
assert.match(await page.textContent('[data-testid="q-config-strictness"]'), /standard strictness/);
assert.match(await page.textContent('[data-testid="q-config-rules"]'), /52 of 64 rules on · 2 customised/);
assert.match(await page.textContent('[data-testid="q-config-custom"]'), /1 custom rule/);
assert.match(await page.textContent('[data-testid="q-config-bands"]'), /20 \/ 40 \/ 60 \/ 80/);
assert.match(await page.textContent('[data-testid="q-config-source"]'), /autosaved draft \(rev 120\)/);
assert.match(await page.textContent('[data-testid="q-config-source"]'), /Live link runs v1\.2: quality checks off/);
assert.equal(await page.getAttribute('[data-testid="q-config"]', "data-config-hash"), CONFIG_HASH);
// one response was assessed under other settings: it is marked, counted, and re-assessable
assert.equal((await page.$$('[data-testid="q-row-stale"]')).length, 1, "the row assessed with older settings is marked");
assert.match(await page.textContent('[data-testid="q-config-stale"]'), /Re-assess 1 scored with older settings/);
assert.ok(!(await page.$('[data-testid="q-live-gap"]')), "the live-link gap is not shown over TEST data");
await page.click('[data-testid="quality-panel"] >> xpath=ancestor::*[contains(@class,"data") or self::div][1] >> text=Live data').catch(() => page.click("text=Live data"));
await page.waitForSelector('[data-testid="q-live-gap"]');
assert.match(await page.textContent('[data-testid="q-live-gap"]'), /published version's settings \(v1\.2\)/, "the live-link settings gap is called out over LIVE data");
await page.click("text=Test data");
await page.waitForSelector('[data-testid="q-total"]');
assert.equal(await page.textContent('[data-testid="q-class-CLEAN"] div:nth-child(2)'), "2");
assert.equal(await page.textContent('[data-testid="q-class-HIGHLY_SUSPICIOUS"] div:nth-child(2)'), "1");
assert.equal(await page.textContent('[data-testid="q-class-UNSCORED"] div:nth-child(2)'), "1");
assert.match(await page.textContent('[data-testid="q-signal-duplicate"]'), /Duplicates 2/);
assert.match(await page.textContent('[data-testid="q-signal-device"]'), /Device 3/);
assert.match(await page.textContent('[data-testid="q-review-KEEP"]'), /keep 1/);
assert.equal((await page.$$('[data-testid="q-cluster"]')).length, 1, "the coordinated cluster is listed");
assert.equal((await page.$$('[data-testid="q-row"]')).length, 6);
// sorted by risk: the worst first
assert.match(await page.textContent('[data-testid="q-row"] >> nth=0'), /10482aaa/);
// filter by signal
await page.click('[data-testid="q-signal-duplicate"]');
assert.equal((await page.$$('[data-testid="q-row"]')).length, 2);
await page.click('[data-testid="q-cluster"]');
assert.equal((await page.$$('[data-testid="q-row"]')).length, 2, "filters combine (duplicate signal ∩ cluster)");
await page.click('[data-testid="q-signal-duplicate"]');
assert.equal((await page.$$('[data-testid="q-row"]')).length, 3, "cluster alone: its three members");
await page.click("text=clear filters");
console.log("✔ Quality dashboard: totals by classification, signal chips, decisions, cluster chips, combinable filters, worst-first ordering");

// review drawer
await page.click('[data-testid="q-row"] >> nth=0');
await page.waitForSelector('[data-testid="review-drawer"]');
assert.match(await page.textContent('[data-testid="review-scores"]'), /38\/100/);
assert.match(await page.textContent('[data-testid="review-scores"]'), /81\/100/);
assert.match(await page.textContent('[data-testid="review-scores"]'), /HIGHLY SUSPICIOUS/);
assert.match(await page.textContent('[data-testid="review-scores"]'), /LIKELY EXCLUDE/);
const flags = await page.$$('[data-testid="review-flag"]');
assert.equal(flags.length, 6);
const first = await flags[0].textContent();
assert.match(first, /Overall speeding/);
assert.match(first, /What happened:\s*3:14/);
assert.match(first, /expected\s*≥ 8:24/);
assert.match(first, /72% below the benchmark/);
assert.match(first, /\+35 risk · −30 quality/);
const dup = await page.textContent('[data-testid="review-flag"]:has-text("Near-identical")');
assert.match(dup, /Related respondents: 10476aaa/);
assert.match(await page.textContent('[data-testid="review-groups"]'), /Timing: 35 risk · 1 flag/);
assert.match(await page.textContent('[data-testid="review-groups"]'), /Open-end quality: 25 risk/);
await page.click('[data-testid="review-drawer"] button:has-text("Telemetry")');
assert.match(await page.textContent('[data-testid="review-telemetry"]'), /1 pastes \(41 chars\) — contents never stored/);
assert.match(await page.textContent('[data-testid="review-telemetry"]'), /p1> p2> p1< p2> p3>/);
console.log("✔ Respondent review: both scores, classification, recommendation, every flag with observed / expected / severity / points / explanation / related respondents, signal groups, telemetry summary");

// decisions
await page.fill('[data-testid="review-reason"]', "Duplicate of 10476, straight-lined, failed check");
await page.click('[data-testid="review-remove"]');
await page.waitForSelector('[data-testid="review-current"]:has-text("REMOVE")');
assert.equal(patches.length, 1);
assert.equal(patches[0].decision, "REMOVE");
assert.equal(patches[0].reason, "Duplicate of 10476, straight-lined, failed check");
await page.click('[data-testid="review-drawer"] button:has-text("History")');
assert.match(await page.textContent('[data-testid="review-history"]'), /REMOVE/);
await page.click('[data-testid="review-clear"]');
await page.waitForFunction(() => !document.querySelector('[data-testid="review-current"]'));
assert.equal(patches[1].decision, "CLEAR", "a decision can be reversed — nothing was deleted");
await page.click('[data-testid="review-remove"]');
await page.waitForSelector('[data-testid="review-current"]:has-text("REMOVE")');
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-testid="review-drawer"]'));
await page.waitForSelector('[data-testid="q-review-REMOVE"]:has-text("remove 1")');
console.log("✔ KEEP / REMOVE / REVIEW LATER: stored with a reason, listed in the audit history, reversible; the dashboard reflects it");

// dataset selector drives the responses table and export links
await page.click('[data-testid="data-view-responses"]');
await page.waitForSelector('[data-testid="dataset-select"]');
await page.selectOption('[data-testid="dataset-select"]', "clean");
await page.waitForSelector('[data-testid="dataset-count"]');
assert.match(await page.textContent('[data-testid="dataset-count"]'), /3 of 6/, "clean = KEEP + unreviewed CLEAN (the removed one is out; screened unscored counts as clean)");
assert.ok(dataRequests.some((q) => q.includes("dataset=clean")), "the dataset filter is sent to the server");
const csv = await page.getAttribute('[data-testid="export-csv"]', "href");
const xlsx = await page.getAttribute('[data-testid="export-xlsx"]', "href");
assert.match(csv, /dataset=clean/); assert.match(csv, /quality=1/);
assert.match(xlsx, /format=xlsx/); assert.match(xlsx, /dataset=clean/);
await page.selectOption('[data-testid="dataset-select"]', "custom");
await page.waitForFunction(() => document.querySelector('[data-testid="dataset-count"]')?.textContent?.includes("of 6"));
assert.match(await page.getAttribute('[data-testid="export-csv"]', "href"), /dataset=custom%3ASUSPICIOUS%2CHIGHLY_SUSPICIOUS%2CCRITICAL/);
assert.match(await page.textContent('[data-testid="dataset-count"]'), /4 of 6/, "custom: exclude SUSPICIOUS+ and REMOVED → CLEAN×2, REVIEW, unscored");
console.log("✔ dataset selector (all / clean / custom) filters the table and the CSV + XLSX export links — the clean dataset is the hand-off to analysis");

await h.close();
console.log("\nALL RESPONSE QUALITY CHECKS PASSED");
