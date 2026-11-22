import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, withCarriedCounts, checkQuotas, type QuotaCounts } from "@rescript/engine";
import { analyzeImport, readQuotaSheet, quotaSheetActions, fieldStateOf } from "./index.js";
import { qsfFixture } from "./fixtures.js";

/*
 * I5 — QUOTAS AND TRANSLATIONS, BROUGHT ACROSS AND CHECKED: completes a quota had already reached on the source
 * platform travel with it (from the export or a quota report) and count toward live fullness; each language version
 * is checked string by string against the imported questionnaire.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus", "qsf");
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const importQsf = async (qsf: unknown, name = "study.qsf") => { const a = await analyzeImport(enc(qsf), name, { surveyId: "s1", uid }); assert.ok(a.result?.def, "imported"); return { def: a.result!.def!, rep: a.report! }; };

test("a Qualtrics quota exported mid-field brings its count: carried over, full when it reached the target, live only", async () => {
  const qsf = qsfFixture() as { SurveyElements: { Element: string; Payload: Record<string, unknown> }[] };
  const qo = qsf.SurveyElements.find((e) => e.Element === "QO")!;
  qo.Payload.Count = 100; // target 100, already 100 there
  const { def, rep } = await importQsf(qsf);
  const quota = def.quotas.find((q) => q.name === "North region")!;
  assert.deepEqual(quota.cells[0].carried, { count: 100, source: "Qualtrics export (study.qsf)" });
  assert.equal(rep.fieldState!.quotas[0].carried, 100);
  assert.deepEqual(rep.fieldState!.quotas[0].full, [{ label: "North region", carried: 100, maximum: 100 }]);
  assert.ok(rep.summary.some((s) => /100 completes carried over from the source into 1 quota.*Already full: North region · North region/.test(s)), rep.summary.join(" | "));

  /* the runtime's decision: live counters + carried → full; the test counters never see it */
  const north = def.questions.find((q) => q.variableName.toLowerCase() === "region")!;
  const state = { answers: { [north.id]: north.options[0].code }, flags: [] as string[], embedded: {}, loopStack: [] } as never;
  const empty: QuotaCounts = {};
  assert.deepEqual(checkQuotas(def, state, withCarriedCounts(def, empty)), [quota.id], "live: full from the carried-over completes");
  assert.deepEqual(checkQuotas(def, state, empty), [], "test counters: not full");
  assert.deepEqual(empty, {}, "the counters passed in are not changed");
});

test("an export without counts says so, and what to send", async () => {
  const { def, rep } = await importQsf(qsfFixture());
  assert.equal(def.quotas[0].cells[0].carried, undefined);
  assert.match(rep.fieldState!.quotaCountsNote!, /carried no quota counts.*send its quota report/);
  /* a Count that is the only number (no Occurrences) is the target, never completes */
  const old = qsfFixture() as { SurveyElements: { Element: string; Payload: Record<string, unknown> }[] };
  const qo = old.SurveyElements.find((e) => e.Element === "QO")!;
  delete qo.Payload.Occurrences; qo.Payload.Count = 80;
  const r2 = await importQsf(old);
  assert.equal(r2.def.quotas[0].cells[0].limit, 80);
  assert.equal(r2.def.quotas[0].cells[0].carried, undefined);
});

test("a quota report for quotas that came across with the questionnaire puts the counts on their cells; targets are not overwritten", async () => {
  const { def } = await importQsf(qsfFixture());
  const sheet = readQuotaSheet([{ name: "Quotas", rows: [["Quota", "Cell", "Target", "Achieved"], ["North region", "North region", "120", "37"]] }]);
  assert.equal(sheet.quotas[0].cells[0].achieved, 37);
  const m = quotaSheetActions(def, sheet, { sourceName: "quota-report.xlsx" });
  assert.deepEqual(m.actions, [{ op: "update_quota", quota: def.quotas[0].id, cells: [{ cell: def.quotas[0].cells[0].id, carried: 37, carriedSource: "quota report (quota-report.xlsx)" }] }]);
  assert.ok(m.issues.some((i) => /target of 120; the survey's maximum is 100\. The survey's maximum was kept/.test(i)));
  const gate = coerceSurveyActions(m.actions);
  assert.deepEqual(gate.rejected, []);
  const out = applySurveyActions(def, gate.actions);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.def.quotas[0].cells[0].carried, { count: 37, source: "quota report (quota-report.xlsx)" });
  assert.equal(out.def.quotas[0].cells[0].limit, 100);
  assert.match(out.results[0].description, /37 completes carried over \(quota report \(quota-report\.xlsx\)\)/);
});

test("a new quota from a sheet with an Achieved column: created with its counts; a count that is not a whole number is reported, not guessed", async () => {
  const { def } = await importQsf(qsfFixture());
  const sheet = readQuotaSheet([{ name: "Region", rows: [["Region", "Target", "Completes so far"], ["North", "60", "12"], ["South", "40", "4.5"]] }]);
  assert.ok(sheet.issues.some((i) => /row 3: “4\.5” under “Completes so far” is not a whole number/.test(i)));
  const m = quotaSheetActions(def, sheet, { sourceName: "field.csv" });
  const create = m.actions[0] as { op: string; cells: { label: string; carried?: number; carriedSource?: string }[] };
  assert.equal(create.op, "create_quota");
  assert.deepEqual(create.cells.map((c) => [c.label, c.carried ?? null]), [["North", 12], ["South", null]]);
  const out = applySurveyActions(def, coerceSurveyActions(m.actions).actions);
  assert.deepEqual(out.errors, []);
  const made = out.def.quotas.find((q) => q.name === "Region")!;
  assert.deepEqual(made.cells.map((c) => c.carried?.count ?? 0), [12, 0]);
  assert.equal(made.cells[0].carried!.source, "quota report (field.csv)");
});

test("translations: each language version checked string by string; a broken piping token and a missing option are named", async () => {
  const qsf = JSON.parse(readFileSync(join(DIR, "03-brand-tracker-complex.qsf"), "utf8"));
  const q2 = qsf.SurveyElements.find((e: { Element: string; PrimaryAttribute: string }) => e.Element === "SQ" && e.PrimaryAttribute === "QID2");
  q2.Payload.QuestionText = "Which country are you in, ${e://Field/Name}?";
  q2.Payload.Language.ES.QuestionText = "¿En qué país está?"; // the piped name is gone
  delete q2.Payload.Language.FR.Choices["3"];             // one option untranslated
  const { def, rep } = await importQsf(qsf, "brand.qsf");
  const fs = rep.fieldState!;
  assert.deepEqual(fs.languages.map((l) => l.code), ["es", "fr"]);
  const es = fs.languages[0], fr = fs.languages[1];
  assert.ok(es.total > 20 && es.translated < es.total, `es ${es.translated}/${es.total}`);
  assert.ok(es.invalid.some((i) => i.kind === "corrupted" && /QID2|country/i.test(`${i.label} ${i.message}`)), JSON.stringify(es.invalid));
  assert.ok(fr.missing.some((m) => /QID2|Q2|country/i.test(m) && /opt|option/i.test(m)), JSON.stringify(fr.missing));
  assert.equal(es.complete, false);
  assert.match(fs.languagesNote!, /title, end messages and interface strings are not part of an imported translation/);
  assert.ok(rep.summary.some((s) => /^es: \d+ of \d+ questionnaire strings came across and pass the check .*broken \(corrupted\)/.test(s)), rep.summary.join(" | "));

  /* the same check, called directly, agrees */
  const again = fieldStateOf(SurveyDefinition.parse(def));
  assert.deepEqual(again.languages.map((l) => [l.code, l.translated, l.total]), fs.languages.map((l) => [l.code, l.translated, l.total]));
});
