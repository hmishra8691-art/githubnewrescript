/**
 * THE REAL CORPUS (2026-11-11): five Decipher projects and five Qualtrics projects, as exported, kept as fixtures
 * (fixtures/corpus). Each test states what the import must reproduce for those files and holds the number of
 * things it cannot yet reproduce to a ceiling, so a regression — or a silent "improvement" that drops a report
 * line — fails here.
 *
 * The files are untrusted input: nothing in them is run. The journeys below run the IMPORTED survey in the
 * engine, which is the only way to know a converted rule behaves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { analyzeImport } from "./index.js";
import { walkSurvey } from "./verify.js";
import { readExecAssignments, readDispatchers, inlineDispatchers, expandCounts, exclusive } from "./adapters/decipherExec.js";
import { rewriteIdioms } from "./adapters/decipher.js";
import { applyRecode, recogniseQualtricsJs } from "./jsPatterns.js";

const file = (rel: string) => new Uint8Array(readFileSync(new URL(`../fixtures/corpus/${rel}`, import.meta.url)));
const load = async (rel: string) => { const a = await analyzeImport(file(rel), rel.split("/").pop()!, { surveyId: "corpus" }); assert.ok(a.result?.def, `${rel} imports`); return a; };
const q = (def: SurveyDefinition, code: string): Question => { const x = def.questions.find((y) => y.code === code); assert.ok(x, `question ${code}`); return x!; };
const ends = (ns: FlowNode[], out: Extract<FlowNode, { type: "end" }>[] = []) => { for (const n of ns) { if (n.type === "end") out.push(n); const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] }; if (k.children) ends(k.children, out); for (const b of k.branches ?? []) ends(b.children, out); if (k.otherwise) ends(k.otherwise, out); } return out; };

/* what each Decipher project may still report as high — every one of these is named in the migration report */
const DECIPHER_HIGH_CEILING: Record<number, number> = { 1: 5, 2: 1, 3: 4, 4: 2, 5: 2 };

for (const n of [1, 2, 3, 4, 5]) {
  test(`Decipher corpus ${n}: imports, passes the publish check, and stays under its ceiling of unconverted logic`, async () => {
    const a = await load(`decipher/decipher_${n}.xml`);
    const def = a.result!.def!;
    assert.deepEqual(a.result!.quality!.errors, [], "the engine's own publish check finds no error");
    assert.ok(a.report!.risks.high.length <= DECIPHER_HIGH_CEILING[n], `${a.report!.risks.high.length} high findings (ceiling ${DECIPHER_HIGH_CEILING[n]}): ${a.report!.risks.high.map((i) => i.location).join("; ")}`);
    /* nothing of the fraud service or the source's own quality bookkeeping is carried, and the report says so once */
    assert.ok(!def.questions.some((x) => /^RD_|^straightLine|^speeder$/i.test(x.code ?? "")));
    assert.ok(a.result!.issues.filter((i) => i.location === "fraud service").length <= 1);
    /* no condition was left as "applies to everyone" because of a comparison word, a cast or a switched-off constant */
    assert.ok(!a.result!.issues.some((i) => /could not be converted/.test(i.message) && /float\(|processTerms|“0”|\.sum (lt|gt)/.test(i.message)), "word operators, casts, dispatchers and constants are read");
    /* the supplier the source names is a vendor here, with a return link per outcome */
    assert.ok((def.panels ?? []).length >= 1, "a sample supplier is set up");
    for (const p of def.panels ?? []) { assert.ok(p.redirects.complete && /^https:\/\//.test(p.redirects.complete)); assert.ok(p.redirects.complete!.includes("{{pid}}"), "the supplier's id is piped back"); }
    /* every auto-punch rule sits on a hidden question and names an answer that question has */
    for (const x of def.questions.filter((y) => y.punches.length)) {
      assert.equal(x.settings.hidden, true, `${x.code} is hidden`);
      for (const p of x.punches) for (const c of (p.source as { codes: string[] }).codes) assert.ok(x.options.some((o) => String(o.code) === c), `${x.code} has answer ${c}`);
    }
  });
}

test("Decipher corpus 2: the converted rules behave — sample cell, supplier and region are coded from the link and the answers", async () => {
  const def = (await load("decipher/decipher_2.xml")).result!.def!;
  const run = (embedded: Record<string, string>) => walkSurvey(def, "first", 1, { embedded, keepState: true }).state!.answers as Record<string, unknown>;
  const a = run({ s: "2", sid: "4555", rdud: "abc" });
  assert.equal(a[q(def, "hSample").id], "2", "s == '2' → hSample.r2");
  assert.equal(a[q(def, "hidSupplier").id], "4555", "the supplier row whose value is sid");
  assert.equal(a[q(def, "hidTesting").id], "2", "live");
  /* the first state (Alabama, position 0 → reg 1) is in the South list → Q_REGION position 2 */
  assert.equal(a[q(def, "S3").id], "ch1");
  assert.equal(a[q(def, "Q_REGION").id], "3");
  const b = run({ s: "3", sid: "nobody" });
  assert.equal(b[q(def, "hSample").id], "3");
  assert.equal(b[q(def, "hidSupplier").id], "99", "no supplier matches → the default row, as the source's first assignment says");
  const c = run({});
  assert.equal(c[q(def, "hSample").id], "1", "else → r1");
});

test("Decipher corpus 4: a loop over what was selected, a jump to a block, and helper calls", async () => {
  const a = await load("decipher/decipher_4.xml");
  const def = a.result!.def!;
  const loops: Extract<FlowNode, { type: "loop" }>[] = [];
  const walk = (ns: FlowNode[]) => { for (const n of ns) { if (n.type === "loop") loops.push(n); const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[] }; if (k.children) walk(k.children); for (const b of k.branches ?? []) walk(b.children); } };
  walk(def.flow as FlowNode[]);
  assert.equal(loops.length, 2);
  for (const l of loops) assert.deepEqual(l.source, { kind: "question", questionId: q(def, "hQ27").id, filter: "selected" }, "<looprow cond=\"hQ27.rN\"> is a loop over hQ27's selected answers");
  assert.ok(!JSON.stringify(def.questions).includes("{{loop.var1}}"), "[loopvar: var1] reads the answer's label");
  assert.ok(!def.questions.some((x) => /loopvar/i.test(x.code ?? "")), "a label carrying the loop variable is one question, not an orphan");
  assert.ok(!a.result!.issues.some((i) => /Section_6/.test(i.message)), "goto a block → its first question");
  /* anyCodes(Q2, ['ch:2-8']) with a run of labels, and the "only these answers" counting idiom */
  assert.ok(q(def, "hAge").punches.length === 3 && q(def, "Q5_term").punches.length === 2);
  const only = q(def, "Q5_term").punches.find((p) => (p.source as { codes: string[] }).codes[0] === "1")!;
  assert.match(JSON.stringify(only.when), /"op":"not"/, "…and none of the other answers");
});

test("Decipher corpus: terminations — a switched-off term ends nobody, a dispatcher call is its condition, statuses are told apart", async () => {
  const a = await load("decipher/decipher_1.xml");
  const def = a.result!.def!;
  assert.ok(ends(def.flow as FlowNode[]).length >= 5);
  assert.ok(!a.result!.issues.some((i) => /now applies to everyone/.test(i.message)), "no termination was left unconditional");
  assert.ok(a.result!.issues.some((i) => i.location === "def processTerms()" && i.type === "converted"));
});

test("Decipher exec, read by shape: chains, last-wins, lists, row loops — and what is refused", () => {
  const leaves = (code: string, rows: Record<string, string[]> = {}) => readExecAssignments(code, (id) => rows[id]?.map((l, i) => ({ label: l, value: String(i + 1) })) ?? null);
  /* an if / elif / else chain: each leaf carries its path and the negation of the branches before it */
  const chain = leaves("if a.r1:\n  H.val = H.r1.index\nelif a.r2:\n  H.val = H.r2.index\nelse:\n  H.val = H.r3.index")!;
  assert.deepEqual(chain.map((l) => [l.option, l.guard]), [["r1", "(a.r1)"], ["r2", "(not(a.r1)) and (a.r2)"], ["r3", "(not(a.r1)) and (not(a.r2))"]]);
  assert.ok(exclusive(chain[0].at, chain[1].at) && exclusive(chain[1].at, chain[2].at), "branches of one chain exclude each other");
  /* separate statements do not: a later assignment replaces an earlier one */
  const seq = leaves("H.val = H.r2.index\nif(a.r4 or a.r5):\n  H.val = H.r1.index")!;
  assert.ok(!exclusive(seq[0].at, seq[1].at));
  /* a colon inside a call is not the header's colon; a position is an index; a local list and alias are written back */
  assert.deepEqual(leaves('if anyCodes(Q2, ["ch:2-8"]):\n\tH.val=0')!.map((l) => [l.index, l.guard]), [[0, '(anyCodes(Q2, ["ch:2-8"]))']]);
  assert.equal(leaves("west=[2,3]\nreg=S3.ival+1\nif reg in west:\n R.val=3")![0].guard, "((S3.ival+1) in [2,3])");
  assert.equal(rewriteIdioms("((S3.ival+1) in [2,3])"), "(S3.ival in [1, 2])");
  assert.equal(rewriteIdioms("S1.check('18-24')"), "((S1.val ge 18 and S1.val le 24))");
  /* a loop over rows is written out per row */
  assert.deepEqual(leaves("for row in B1.rows:\n  if row.c5 or row.c2:\n    hB.attr(row.label).val = 1", { B1: ["r1", "r2"] })!.map((l) => [l.target, l.option, l.guard]), [["hB", "r1", "(B1.r1.c5 or B1.r1.c2)"], ["hB", "r2", "(B1.r2.c5 or B1.r2.c2)"]]);
  /* anything else is not this idiom: nothing is half-converted */
  for (const code of ["x = File('a.dat','id').get(Q1.val)\nH.val = int(x['m'])", "for k in allQuestions.keys():\n  H.val = 1", "H.val = timeSpent() / 60.0", "import os\nH.val = 1"]) assert.equal(leaves(code), null, code);
  /* the dispatcher: a call with a literal is the condition its branch tests */
  const ds = readDispatchers('def processTerms(qid):\n  retvar = False\n  if qid == "Disp1":\n    if condition.Disp1:\n      retvar = True\n      setMarker("t1")\n  if gv.isSST():\n    return False\n  return retvar');
  assert.equal(inlineDispatchers("processTerms('Disp1') and Q1.r2", ds).text, "((condition.Disp1)) and Q1.r2");
  assert.equal(expandCounts("sum([1 for x in [a, b, c] if x]) ge 2"), "((a and b) or (a and c) or (b and c))");
});

/* ------------------------------------------------------------ Qualtrics */

/* what is left, all in project 3: nine video gates (Next only after the video ends), one seeded split of a statement list across two questions, and a quota whose source has cells at zero */
const QUALTRICS_HIGH_CEILING: Record<number, number> = { 1: 0, 2: 0, 3: 12, 4: 0, 5: 0 };

for (const n of [1, 2, 3, 4, 5]) {
  test(`Qualtrics corpus ${n}: imports and stays under its ceiling of unconverted logic`, async () => {
    const a = await load(`qualtrics/qualtrics_${n}.qsf`);
    assert.ok(a.report!.risks.high.length <= QUALTRICS_HIGH_CEILING[n], `${a.report!.risks.high.length} high findings (ceiling ${QUALTRICS_HIGH_CEILING[n]})`);
    assert.ok(!a.result!.issues.some((i) => /operator \? is not supported/.test(i.message)), "no condition is unreadable for want of an operator");
    assert.ok(!a.result!.quality!.errors.some((e) => /Duplicate variable|has no option coded/.test(e)), "no duplicate column, no rule on an answer the question lacks");
  });
}

test("Qualtrics corpus 1: a cross quota is one quota with a cell per combination; carried-forward answers keep their filter and their codes", async () => {
  const a = await load("qualtrics/qualtrics_1.qsf");
  const def = a.result!.def!;
  assert.deepEqual(a.result!.quality!.errors, []);
  const cross = def.quotas.find((x) => x.name === "Rep Data Asset Bands")!;
  assert.ok(cross, "the cross quota is there under its own name");
  assert.equal(cross.cells.length, 5, "five asset bands × one supplier condition");
  assert.ok(cross.cells.every((c) => c.limit === 83), "82.5 in the source, a whole respondent here");
  assert.match(JSON.stringify(cross.cells[0].when), /"kind":"embedded","ref":"rdud"/);
  assert.match(JSON.stringify(cross.cells[0].when), /"operator":"selected","value":7/);
  /* q://QID131/ChoiceGroup/SelectedChoicesTextEntry: the SELECTED answers, not all of them */
  const inst = def.questions.find((x) => x.id === "QID68")!;
  assert.deepEqual([inst.carryForward?.sourceQuestionId, inst.carryForward?.filter], ["QID131", "selected"]);
});

test("Qualtrics corpus 4: a question named like another question's answer column is renamed, and the report says so", async () => {
  const a = await load("qualtrics/qualtrics_4.qsf");
  const def = a.result!.def!;
  const names = def.questions.map((x) => x.variableName.toUpperCase());
  assert.equal(new Set(names).size, names.length);
  assert.ok(a.result!.issues.some((i) => i.type === "renamed" && /AQ5_1/.test(i.message)));
  /* "this answer in every row" / "not in every row" on a grid, written per row */
  assert.ok(!a.result!.issues.some((i) => /SelectedAnswerCount/.test(i.message)));
});

/* ------------------------------------------------------------ Qualtrics question JavaScript (2026-11-11) */

test("Qualtrics JavaScript, recognised by shape: whole scripts only, and nothing is run", () => {
  const hook = (body: string) => `Qualtrics.SurveyEngine.addOnload(function()\n{\n\t/*Place your JavaScript here to run when the page loads*/\n\n});\nQualtrics.SurveyEngine.addOnReady(function()\n{\n${body}\n});\nQualtrics.SurveyEngine.addOnUnload(function()\n{\n});`;
  const tick = `var qobj = this;\n var displayedChoices = [];\n jQuery.each(qobj.getChoices(), function(index, value) {\n if(qobj.getChoiceDisplayed(value)) displayedChoices.push(value);\n });\n for (var i=0; i<displayedChoices.length; i++)\n { qobj.setChoiceValue(displayedChoices[i], true); }\n jQuery("#"+this.questionId).hide()  //to hide question\n qobj.clickNextButton();`;
  assert.deepEqual(recogniseQualtricsJs(hook(tick)), { kind: "select_displayed" });
  /* the same script with one more statement is NOT the pattern: half a script converted is a different script */
  assert.equal(recogniseQualtricsJs(hook(`${tick}\n Qualtrics.SurveyEngine.setEmbeddedData("seen", "1");`)), null);
  assert.equal(recogniseQualtricsJs(hook(`fetch("https://example.com/x");\n${tick}`)), null);
  const union = (assign: string) => hook(`jQuery("#"+this.questionId).hide();\narrC1="\${q://QID52/SelectedChoicesRecode}";\nvar tempArray1 = arrC1.split(",").map(item => item.trim());\nvar arrC1S = tempArray1.map(item => item.replace("x", ""));\n for(var i=0;i<arrC1S.length;i++)\n {\n ${assign}\n this.setChoiceValueByRecodeValue(choiceVal, true);\n }\n var qobj = this;\n qobj.clickNextButton();`);
  assert.deepEqual(recogniseQualtricsJs(union('var choiceVal="";\n choiceVal=arrC1S[i];')), { kind: "recode_union", sources: [{ qid: "QID52", transform: { type: "same" } }] });
  assert.deepEqual(recogniseQualtricsJs(union("var choiceVal = parseInt(arrC1S[i], 10) + 16;")), { kind: "recode_union", sources: [{ qid: "QID52", transform: { type: "add", n: 16 } }] });
  assert.deepEqual(recogniseQualtricsJs(union('var choiceVal="";\n choiceVal=arrC1S[i]+0+3;')), { kind: "recode_union", sources: [{ qid: "QID52", transform: { type: "suffix", s: "03" } }] });
  /* JavaScript's "7" + 0 + 3 is the text "703", not 10 */
  assert.deepEqual([applyRecode(7, { type: "suffix", s: "03" }), applyRecode("7", { type: "add", n: 16 }), applyRecode(7, { type: "same" })], ["703", "23", "7"]);
  assert.equal(recogniseQualtricsJs(hook("var x = 1;")), null);
  assert.equal(recogniseQualtricsJs("alert(1)"), null);
});

test("Qualtrics corpus 2: every hidden-question script is native — the chain codes itself from the answers, with no script", async () => {
  const a = await load("qualtrics/qualtrics_2.qsf");
  const def = a.result!.def!;
  assert.deepEqual(a.result!.quality, { errors: [], warnings: [], deployable: true });
  assert.equal(a.report!.risks.high.length, 0);
  const natives = a.result!.jsMigrations.filter((m) => m.verdict === "native");
  assert.ok(natives.length >= 30, `${natives.length} scripts rebuilt natively`);
  assert.ok(def.scripts.every((s) => s.enabled === false), "the source code is kept, and nothing of it is switched on");
  const by = (code: string) => q(def, code);
  for (const code of ["Cohort_flag", "hQ14_Moderate", "hQ14", "hQ15", "WORKFLOW_1", "hQ28"]) { assert.equal(by(code).settings.hidden, true, code); assert.ok(by(code).punches.length > 0, code); assert.equal(by(code).carryForward, undefined, `${code}: its choices are its own`); }
  /* the journey: three workflows chosen, rated on two grids, then ranked */
  const force: Record<string, unknown> = { [by("Q13").id]: [1, 3, 5], [by("Q14").id]: { 1: 4, 3: 6, 5: 4 }, [by("Q15").id]: { 1: 4, 3: 6, 5: 7 }, [by("Q17").id]: [21, 17, 19] };
  const ans = walkSurvey(def, "deepest", 2, { force, keepState: true }).state!.answers as Record<string, unknown>;
  assert.deepEqual(ans[by("hQ14_Moderate").id], ["1", "5"], "the rows of Q14 answered with column 4");
  assert.deepEqual(ans[by("hQ14_Major").id], ["3"]);
  assert.deepEqual(ans[by("hQ14").id], ["1", "5", "3"], "the union, by recode");
  assert.deepEqual(ans[by("hQ15_Moderate").id], ["1"]);
  assert.deepEqual(ans[by("hQ15").id], ["17", "19", "21"], "recode + 16, as the script computes it");
  assert.deepEqual([ans[by("WORKFLOW_1").id], ans[by("WORKFLOW_2").id], ans[by("WORKFLOW_3").id]], ["21", "17", "19"], "the items ranked first, second, third");
  /* a count over a grid whose rows are carried, and the device-flag branches */
  assert.ok(!a.result!.issues.some((i) => /SelectedAnswerCount|count of rows with one answer/.test(i.message)));
  /* "device type is mobile" reads the native device class — the branch keeps its condition instead of applying to everyone */
  assert.match(JSON.stringify(def.flow), /"source":\{"kind":"behavior","ref":"device"\},"operator":"eq","value":"mobile"/);
  assert.match(JSON.stringify(def.flow), /"source":\{"kind":"behavior","ref":"device"\},"operator":"ne","value":"mobile"/);
});

test("Qualtrics corpus 3: a field set inside a branch is set; a cross quota's cells are read one by one; the only choice shown is chosen", async () => {
  const a = await load("qualtrics/qualtrics_3.qsf");
  const def = a.result!.def!;
  const by = (code: string) => q(def, code);
  /* `cell = 0` / `cell = 1` under "cell N of the quota has not been met": the assignment was dropped as a duplicate field */
  const run = walkSurvey(def, "first", 1, { keepState: true });
  assert.ok(["0", "1"].includes(String((run.state!.embedded as Record<string, unknown>).cell)), "the respondent is assigned a cell");
  assert.ok(run.pages > 0, "…and is not screened out for having none");
  assert.ok(def.quotas.some((x) => /^Cell · /.test(x.name)) && def.quotas.filter((x) => /^Cell · /.test(x.name)).every((x) => x.cells.length === 1 && x.cells[0].limit === 200), "each cell keeps its own count");
  const pick = (considered: number[]) => (walkSurvey(def, "deepest", 2, { force: { [by("Portfolio_Awareness").id]: [1, 3, 5], [by("Portfolio_Consideration").id]: considered, [by("Portfolio_Preference").id]: undefined }, keepState: true }).state!.answers as Record<string, unknown>)[by("Portfolio_Preference").id];
  assert.equal(pick([3]), "3", "one brand considered → it is the preference");
  assert.equal(pick([3, 5]), undefined, "two → the respondent chooses");
  /* what is not reproduced is said for what it is */
  assert.equal(a.report!.risks.high.filter((i) => /Next hidden until the video has played/.test(i.message)).length, 9);
});

test("Qualtrics corpus 5: a script that does nothing here is not a risk", async () => {
  const a = await load("qualtrics/qualtrics_5.qsf");
  assert.equal(a.report!.risks.high.length, 0);
  assert.equal(a.result!.issues.filter((i) => i.type === "dropped" && /this question has no text box/.test(i.message)).length, 2);
});

/* ------------------------------------------------------------ companion files, counters, time (2026-11-11) */

test("Decipher corpus: the import asks for the files it needs — one line per file, with what waits on it", async () => {
  const want: Record<number, string[]> = { 1: ["quota sheet", "QB1_MaxdiffNEW.dat", "QB1_Maxdiff.dat"], 2: ["quota sheet"], 3: ["zipstate.dat", "quota sheet"], 4: ["quota sheet", "ZipFile_New.dat"], 5: ["zipstate.dat", "quota sheet"] };
  for (const n of [1, 2, 3, 4, 5]) {
    const a = await load(`decipher/decipher_${n}.xml`);
    const files = a.report!.requiredFiles;
    assert.deepEqual(files.map((f) => f.name).sort(), [...want[n]].sort(), `project ${n}`);
    for (const f of files) {
      assert.ok(f.neededFor.length > 0 && f.why.length > 10, `${f.name} says what it is for`);
      assert.equal(a.report!.risks.high.filter((i) => i.location === (f.kind === "quota_sheet" ? "quota sheet" : `data file ${f.name}`)).length, 1, `${f.name}: asked for once`);
    }
    /* nothing that waits on a file is ALSO reported as unconvertible code */
    assert.ok(!a.report!.risks.high.some((i) => /quota sheet \(a picker/.test(i.message)));
    assert.ok(a.report!.summary.some((line) => /^Needs a file: /.test(line)), "the summary Intelligent mode reads out names the files");
  }
  const d3 = await load("decipher/decipher_3.xml");
  const zip = d3.report!.requiredFiles.find((f) => f.name === "zipstate.dat")!;
  assert.equal(zip.key, "id");
  assert.ok(zip.neededFor.some((x) => /zipTerm/.test(x)), "the invalid-zip termination waits on the zip file");
  assert.ok(!JSON.stringify(d3.result!.def!.flow).includes("zipTerm"), "…and ends nobody until it is rebuilt (it was “terminate everyone”)");
});

test("Decipher corpus 1: a Python row counter is a hidden helper's count; timeSpent() is the elapsed time", async () => {
  const a = await load("decipher/decipher_1.xml");
  const def = a.result!.def!;
  const helper = q(def, "hTermS12_cnt");
  assert.equal(helper.settings.hidden, true);
  assert.equal(helper.punches.length, 11, "one rule per row the source counts");
  const flag = q(def, "hTermS12");
  assert.match(JSON.stringify(flag.punches), /"kind":"expr","ref":"COUNT\(hTermS12_cnt\)"\},"operator":"gte","value":4/);
  /* four rows of S12 answered in the top three columns → "Don't term" (r2); three → "Term" (r1) */
  const run = (rows: Record<string, number>) => (walkSurvey(def, "deepest", 2, { force: { [q(def, "S12").id]: rows }, keepState: true }).state!.answers as Record<string, unknown>);
  const hi = run({ r1: 8, r2: 9, r3: 10, r4: 8, r5: 1 });
  assert.deepEqual(hi[helper.id], ["1", "2", "3", "4"]);
  assert.equal(hi[flag.id], "2");
  const lo = run({ r1: 8, r2: 9, r3: 10, r4: 1, r5: 1 });
  assert.deepEqual(lo[helper.id], ["1", "2", "3"]);
  assert.equal(lo[flag.id], "1");
  /* the speeder termination: "under 600 seconds since the start", carried as that, with status terminated */
  assert.match(JSON.stringify(def.flow), /"source":\{"kind":"behavior","ref":"elapsed"\},"operator":"lt","value":600/);
});

test("Decipher corpus 2: rows joined by an attribute, and ranges kept on the rows", async () => {
  const def = (await load("decipher/decipher_2.xml")).result!.def!;
  /* hidSupplierQTA takes the row whose cs:panel is that of hidSupplier's answer */
  assert.ok(q(def, "hidSupplierQTA").punches.length >= 2);
  /* hAge: each row's alt="18-24" … ">=65" is its range of S5 */
  const run = (age: number) => (walkSurvey(def, "deepest", 2, { force: { [q(def, "S5").id]: age }, keepState: true }).state!.answers as Record<string, unknown>)[q(def, "hAge").id];
  assert.deepEqual([run(19), run(40), run(70)], ["1", "3", "6"]);
});
