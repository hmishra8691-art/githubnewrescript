import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portalReportPdf, reportFileName, reportTexts, type ReportInput } from "./report.ts";
import { fmtScore, placeOn, standingText } from "./words.ts";

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  title: "Workplace wellbeing index", person: { name: "Ana Silva", respondentId: "RSP-ANA00001" }, completedAt: "2026-11-19T09:49:00Z", generatedAt: "2026-11-20T10:00:00Z", note: "Scores describe the answers you gave. They are not a diagnosis or professional advice.",
  scores: {
    v: 1, fingerprint: "f", overall: { label: "Wellbeing index", percent: 75 },
    dimensions: [
      { id: "energy", label: "Energy", description: "How much you have left.", score: 9, min: 2, max: 10, percent: 87.5, band: { label: "High", note: "You usually have energy to spare." }, higherIsBetter: true },
      { id: "pressure", label: "Pressure", score: 5, min: 2, max: 10, percent: 37.5, band: { label: "Moderate" }, higherIsBetter: false },
      { id: "sleep", label: "Sleep", score: null, min: null, max: null, percent: null, band: null, higherIsBetter: true, reason: "Not every question of this score was answered." },
    ],
  },
  comparison: [
    { dimension: "energy", note: null, everyone: { n: 23, mean: 5.91, median: 6, below: 81, above: 9 }, groups: [{ grouping: "Team", group: "North", n: 12, mean: 5.92, median: 6, below: 81, above: 8 }] },
    { dimension: "pressure", note: null, everyone: { n: 23, mean: 5.96, median: 6, below: 30, above: 59 }, groups: [] },
    { dimension: "__overall", note: null, everyone: { n: 23, mean: 49.7, median: 50, below: 81, above: 9 }, groups: [] },
  ],
  answers: [{ code: "E1", text: "I have energy for my work.", answer: "4" }, { code: "TEAM", text: "Which team are you in?", answer: "North" }],
  ...over,
});
const read = (pdf: Uint8Array) => {
  const file = join(mkdtempSync(join(tmpdir(), "rescript-report-")), "r.pdf");
  writeFileSync(file, pdf);
  const check = spawnSync("qpdf", ["--check", file], { encoding: "utf8" });
  return { ok: check.status === 0, why: check.stdout + check.stderr, text: spawnSync("pdftotext", ["-enc", "UTF-8", "-layout", file, "-"], { encoding: "utf8" }).stdout.replace(/[ \t]+/g, " ") };
};
const tools = spawnSync("qpdf", ["--version"]).error === undefined && spawnSync("pdftotext", ["-v"]).error === undefined;

test("the words shared by the page and the file", () => {
  assert.deepEqual([9, 4.5, 49.7, 5.916, 12.34].map(fmtScore), ["9", "4.5", "49.7", "5.92", "12.3"]);
  assert.equal(placeOn(6, 2, 10), 50); assert.equal(placeOn(6, null, 10), null); assert.equal(placeOn(60, 2, 10), 100);
  assert.equal(standingText({ n: 23, mean: 1, median: 1, below: 81, above: 9 }, true), "Higher than 81% of 23 people");
  assert.equal(standingText({ n: 23, mean: 1, median: 1, below: 30, above: 59 }, false), "Lower than 59% of 23 people");
  assert.equal(standingText({ n: 12, mean: 1, median: 1, below: 0, above: 0 }, true), "The same as the 12 people compared");
});

test("the report says what the page says: scores, range names, comparisons, the reason for a missing score, answers, the notes", { skip: !tools && "qpdf / pdftotext are not installed" }, () => {
  const { ok, why, text } = read(portalReportPdf(base())!);
  assert.ok(ok, why);
  for (const want of [
    /Workplace wellbeing index/, /Personal report · for Ana Silva · Respondent ID RSP-ANA00001 · Completed 19 November 2026/,
    /Wellbeing index 75 of 100/, /Higher than 81% of 23 people\. Average 49\.7\./,
    /Energy 9 of 10/, /High\. You usually have energy to spare\./, /Everyone: Higher than 81% of 23 people\. Average 5\.91\./, /Team: North\. Higher than 81% of 12 people\. Average 5\.92\./,
    /Pressure 5 of 10/, /Moderate/, /Everyone: Lower than 59% of 23 people/,
    /Sleep/, /Not every question of this score was answered\./,
    /groups of at least ten people/, /not a diagnosis/,
    /My answers/, /E1 I have energy for my work\./, /TEAM Which team are you in\?/, /North/,
    /RSP-ANA00001 · Generated 20 November 2026 · Page 1 of 1/,
  ]) assert.match(text, want);
});

test("only what the person may see goes in: no scores, no comparison, no answers — each is simply absent", { skip: !tools && "qpdf / pdftotext are not installed" }, () => {
  const noCompare = read(portalReportPdf(base({ comparison: null }))!).text;
  assert.ok(!/Everyone:|ten people|Team:/.test(noCompare));
  const answersOnly = read(portalReportPdf(base({ scores: null, comparison: null }))!).text;
  assert.ok(!/My results|Energy 9/.test(answersOnly)); assert.match(answersOnly, /My answers/);
  const test = read(portalReportPdf(base({ note: null, answers: null }))!).text;
  assert.ok(!/not a diagnosis|My answers/.test(test));
  assert.equal(portalReportPdf(base({ scores: null, comparison: null, answers: null })), null, "nothing to show, no file");
  assert.equal(portalReportPdf(base({ scores: null, comparison: null, answers: [] })), null);
});

test("a template's heading and note are the report's", { skip: !tools && "qpdf / pdftotext are not installed" }, () => {
  const { text } = read(portalReportPdf(base({ resultsTitle: "My marks", note: "Your answers are reported to your employer only as part of a group." }))!);
  assert.match(text, /My marks/); assert.ok(!/My results/.test(text));
  assert.match(text, /reported to your employer only as part of a group/); assert.ok(!/not a diagnosis/.test(text));
  assert.equal(portalReportPdf(base({ note: "ध्यान दें" })), null, "a note the file cannot carry: no file");
});

test("a long report runs over pages and stays valid", { skip: !tools && "qpdf / pdftotext are not installed" }, () => {
  const answers = Array.from({ length: 120 }, (_, i) => ({ code: `Q${i + 1}`, text: `Question number ${i + 1}, with a fairly long wording so that it has to be wrapped onto a second line of the page`, answer: `Answer ${i + 1} — “quoted”, café` }));
  const { ok, why, text } = read(portalReportPdf(base({ answers }))!);
  assert.ok(ok, why);
  assert.match(text, /Page 1 of (\d+)/); assert.ok(Number(/Page 1 of (\d+)/.exec(text)![1]) >= 4);
  assert.match(text, /Q120 Question number 120/); assert.match(text, /Answer 120 — “quoted”, café/);
});

test("a script the file cannot carry: no file at all (the page offers Print), never a report with letters missing", () => {
  assert.equal(portalReportPdf(base({ title: "कल्याण सूचकांक" })), null);
  assert.equal(portalReportPdf(base({ answers: [{ code: "Q1", text: "Name", answer: "Łukasz" }] })), null);
  assert.equal(portalReportPdf(base({ person: { name: "Ana", respondentId: "RSP-ANA00001" }, comparison: [{ dimension: "energy", note: null, everyone: null, groups: [{ grouping: "Team", group: "Север", n: 12, mean: 1, median: 1, below: 1, above: 1 }] }] })), null);
  assert.ok(reportTexts(base()).includes("You usually have energy to spare."));
  assert.ok(portalReportPdf(base({ title: "Indice de bien-être — équipe №1".replace("№", "no ") })) instanceof Uint8Array);
});

test("the file name: letters, digits and dashes", () => {
  assert.equal(reportFileName("Workplace wellbeing index"), "Workplace-wellbeing-index-personal-report.pdf");
  assert.equal(reportFileName("Bien-être / équipe \"A\""), "Bien-etre-equipe-A-personal-report.pdf");
  assert.equal(reportFileName("कल्याण"), "report-personal-report.pdf");
});
