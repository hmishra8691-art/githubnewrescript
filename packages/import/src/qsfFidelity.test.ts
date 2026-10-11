import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SurveyDefinition, Question } from "@rescript/schema";
import { analyzeImport, verifyImport, verifyRuntime, walkSurvey, answerFor, neverShown } from "./index.js";
import { readQsf, qsfPiping, unconvertedPiping, imageUrls } from "./adapters/qsf.js";
import { mapCanonical } from "./map.js";
import { buildReport } from "./report.js";
import { detectFormat } from "./detect.js";

/**
 * THE QSF FIDELITY CORPUS, feature by feature (QSF brief, Phases 2–5). Each
 * test names one thing the source carries and checks that the imported
 * survey carries it too — or, where Rescript cannot, that the report says
 * so in the inventory. The corpus files are real QSF JSON in
 * packages/import/corpus/qsf (see scripts/qsf-corpus-build.mjs).
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "qsf");
const bytes = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const load = async (f: string) => { const a = await analyzeImport(bytes(f), f, { surveyId: "s1", uid }); assert.ok(a.result?.def, `${f} imported`); return { ...a, def: a.result!.def!, m: a.result!, rep: a.report!, c: a.canonical! }; };
const q = (def: SurveyDefinition, id: string): Question => { const x = def.questions.find((y) => y.id === id); assert.ok(x, `${id} exists`); return x!; };
const item = (a: Awaited<ReturnType<typeof load>>, feature: string, sourceId: string) => a.m.inventory.find((i) => i.feature === feature && i.sourceId === sourceId);

test("corpus: every file is detected as a QSF, imports, passes the schema and the quality check", async () => {
  for (const f of ["01-simple-satisfaction.qsf", "02-screener-logic-quotas.qsf", "03-brand-tracker-complex.qsf"]) {
    const d = detectFormat(bytes(f), f);
    assert.equal(d.format, "qsf", f);
    const a = await load(f);
    assert.equal(a.m.quality?.errors.length, 0, `${f}: ${a.m.quality?.errors.join("; ")}`);
    assert.ok(a.rep.fidelity.totals.detected > 0);
    assert.equal(a.rep.fidelity.totals.detected, a.rep.fidelity.totals.imported + a.rep.fidelity.totals.partial + a.rep.fidelity.totals.unsupported, "every item has exactly one outcome");
  }
});

test("the file's table of contents: every element kind is counted, read or not, and an unsupported kind (scoring) is an issue", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const el = Object.fromEntries(a.rep.fidelity.elements.map((e) => [e.type, e]));
  assert.equal(el.SQ.count, 30); assert.equal(el.SQ.handled, "read");
  assert.equal(el.PROJ.handled, "ignored"); assert.equal(el.STAT.handled, "ignored"); assert.equal(el.RS.handled, "ignored");
  assert.equal(el.SC.handled, "unsupported");
  assert.ok(a.m.issues.some((i) => i.location === "SC element" && i.type === "unsupported"));
});

test("a matrix row's display logic belongs to the ROW, not to the column with the same number", async () => {
  const a = await load("02-screener-logic-quotas.qsf");
  const feel = q(a.def, "QID6");
  assert.equal(feel.rows.length, 3);
  const gamma = feel.rows[2] as { visibleIf?: unknown };
  assert.ok(gamma.visibleIf, "row 3 (Gamma) shows only when Gamma was bought");
  assert.deepEqual(gamma.visibleIf, { type: "rule", source: { kind: "question", ref: "QID5" }, operator: "selected", value: 3 });
  assert.ok(!feel.options.some((o) => (o as { visibleIf?: unknown }).visibleIf), "no column hides");
  assert.equal(item(a, "option_logic", "QID6 · row 3")?.status, "imported");
});

test("carry-forward is a first-class carry-forward, not a note", async () => {
  const a = await load("02-screener-logic-quotas.qsf");
  const bought = q(a.def, "QID5") as Question & { carryForward?: { sourceQuestionId: string; filter: string; into: string; keepOwn: boolean } };
  assert.deepEqual(bought.carryForward, { sourceQuestionId: "QID4", filter: "selected", into: "options", keepOwn: true });
  assert.equal(item(a, "carry_forward", "QID5")?.status, "imported");
  /* the same in a grid lands in its rows; a missing source is unresolved, not silent */
  const c = readQsf(JSON.stringify({ SurveyEntry: { SurveyName: "x" }, SurveyElements: [
    { Element: "SQ", PrimaryAttribute: "QID1", Payload: { QuestionID: "QID1", QuestionType: "Matrix", Selector: "Likert", SubSelector: "SingleAnswer", DataExportTag: "g", QuestionText: "g", Choices: { 1: { Display: "a" } }, ChoiceOrder: [1], Answers: { 1: { Display: "x" } }, AnswerOrder: [1], DynamicChoices: { Locator: "q://QID77/SelectedChoices" } } },
    { Element: "BL", Payload: [{ Type: "Default", ID: "B1", BlockElements: [{ Type: "Question", QuestionID: "QID1" }] }] },
    { Element: "FL", Payload: { Type: "Root", Flow: [{ Type: "Block", ID: "B1", FlowID: "F1" }] } },
  ] }), "x.qsf", "fp");
  assert.equal(c.questions[0].carryForward?.into, "rows");
  assert.ok(c.issues.some((i) => i.type === "reference" && /QID77/.test(i.message)));
});

test("choice counts, quota conditions and NOT-met quotas convert — the branch no longer applies to everyone", async () => {
  const a = await load("02-screener-logic-quotas.qsf");
  const bought = q(a.def, "QID5");
  assert.deepEqual(bought.displayLogic, { type: "rule", source: { kind: "expr", ref: "COUNT(aware)" }, operator: "gte", value: 2 });
  const fl6 = (a.def.flow as { id: string; branches?: { when: unknown }[] }[]).find((x) => x.id === "FL_6");
  assert.deepEqual(fl6?.branches?.[0].when, { type: "rule", source: { kind: "quota", ref: "QG_region" }, operator: "gte", value: 200 });
  assert.ok(!a.m.issues.some((i) => /FL_6/.test(i.location) && /applies to everyone/.test(i.message)));
  assert.equal(item(a, "quota_logic", "Flow · branch FL_6")?.status, "partial", "a cell of a group: the condition reads the group's count, and says so");
  assert.ok(a.m.issues.some((i) => /FL_6/.test(i.location) && /group/.test(i.message)));
  /* has NOT been met → below the limit */
  const c = readQsf(JSON.stringify({ SurveyEntry: {}, SurveyElements: [
    { Element: "SQ", PrimaryAttribute: "QID1", Payload: { QuestionID: "QID1", QuestionType: "MC", Selector: "SAVR", DataExportTag: "q1", QuestionText: "q", Choices: { 1: { Display: "a" } }, ChoiceOrder: [1] } },
    { Element: "BL", Payload: [{ Type: "Default", ID: "B1", BlockElements: [{ Type: "Question", QuestionID: "QID1" }] }] },
    { Element: "FL", Payload: { Type: "Root", Flow: [{ Type: "Block", ID: "B1", FlowID: "F1" }, { Type: "Branch", FlowID: "F2", BranchLogic: { 0: { 0: { LogicType: "Quota", QuotaID: "QO_1", Operator: "QuotaNotMet", Type: "Expression", Description: "If Quota Has Not Been Met" }, Type: "If" }, Type: "BooleanExpression" }, Flow: [{ Type: "EndSurvey", FlowID: "F3" }] }] } },
    { Element: "QO", PrimaryAttribute: "QO_1", Payload: { ID: "QO_1", Name: "Q", Occurrences: 10, Logic: { 0: { 0: { LogicType: "Question", QuestionID: "QID1", ChoiceLocator: "q://QID1/SelectableChoice/1", Operator: "Selected", Type: "Expression" }, Type: "If" }, Type: "BooleanExpression" }, LogicType: "Simple", QuotaAction: "EndCurrentSurvey" } },
  ] }), "x.qsf", "fp");
  const m = mapCanonical(c, { surveyId: "s", uid });
  const br = (m.def!.flow as { type: string; branches?: { when: unknown }[] }[]).find((x) => x.type === "branch");
  assert.deepEqual(br?.branches?.[0].when, { type: "rule", source: { kind: "quota", ref: "QO_1" }, operator: "lt", value: 10 });
});

test("advanced randomization: anchors, the subset size and undisplayed choices come across", async () => {
  const a = await load("02-screener-logic-quotas.qsf");
  const aware = q(a.def, "QID4");
  assert.ok(aware.options[0].flags.includes("anchor_top"), "Alpha fixed at the top");
  assert.ok(aware.options[6].flags.includes("anchor_bottom") && aware.options[6].flags.includes("exclusive"), "None fixed at the bottom");
  assert.equal((aware.randomization as { pick?: number }).pick, 4);
  assert.equal((aware.options[5] as { logic?: { visibility?: string } }).logic?.visibility, "always_hide", "Zeta is never shown");
  assert.equal(item(a, "randomization", "QID4")?.status, "partial", "a subset drawn from part of the list is partial, and says why");
});

test("defaults, hidden questions, layout settings and validation details land in settings", async () => {
  const a = await load("02-screener-logic-quotas.qsf");
  assert.equal(q(a.def, "QID3").settings.defaultValue, 20, "the pre-selected choice, by its recode");
  assert.equal(item(a, "default_value", "QID3")?.status, "imported");
  const b = await load("03-brand-tracker-complex.qsf");
  assert.equal(q(b.def, "QID6").settings.headerRepeat, "auto");
  assert.equal(q(b.def, "QID13").settings.fieldLabelPosition, "left");
  assert.equal(q(b.def, "QID11").settings.decimalPlaces, 1);
  assert.equal(q(b.def, "QID11").settings.maxValue, 10);
});

test("a BlockRandomizer is a randomizer of blocks; an Authenticator's children survive it; WebService stays unsupported", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const fl10 = (a.def.flow as { id: string; type: string; show?: number; evenPresentation?: boolean; children?: unknown[] }[]).find((x) => x.id === "FL_10");
  assert.equal(fl10?.type, "randomizer"); assert.equal(fl10?.show, 1); assert.equal(fl10?.evenPresentation, true); assert.equal(fl10?.children?.length, 2);
  assert.equal(item(a, "block_randomizer", "FL_10")?.status, "imported");
  assert.ok(JSON.stringify(a.def.flow).includes("\"BL_intro\""), "the intro block inside the Authenticator is in the flow");
  assert.equal(item(a, "flow_element", "FL_3")?.status, "unsupported");
  assert.equal(item(a, "flow_element", "FL_16")?.note, "WebService");
});

test("side by side becomes a mixed grid with every column and its own answers", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const sbs = q(a.def, "QID18");
  assert.equal(sbs.type, "composite"); assert.equal(sbs.variant, "matrix.mixed");
  assert.equal(sbs.rows.length, 2); assert.equal(sbs.columns.length, 2);
  assert.equal(sbs.columns[0].label, "Quality"); assert.equal(sbs.columns[0].responseType, "single"); assert.equal(sbs.columns[0].options.length, 2);
  assert.equal(sbs.columns[1].variableStem, "sbs_2");
  assert.ok(a.m.mapping.some((e) => e.kind === "variable" && e.source === "sbs#1" && e.rescript === "sbs_1"), "the data-column rename is recorded");
  assert.ok(!a.m.issues.some((i) => /side-by-side/.test(i.message) && i.severity === "high"), "no longer a high risk");
});

test("signature, pick-group-rank, bipolar and profile matrices have homes; a captcha does not", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  assert.equal(q(a.def, "QID22").variant, "upload.signature");
  const pgr = q(a.def, "QID19");
  assert.equal(pgr.variant, "dragdrop.buckets"); assert.equal(pgr.rows.length, 4); assert.deepEqual(pgr.options.map((o) => o.label), ["Alpha", "Beta"]);
  assert.equal(q(a.def, "QID17").variant, "matrix.semantic");
  assert.equal(q(a.def, "QID6").variant, "matrix.likert");
  assert.ok(q(a.def, "QID28").text.includes("Not migrated"));
  assert.equal(item(a, "question", "QID28")?.status, "unsupported");
});

test("images: a choice that is a picture becomes an option with imageUrl; every asset is listed with where it is hosted", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const pack = q(a.def, "QID23");
  assert.equal((pack.options[0] as { imageUrl?: string }).imageUrl, "https://brand.example.com/pack-a.jpg");
  assert.equal(pack.options[0].label, "Pack A", "the alt text is the label");
  assert.equal(pack.options[2].label, "Neither");
  const risks = Object.fromEntries(a.rep.fidelity.assets.map((x) => [x.location, x.risk]));
  assert.equal(risks["QID23 · option 1"], "ok"); assert.equal(risks["QID23 · option 2"], "platform_hosted"); assert.equal(risks["QID24"], "no_url"); assert.equal(risks["QID1"], "ok");
  assert.ok(q(a.def, "QID24").text.includes("IM_shelf02"), "a library-only graphic leaves a visible placeholder");
  assert.ok(a.rep.summary.some((s) => /hosted by Qualtrics|library id/.test(s)));
  assert.deepEqual(imageUrls('<p><img src="a.png"><img alt="x" src=\'b.png\' /></p>'), ["a.png", "b.png"]);
});

test("translations come in keyed to the Rescript question and its codes, through the engine's writer, for review", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const loc = a.def.localization!;
  assert.equal(loc.sourceLanguage, "en");
  assert.deepEqual(loc.languages.map((l) => `${l.code}:${l.status}`), ["es:in_review", "fr:in_review"]);
  assert.equal(loc.translations.es["q:QID2:text"].text, "¿En qué país está?");
  assert.equal(loc.translations.es["q:QID2:text"].origin, "import");
  assert.equal(loc.translations.fr["q:QID3:opt:9"].text, "Aucune", "a translated choice follows its recode");
  assert.equal(loc.translations.es["q:QID3:opt:2"].text, "Beta");
  assert.ok(loc.translations.es["q:QID2:text"].sourceHash, "hashed against the source text, so an edit marks it outdated");
  assert.deepEqual(a.rep.fidelity.languages, [{ code: "es", strings: 11 }, { code: "fr", strings: 11 }]);
  assert.equal(a.m.inventory.filter((i) => i.feature === "translation" && i.status === "imported").length, 22);
});

test("piping: counts, choice wording and question text convert; what cannot is reported, never silently left", async () => {
  assert.equal(qsfPiping("${q://QID4/ChoiceGroup/SelectedChoicesCount} ${q://QID3/ChoiceDescription/1} ${q://QID2/QuestionText} ${q://QID1/ChoiceGroup/DisplayedChoices}"), "{{@QID4.count}} {{@QID3.option.1}} {{@QID2.text}} {{@QID1.displayed}}");
  assert.deepEqual(unconvertedPiping("a ${rand://int/1:10} b ${date://CurrentDate/DS} ${rand://int/1:10}"), ["${rand://int/1:10}", "${date://CurrentDate/DS}"]);
  const a = await load("03-brand-tracker-complex.qsf");
  const assoc = q(a.def, "QID5");
  assert.ok(assoc.text.includes("{{main}}"), assoc.text);
  assert.ok(assoc.text.includes("Alpha is one example"), "the choice's wording is written in");
  assert.ok(assoc.text.includes("{{ed.country}}"));
  assert.ok(assoc.text.includes("${date://CurrentDate/DS}"), "left as written…");
  assert.equal(item(a, "piping", "QID5 ${date://CurrentDate/DS}")?.status, "unsupported", "…and reported");
  assert.ok(a.m.issues.some((i) => i.location === "QID5 · piping" && /date:\/\//.test(i.message)));
  const b = await load("02-screener-logic-quotas.qsf");
  assert.ok(q(b.def, "QID7").text.includes("{{aware.count}}"));
  /* an embedded field set from a Qualtrics-only pipe is fixed text, and partial */
  const cell = (a.def.flow as { type: string; fields?: { name: string; source: string; value?: string }[] }[]).find((x) => x.type === "embedded_data")?.fields?.find((f) => f.name === "cell");
  assert.equal(cell?.source, "static");
  assert.equal(item(a, "embedded", "cell")?.status, "partial");
});

test("unresolved references are listed as such: a trashed question in display logic, a skip to a missing question", async () => {
  const a = await load("02-screener-logic-quotas.qsf");
  const u = a.rep.fidelity.unresolved.map((x) => `${x.kind}:${x.ref}`).sort();
  assert.deepEqual(u, ["question:QID42", "question:QID99"]);
  assert.ok(a.rep.summary.some((s) => /2 references point/.test(s)));
  assert.equal(item(a, "display_logic", "QID11")?.status, "unsupported");
  assert.ok(a.m.inventory.some((i) => i.feature === "skip_logic" && i.sourceId === "QID10" && i.status === "unsupported" && i.note === "destination missing"), "the skip to QID42");
  assert.equal(a.m.inventory.filter((i) => i.feature === "skip_logic" && i.status === "imported").length, 2, "the other skips came in");
});

test("survey options: back button, progress bar and button labels reach branding; the rest is listed as unsupported", async () => {
  const a = await load("01-simple-satisfaction.qsf");
  assert.equal(a.def.branding.buttons.showBack, false);
  assert.equal(a.def.branding.layout.progressBar, "none");
  assert.equal(a.def.branding.buttons.nextLabel, "→");
  assert.equal(item(a, "survey_option", "SaveAndContinue")?.status, "unsupported");
  const b = await load("02-screener-logic-quotas.qsf");
  assert.equal(b.def.branding.buttons.showBack, true);
  assert.equal(b.def.branding.layout.progressStyle, "percent");
  const c = await load("03-brand-tracker-complex.qsf");
  assert.equal(c.def.branding.buttons.nextLabel, "Continue");
});

test("the end-of-survey library message is not written where a sentence belongs", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const ends = (a.def.flow as { type: string; message?: string }[]).filter((x) => x.type === "end");
  assert.ok(ends.length >= 1 && ends.every((e) => !e.message), JSON.stringify(ends));
  assert.ok(a.c.flow.every((f) => f.t !== "end" || !f.message));
  assert.ok(a.m.issues.some((i) => i.type === "dropped" && /EOSM_thanks/.test(i.message)));
  /* a source that DOES carry the words (a Decipher <term>, a document) keeps them on the end */
  const m = mapCanonical({ ...a.c, questions: a.c.questions.slice(0, 2), quotas: [], custom: [], issues: [], inventory: [], flow: [{ t: "block", sourceId: "B", pages: [["QID1", "QID2"]] }, { t: "end", sourceId: "E", status: "screened", message: "Sorry, you do not qualify." }] }, { surveyId: "s", uid });
  assert.equal((m.def!.flow as { type: string; message?: string }[]).find((x) => x.type === "end")?.message, "Sorry, you do not qualify.");
});

test("the fidelity report counts items per feature, with examples and reasons, and the summary states the measured share", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const f = Object.fromEntries(a.rep.fidelity.features.map((x) => [x.feature, x]));
  assert.equal(f.question.detected, 29, "QID1–QID29 — the trashed QID98 is not an element of the survey");
  assert.ok(!a.m.inventory.some((i) => i.sourceId.startsWith("QID98")));
  assert.equal(f.question.unsupported, 1); assert.deepEqual(f.question.examples.unsupported, ["QID28"]);
  assert.ok(f.question.partial >= 5 && f.question.reasons.length >= 2);
  assert.equal(f.loop.imported, 2); assert.equal(f.block_randomizer.imported, 1);
  assert.equal(f.custom_js.unsupported, 2);
  assert.equal(f.translation.imported, 22);
  assert.equal(f.asset.detected, 4);
  assert.match(a.rep.summary.join(" "), /Of \d+ source elements checked, \d+ came across as they were, \d+ with a change, \d+ could not be reproduced \(\d+(\.\d)?% as-is\)/);
  assert.ok(a.rep.audit.some((l) => /^Fidelity \d+\/\d+ elements as-is/.test(l)));
  assert.equal(a.rep.fidelity.importedPct, Math.round((a.rep.fidelity.totals.imported / a.rep.fidelity.totals.detected) * 1000) / 10);
});

test("structural verification: families, choices, rows, variable names and codes are compared with the source, and a lost one is an error", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  const v = verifyImport(a.c, a.m);
  assert.ok(v.ok, JSON.stringify(v.structure.findings));
  assert.equal(v.structure.findings.filter((f) => f.level === "error").length, 0);
  assert.ok(v.structure.findings.some((f) => f.level === "warning" && f.sourceId === "QO_geo"), "the quota whose condition could not convert is a warning, not silence");
  assert.equal(v.analysis.variablesRenamed.length, 0);
  assert.ok(v.analysis.variablesKept >= 29 && v.analysis.codesKept >= 40 && v.analysis.rowsKept >= 20);
  /* break the result: change a code — the count is the same, so only the per-code check can notice */
  const broken = structuredClone(a.m);
  const none = broken.def!.questions.find((x) => x.id === "QID3")!.options.find((o) => o.code === 9)!; none.code = 5;
  const v2 = verifyImport(a.c, broken);
  assert.ok(!v2.ok);
  assert.ok(v2.structure.findings.some((f) => f.level === "error" && f.sourceId === "QID3" && /choice 5 \(code 9\) has no option here/.test(f.message)), JSON.stringify(v2.structure.findings));
  /* …and dropping one is noticed by the count */
  const fewer = structuredClone(a.m); fewer.def!.questions.find((x) => x.id === "QID3")!.options.pop();
  assert.ok(verifyImport(a.c, fewer).structure.findings.some((f) => /5 choices in the source and 4 here/.test(f.message)));
  /* rename a variable without a record — also an error */
  const renamed = structuredClone(a.m);
  renamed.def!.questions.find((x) => x.id === "QID2")!.variableName = "country_x";
  assert.ok(verifyImport(a.c, renamed).structure.findings.some((f) => f.sourceId === "QID2" && /rename was not recorded/.test(f.message)));
});

test("runtime verification: the engine walks every corpus survey to an end; a screener's gate is passed by the deepest walk; unreachable has a reason", async () => {
  const s = await load("02-screener-logic-quotas.qsf");
  const r = verifyRuntime(s.def);
  assert.equal(r.errors.length, 0);
  assert.equal(r.reached, r.placed, `unreachable: ${r.unreachable.map((u) => u.code).join(",")}`);
  assert.ok(r.endStatuses.includes("complete") && r.endStatuses.includes("screened"), r.endStatuses.join(","));
  const deepest = r.walks.find((w) => w.strategy === "deepest")!;
  assert.equal(deepest.end, "complete");
  assert.ok(deepest.pages >= 5);
  assert.equal(r.unanswerable.length, 0, JSON.stringify(r.unanswerable));
  const c = await load("03-brand-tracker-complex.qsf");
  const rc = verifyRuntime(c.def);
  assert.equal(rc.errors.length, 0);
  assert.deepEqual(rc.unreachable, [{ id: "QID29", code: "orphan", reason: "by_source" }], "the block outside the Qualtrics flow is unreachable by design, and only that");
  assert.ok(rc.walks.every((w) => w.loops >= 4), "both loops ran");
  assert.ok(neverShown(c.def).has("QID29"));
  /* a required question nobody can answer is reported as unanswerable, not hidden in a thrown error */
  const bad = structuredClone(c.def);
  const photo = bad.questions.find((x) => x.id === "QID21")!; photo.required = true;
  const rb = verifyRuntime(bad);
  assert.ok(rb.unanswerable.some((u) => u.code === "photo"), JSON.stringify(rb.unanswerable));
});

test("the walker's answers satisfy the engine's own validation for every type the corpus holds", async () => {
  const a = await load("03-brand-tracker-complex.qsf");
  for (const strategy of ["first", "last", "random", "deepest"] as const) {
    const w = walkSurvey(a.def, strategy, 7);
    assert.equal(w.error, null); assert.deepEqual(w.refusals, [], `${strategy}: ${JSON.stringify(w.refusals)}`);
  }
  const rnd = () => 0.5;
  const sbs = q(a.def, "QID18");
  const v = answerFor(sbs, "first", rnd) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(v), ["1", "2"]); assert.equal(v["1"][sbs.columns[0].id], 1);
  assert.equal(answerFor(q(a.def, "QID21"), "first", rnd), undefined, "an upload is not answered by the walker");
});

test("the report is built from the same facts the mapper produced — no second count", async () => {
  const a = await load("01-simple-satisfaction.qsf");
  const rep = buildReport(a.detection, a.c, a.m, "full");
  assert.deepEqual(rep.fidelity.totals, a.rep.fidelity.totals);
  assert.equal(rep.fidelity.features.find((f) => f.feature === "question")?.imported, 6);
  assert.equal(rep.fidelity.features.find((f) => f.feature === "validation")?.imported, 4);
});
