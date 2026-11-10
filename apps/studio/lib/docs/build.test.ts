import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_EXAMPLES } from "./examples.ts";
import { buildExample } from "./build.ts";

test("every live example builds through the engine with no refused action, schema error or empty survey", () => {
  for (const ex of DOC_EXAMPLES) {
    const b = buildExample(ex.id)!;
    assert.deepEqual(b.errors, [], `${ex.id}: ${b.errors.join(" | ")}`);
    assert.ok(b.def.questions.length >= 1, ex.id);
    assert.ok(b.json.length > 20, ex.id);
    if (ex.builder.question) assert.ok(b.def.questions.some((q) => q.code === ex.builder.question), `${ex.id}: builder question ${ex.builder.question}`);
  }
  assert.equal(new Set(DOC_EXAMPLES.map((e) => e.id)).size, DOC_EXAMPLES.length, "ids are unique");
});

test("the expression view is the engine's: display logic, skips, validation, piping, masks, branches and quotas", () => {
  const txt = (id: string) => buildExample(id)!.logic.map((l) => `${l.label}: ${l.text}`).join("\n");
  assert.match(txt("display-logic"), /Display Q2 if: Q1 = /);
  assert.match(txt("skip-logic"), /After Q1, skip to Q3 if: Q1 = /);
  assert.match(txt("survey-termination"), /terminate \(screened\) if: Q1 < 18/);
  assert.match(txt("validation-rules"), /Q2 is invalid when:/);
  assert.match(txt("piping"), /Piping in Q2: \{\{BRAND\}\}/);
  assert.match(txt("masking"), /Q2 options mask \(display\): Q1\.Unselected/);
  assert.match(txt("branching"), /Branch .* when: Q1 = /);
  assert.match(txt("quotas"), /Quota Gender — Women \(limit 200\)/);
  assert.match(txt("conditional-logic"), /AND/);
});

test("phase 2: sentences are read by the engine and applied; refusals change nothing; designs and simulated output are real", () => {
  const im = buildExample("im-overview")!;
  assert.deepEqual(im.said.map((l) => l.kind), ["actions", "actions", "actions"]);
  assert.ok(im.said[1].applied.join(" ").includes("Q3 shown only when Q2 in [1, 2]"), im.said[1].applied.join(" | "));
  assert.match(im.logic.map((l) => `${l.label}: ${l.text}`).join("\n"), /Display Q3 if: Q2 in \[1, 2\]/);
  const v = buildExample("im-validation")!;
  assert.ok(v.said.every((l) => l.kind === "refused" && l.note && !l.applied.length));
  assert.equal(v.logic.length, buildExample("im-troubleshooting")!.logic.length, "nothing was applied");
  const md = buildExample("maxdiff")!;
  assert.equal(md.designs[0].kind, "maxdiff");
  assert.equal(md.output![0].table!.rows.length, 10);
  assert.equal(md.simulated, 150);
  const pp = buildExample("cbc-partial")!;
  assert.equal((pp.designs[0].file.summary as any).partialProfile.attributesPerTask, 4);
  const vw = buildExample("van-westendorp")!;
  assert.ok(vw.output!.length >= 1 && !vw.output![0].error);
  assert.ok(buildExample("panel-integration")!.json.includes("\"preset\": \"prolific\""));
  assert.ok(buildExample("alerts-webhooks")!.json.includes("response.completed"));
});

test("Developer Docs phase 3: branding examples go through set_theme; translation through the localization actions", () => {
  for (const id of ["theme-preset", "theme-colours", "theme-typography", "theme-page-logo", "theme-answers", "theme-background", "theme-buttons", "theme-experience", "theme-devices", "theme-header-footer", "translation"]) {
    const ex = buildExample(id)!;
    assert.deepEqual(ex.errors, [], id);
  }
  const colours = buildExample("theme-colours")!;
  assert.equal(colours.def.branding.colors.buttonBackground, "#134e4a");
  assert.match(colours.logic.find((l) => l.label.startsWith("Theme"))!.text, /primary colour: #2563eb → #0f766e/);
  assert.deepEqual(JSON.parse(colours.json), { branding: { colors: { primary: "#0f766e", secondary: "#134e4a", background: "#f0fdfa", subtleText: "#475569", border: "#99f6e4", buttonBackground: "#134e4a", progress: "#14b8a6" } } });
  assert.equal(buildExample("theme-devices")!.viewport, "mobile");
  assert.equal(buildExample("theme-experience")!.def.branding.layout.autoAdvance, true);
  assert.equal(buildExample("theme-preset")!.def.branding.appearance?.motif, "peach");
  const tr = buildExample("translation")!;
  assert.equal(Object.keys(tr.def.localization!.translations.fr ?? {}).length, 5);
  assert.ok(JSON.parse(tr.json).localization);
});

test("Developer Docs phase 4: the interviewer, section navigation, gamification and the analysis example", () => {
  for (const id of ["ai-conversational", "section-navigation", "gamification", "analytics-results"]) assert.deepEqual(buildExample(id)!.errors, [], id);
  assert.equal(buildExample("ai-conversational")!.def.branding.aiConversation?.conversation, "conversational");
  assert.equal(buildExample("section-navigation")!.def.navigation?.sectionNav, "visited");
  const g = buildExample("gamification")!.def.gamification!;
  assert.equal(g.points.perAnswer, 10); assert.equal(g.badges.length, 1); assert.equal(g.levels.length, 2);
  const a = buildExample("analytics-results")!;
  assert.equal(a.output?.length, 3);
  assert.ok(a.output!.every((o) => !o.error && o.n === 150), JSON.stringify(a.output!.map((o) => [o.name, o.error])));
  assert.equal(a.output![0].table?.rows[0].m, "NPS");
});
