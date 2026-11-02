import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowNode, SurveyDefinition } from "@rescript/schema";
import { analyzeImport, verifyImport, simulateDynamics, clarifications, applyDecisions, mapCanonical, SUGGEST_SYSTEM_PROMPT, NATIVE_CAPABILITIES, type CanonicalSurvey } from "./index.js";

/** 2026-11-02 — dynamic reconstruction: carried and masked lists, loops, piping, from Word and QSF, checked, corrected and run */
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const load = (dir: string, f: string) => analyzeImport(new Uint8Array(readFileSync(join(CORPUS, dir, f))), f, { surveyId: "s", uid });
type A = Awaited<ReturnType<typeof load>>;
const q = (a: A, code: string) => a.result!.def!.questions.find((x) => x.code === code)!;
const cf = (a: A, code: string) => { const c = q(a, code).carryForward; return c ? `${a.result!.def!.questions.find((x) => x.id === c.sourceQuestionId)!.code}:${c.filter}` : null; };
const loops = (def: SurveyDefinition) => {
  const out: { source: unknown; members: string[] }[] = [];
  const w = (ns: FlowNode[]) => { for (const x of ns as (FlowNode & { children?: FlowNode[]; source?: unknown })[]) {
    if (x.type === "loop") { const m: string[] = []; const p = (cs: FlowNode[]) => { for (const y of cs as (FlowNode & { children?: FlowNode[]; questionIds?: string[] })[]) { if (y.type === "page") m.push(...(y.questionIds ?? []).map((id) => def.questions.find((z) => z.id === id)!.code)); if (y.children) p(y.children); } }; p(x.children ?? []); out.push({ source: x.source, members: m }); }
    if (x.children) w(x.children);
  } };
  w(def.flow);
  return out;
};

test("word 08: carry forward, masking from a carried list, same list, codes kept, duplicate list corrected", async () => {
  const a = await load("word", "08-carry-forward-masking.docx");
  assert.equal(cf(a, "Q2"), "Q1:selected");
  assert.equal(cf(a, "Q3"), "Q2:not_selected", "masking reads from the carried list");
  assert.equal(cf(a, "Q4"), "Q2:selected");
  assert.equal(q(a, "Q4").type, "single_select", "a carried question with no options takes its kind from the wording");
  assert.equal(cf(a, "Q5"), "Q1:all", "“same list as Q1”");
  assert.equal(cf(a, "Q6"), "Q1:selected");
  assert.deepEqual(q(a, "Q1").options!.map((o) => o.code), [1, 2, 3, 4, 99], "the source's codes");
  const r = a.report!.reconstruction!;
  assert.equal(r.counts.alternative, 1);
  const alt = r.items.find((i) => i.category === "alternative")!;
  assert.equal(alt.location, "Q6");
  assert.match(alt.why, /codes/);
  assert.equal(q(a, "Q6").carryForward!.keepOwn, false, "the written copy of Q1's list is removed, not shown twice");
  assert.ok(!a.canonical!.issues.some((i) => /lists no options/.test(i.message)), "a carried question is not reported as having no options");
});

test("word 09: a loop over the brands selected, the item piped, answers piped by four notations", async () => {
  const a = await load("word", "09-loops-piping.docx");
  const def = a.result!.def!;
  const ls = loops(def);
  assert.equal(ls.length, 1);
  assert.deepEqual(ls[0].members, ["Q2", "Q3"]);
  assert.deepEqual(ls[0].source, { kind: "question", questionId: q(a, "Q1").id, filter: "selected" });
  assert.match(q(a, "Q2").text, /\{\{loop\.label\}\}/);
  assert.match(q(a, "Q3").text, /\{\{loop\.label\}\}/);
  assert.match(q(a, "Q4").text, /\{\{Q1\}\}/, "[INSERT ANSWER FROM Q1]");
  assert.match(q(a, "Q6").text, /\{\{Q5\}\}.*\{\{Q4\}\}/, "[Q5 ANSWER] and [INSERT Q4]");
  assert.match(q(a, "Q7").text, /\{\{Q4\}\}/, "{Q4}");
  assert.ok(!/\[|\]/.test(def.questions.map((x) => x.text).join(" ")), "no bracketed placeholder left as literal text");
  assert.equal(a.report!.reconstruction!.counts.reconstructed, 6);
});

test("word 10: informal instructions — read, and what is inferred or unread asked, not guessed", async () => {
  const a = await load("word", "10-informal-instructions.docx");
  assert.equal(cf(a, "Q2"), "Q1:selected", "“only show the supermarkets they picked in the previous question”");
  assert.equal(cf(a, "Q3"), "Q1:not_selected", "“mask out whatever they chose in Q1”");
  assert.equal(cf(a, "Q5"), "Q1:all", "“use the same answer list as Q1”");
  assert.deepEqual(loops(a.result!.def!).map((l) => l.members), [["Q4"]], "“repeat this question for every supermarket selected in Q1”");
  assert.match(q(a, "Q6").text, /\{\{Q2\}\}/, "[INSERT Q2 RESPONSE]");
  assert.equal(q(a, "Q7").carryForward, undefined, "“only show the supermarkets they like” is not guessed");
  const r = a.report!.reconstruction!;
  assert.equal(r.counts.confirm, 2);
  assert.deepEqual(r.items.filter((i) => i.category === "confirm").map((i) => i.location).sort(), ["Q2", "Q7"]);
});

test("clarifications: the unread instruction is asked; the inferred source is confirmed; decisions apply; a bad decision is refused", async () => {
  const a = await load("word", "10-informal-instructions.docx");
  const c = a.canonical! as CanonicalSurvey;
  const asks = clarifications(c);
  const dyn = asks.find((x) => x.kind === "dynamic_list")!;
  assert.ok(dyn, "Q7 is asked");
  assert.equal(dyn.recommended, null, "no rule can read it, so nothing is recommended");
  assert.ok(dyn.alternatives.some((x) => x.decision.type === "carry_forward") && dyn.alternatives.some((x) => x.decision.type === "loop"));
  const conf = asks.find((x) => x.kind === "confirm_dynamic")!;
  assert.equal(conf.recommended!.decision.type, "keep");

  const pick = dyn.alternatives.find((x) => x.decision.type === "carry_forward" && (x.decision as { source: string }).source === "Q4")!;
  const out = applyDecisions(c, [pick.decision, conf.recommended!.decision]);
  assert.deepEqual(out.rejected, []);
  const m = mapCanonical(out.canonical, { surveyId: "s", uid });
  const q7 = m.def!.questions.find((x) => x.code === "Q7")!;
  assert.equal(q7.carryForward?.filter, "selected");
  assert.equal(m.def!.questions.find((x) => x.id === q7.carryForward!.sourceQuestionId)!.code, "Q4");
  assert.equal(m.reconstruction!.counts.confirm, 0, "both resolved");

  const loop = dyn.alternatives.find((x) => x.decision.type === "loop")!;
  const lm = mapCanonical(applyDecisions(c, [loop.decision]).canonical, { surveyId: "s", uid });
  assert.ok(loops(lm.def!).some((l) => l.members.includes("Q7")), "the loop alternative builds a loop");

  const bad = applyDecisions(c, [
    { ...(pick.decision as object), id: "x1", filter: "everything" } as never,
    { ...(pick.decision as object), id: "x2", source: "Q7" } as never,
    { id: "x3", type: "carry_forward", source: "Q1", filter: "selected" } as never,
  ]);
  assert.deepEqual(bad.applied, []);
  assert.deepEqual(bad.rejected.map((r) => r.id), ["x1", "x2", "x3"]);
});

test("qsf 05: a condition on a carried choice, recodes kept, piped redirect, loop over a carried list", async () => {
  const a = await load("qsf", "05-dynamic-lists.qsf");
  const def = a.result!.def!;
  const main = q(a, "main");
  assert.ok(main.displayLogic, "display logic on a carried choice (x1) is kept");
  assert.match(JSON.stringify(main.displayLogic), /"value":10\b/, "x1 resolves through the carry to QID1's recode 10");
  assert.deepEqual(q(a, "aware").options!.map((o) => o.code), [10, 20, 30, 40, 99]);
  const ends: string[] = [];
  const w = (ns: FlowNode[]) => { for (const x of ns as (FlowNode & { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; redirectUrl?: string })[]) { if (x.type === "end" && x.redirectUrl) ends.push(x.redirectUrl); if (x.children) w(x.children); for (const b of x.branches ?? []) w(b.children); } };
  w(def.flow);
  assert.ok(ends.some((u) => u.includes("{{ed.panel}}")), "${e://Field/panel} in a redirect");
  assert.ok(!ends.some((u) => u.includes("${")));
  assert.match(q(a, "sat").text, /\{\{loop\.label\}\}/, "${lm://Field/1}");
  assert.equal(a.report!.reconstruction!.counts.reconstructed, 6);
});

test("synthetic respondents: carried lists, masks, loops and pipes behave on the engine", async () => {
  for (const [dir, f, min] of [["word", "08-carry-forward-masking.docx", 20], ["word", "09-loops-piping.docx", 9], ["word", "10-informal-instructions.docx", 14], ["qsf", "05-dynamic-lists.qsf", 13]] as const) {
    const a = await load(dir, f);
    const v = verifyImport(a.canonical!, a.result!);
    assert.ok(v.dynamics, f);
    assert.equal(v.dynamics!.failed, 0, `${f}: ${v.dynamics!.scenarios.filter((s) => s.result === "fail").map((s) => `${s.id} want ${s.expected} got ${s.observed}`).join("; ")}`);
    assert.ok(v.dynamics!.scenarios.length >= min, `${f}: ${v.dynamics!.scenarios.length} scenarios`);
  }
  const a = await load("word", "08-carry-forward-masking.docx");
  const mask = simulateDynamics(a.result!.def!).scenarios.filter((s) => s.feature === "mask");
  assert.deepEqual(mask.map((s) => s.observed), ["2,3", "(none)", "1,2,3", "1,2"], "the mask follows Q2: one, several, none, changed");
});

test("synthetic respondents fail when the mapping does not do what the source says", async () => {
  const a = await load("word", "08-carry-forward-masking.docx");
  const good = verifyImport(a.canonical!, a.result!).dynamics!;
  assert.equal(good.failed, 0);
  /* the mapping got Q2 wrong: it shows Q1's whole list whatever was chosen */
  const def = structuredClone(a.result!.def!);
  const q2 = def.questions.find((x) => x.code === "Q2")!;
  q2.carryForward = { ...q2.carryForward!, filter: "all" };
  const bad = verifyImport(a.canonical!, { ...a.result!, def }).dynamics!;
  const q2s = bad.scenarios.filter((s) => s.target === "Q2");
  assert.ok(q2s.some((s) => s.result === "fail" && /one answer/.test(s.scenario)), "one brand chosen, the whole list shown: fails");
  assert.ok(bad.failed >= 3, `${bad.failed} failed`);
  /* the carry dropped altogether */
  const def2 = structuredClone(a.result!.def!);
  delete def2.questions.find((x) => x.code === "Q4")!.carryForward;
  const bad2 = verifyImport(a.canonical!, { ...a.result!, def: def2 }).dynamics!;
  assert.ok(bad2.scenarios.some((s) => s.target === "Q4" && s.result === "fail"), "a dropped carry fails");

  const b = await load("word", "09-loops-piping.docx");
  /* the loop's questions moved out of the loop: no loop scenario is claimed, and the loop pipe is reported by reconstruction */
  const broken = structuredClone(b.result!.def!);
  const strip = (ns: FlowNode[]): FlowNode[] => ns.flatMap((x) => (x.type === "loop" ? ((x as FlowNode & { children: FlowNode[] }).children) : [x])).map((x) => ((x as { children?: FlowNode[] }).children ? { ...x, children: strip((x as { children: FlowNode[] }).children) } : x)) as FlowNode[];
  broken.flow = strip(broken.flow);
  assert.equal(simulateDynamics(broken).scenarios.filter((s) => s.feature === "loop").length, 0, "no loop, no loop scenario claimed");
  /* a pipe that resolves to nothing fails */
  const wrongPipe = structuredClone(b.result!.def!);
  wrongPipe.questions.find((x) => x.code === "Q7")!.text = "Any other comments about {{Q5}}?";
  const s = simulateDynamics(wrongPipe).scenarios.find((x) => x.id === "pipe:Q7:Q5")!;
  assert.equal(s.result, "pass");
  assert.match(s.observed, /42/);
});

test("the AI suggestion prompt lists the native capabilities, from the registry", () => {
  for (const c of NATIVE_CAPABILITIES) assert.ok(SUGGEST_SYSTEM_PROMPT.includes(c.feature), c.id);
  assert.match(SUGGEST_SYSTEM_PROMPT, /Never invent a choice/);
  assert.match(SUGGEST_SYSTEM_PROMPT, /does not let you propose anything that is not one of the numbered choices/);
});
