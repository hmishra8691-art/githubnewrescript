import { test } from "node:test";
import assert from "node:assert/strict";
import { PortalSettings, SurveyDefinition } from "@rescript/schema";
import { PORTAL_TEMPLATES, STANDARD_WORDS, applyPortalTemplate, enforcePortalTemplate, portalPresentation, portalTemplate, templateRules } from "./portalTemplates.js";
import { editWindow, portalSettings } from "./portalPolicy.js";

const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

test("twenty templates, six of them the industry portals offered first; every id unique and usable as a setting", () => {
  assert.equal(PORTAL_TEMPLATES.length, 20);
  assert.equal(new Set(PORTAL_TEMPLATES.map((t) => t.id)).size, 20);
  assert.equal(new Set(PORTAL_TEMPLATES.map((t) => t.name)).size, 20);
  assert.deepEqual(PORTAL_TEMPLATES.filter((t) => t.featured).map((t) => t.id).sort(), ["customer_satisfaction", "employee_engagement", "patient_outcomes", "student_assessment", "tracking_panel", "training_certification"]);
  for (const t of PORTAL_TEMPLATES) {
    assert.match(t.id, /^[a-z0-9_]{3,60}$/, t.id);
    assert.ok(t.summary.length > 40 && t.summary.length < 320, `${t.id}: a summary a researcher can choose by`);
    for (const w of Object.values(t.words)) assert.ok(w.trim().length > 1 && w.length <= 40, `${t.id}: ${w}`);
    assert.equal(t.words.one, t.words.one.toLowerCase().replace(/^\w/, (c) => c), `${t.id}: the noun is written as it sits inside a sentence`);
  }
});

test("every template is valid configuration of the ONE engine: it parses as portal settings and starts with the careful floor", () => {
  for (const t of PORTAL_TEMPLATES) {
    const applied = applyPortalTemplate(undefined, t.id)!;
    assert.deepEqual(PortalSettings.parse(applied), applied, `${t.id} parses unchanged`);
    assert.equal(applied.template, t.id); assert.equal(applied.enabled, true);
    assert.ok(applied.benchmark.minCohort >= 10, `${t.id}: never under ten`);
    assert.equal(applied.benchmark.enabled, applied.show.comparison, `${t.id}: the comparison's two switches agree`);
    if (applied.show.comparison || applied.show.trends || applied.show.bands === false) assert.ok(applied.show.scores || !applied.show.comparison, `${t.id}: nothing depends on scores that are off`);
    if (applied.editing.mode === "window") assert.ok((applied.editing.windowHours ?? 0) > 0, `${t.id}: a window has a length`);
    /* a template's defaults never contradict its own fixed rules */
    assert.deepEqual(enforcePortalTemplate(applied), applied, `${t.id}: its defaults already obey its rules`);
  }
});

test("the pages stay readable: white text on every accent meets the contrast for normal text (4.5:1)", () => {
  for (const t of PORTAL_TEMPLATES) {
    assert.match(t.accent, /^#[0-9a-f]{6}$/);
    assert.ok(contrast(t.accent, "#ffffff") >= 4.5, `${t.id}: ${t.accent} is ${contrast(t.accent, "#ffffff").toFixed(2)}:1`);
  }
});

test("health templates say what the scores are not, and compare only in larger groups", () => {
  for (const t of PORTAL_TEMPLATES.filter((x) => x.sector === "health")) {
    assert.match(t.note!, /not a diagnosis/); assert.match(t.note!, /health professional/);
    assert.ok((t.enforce.minCohort ?? 0) >= 20, t.id);
    assert.equal(t.defaults.show.comparison, false, `${t.id}: comparison is off until the researcher turns it on`);
  }
  for (const t of PORTAL_TEMPLATES) assert.ok(!/\b(patient|clinical|hipaa)\b/i.test(`${Object.values(t.words).join(" ")} ${t.note ?? ""}`), `${t.id}: nothing shown to a respondent labels them`);
});

const def = (portal: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T", version: "1", schemaVersion: 1, status: "live" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Q" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  portal: { enabled: true, ...portal },
});

test("a template's fixed rules hold wherever the settings are read, whatever the researcher saved afterwards", () => {
  /* a candidate assessment with everything switched on by hand */
  const loose = def({ template: "candidate_assessment", show: { answers: true, history: true, scores: true, comparison: true }, editing: { mode: "until_locked" }, benchmark: { enabled: true } });
  const inForce = portalSettings(loose)!;
  assert.deepEqual([inForce.show.answers, inForce.show.history, inForce.show.comparison, inForce.benchmark.enabled, inForce.editing.mode], [false, false, false, false, "none"]);
  assert.equal(inForce.show.scores, true, "what the template does not fix stays the researcher's");
  assert.equal(loose.portal!.show.answers, true, "the saved settings are not rewritten");
  const w = editWindow(loose, { status: "complete", completedAt: new Date().toISOString() }, { lockedAt: null, reopenedUntil: null }, Date.now());
  assert.equal(!w.allowed && w.code, "editing_off", "the edit rule reads the enforced settings");

  /* a health template: the group minimum cannot be brought under twenty; raising it is kept */
  assert.equal(portalSettings(def({ template: "patient_outcomes", benchmark: { enabled: true, minCohort: 10 } }))!.benchmark.minCohort, 20);
  assert.equal(portalSettings(def({ template: "patient_outcomes", benchmark: { enabled: true, minCohort: 50 } }))!.benchmark.minCohort, 50);
  assert.equal(portalSettings(def({ template: "community_survey" }))!.benchmark.minCohort, 30);
});

test("no template, an unknown template, a portal that is off: nothing changes", () => {
  const plain = def({ show: { answers: true }, editing: { mode: "until_locked" } });
  assert.equal(portalSettings(plain), plain.portal, "the very same object: surveys made before templates behave exactly as before");
  const unknown = def({ template: "made_up", show: { comparison: true } });
  assert.equal(portalSettings(unknown), unknown.portal);
  assert.equal(portalSettings(def({ enabled: false, template: "candidate_assessment" })), null);
  assert.equal(portalTemplate("made_up"), null); assert.equal(applyPortalTemplate(undefined, "made_up"), null);
  assert.deepEqual(portalPresentation(plain.portal).words, STANDARD_WORDS); assert.equal(portalPresentation(null).template, null);
});

test("applying a template keeps what the researcher built — scores, groups, series, locked questions — and sets the switches", () => {
  const built = PortalSettings.parse({
    enabled: true, show: { answers: true }, maxAttempts: 9,
    scorecard: { dimensions: [{ id: "energy", label: "Energy", source: { kind: "variable", name: "E" }, min: 0, max: 10 }] },
    benchmark: { enabled: true, minCohort: 12, groups: [{ id: "dept", label: "Department", source: { kind: "embedded", ref: "dept" } }] },
    series: { id: "w", label: "Wellbeing", period: "2026" }, editing: { mode: "until_locked", lockedQuestions: ["q1"] },
  });
  const next = applyPortalTemplate(built, "wellbeing_checkin")!;
  assert.deepEqual(next.scorecard, built.scorecard); assert.deepEqual(next.benchmark.groups, built.benchmark.groups);
  assert.deepEqual(next.series, { id: "w", label: "Wellbeing", period: "2026", repeatEveryDays: 14 });
  assert.deepEqual(next.editing.lockedQuestions, ["q1"]); assert.equal(next.editing.mode, "none");
  assert.deepEqual([next.show.answers, next.show.scores, next.show.trends, next.show.comparison, next.benchmark.enabled, next.benchmark.minCohort], [false, true, true, false, false, 20]);
  assert.equal("maxAttempts" in next, false, "the template has no limit of its own, so the survey's rule applies");
  assert.equal(built.show.answers, true, "the input is not changed");
  assert.equal(applyPortalTemplate(built, "training_certification")!.maxAttempts, 3);
});

test("presentation and the rules in words", () => {
  const p = portalPresentation({ template: "patient_outcomes" });
  assert.deepEqual([p.words.one, p.words.organiser, p.words.results, p.accent], ["questionnaire", "your care team", "My scores", "#0f766e"]);
  assert.deepEqual(templateRules(portalTemplate("candidate_assessment")!), ["Respondents are never compared with other people.", "Submitted answers can never be changed.", "Submitted answers are never shown back."]);
  assert.deepEqual(templateRules(portalTemplate("patient_outcomes")!), ["A comparison is never shown for fewer than 20 people."]);
  assert.deepEqual(templateRules(portalTemplate("athlete_tracking")!), []);
});
