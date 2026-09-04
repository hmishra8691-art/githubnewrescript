import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  optionRule, simpleView, parsePunchExpression, formatPunchExpression, allPunchRules,
} from "./autoPunch.js";
import { applyPunches, resolvePunches } from "./setExpression.js";
import { effectiveQuestion } from "./carryforward.js";
import { createResponseState, answerKey } from "./state.js";
import { start, advance, setAnswer, findBlockStart } from "./flow.js";
import { blockDependencies } from "./dependencies.js";
import { resolveMediaUrl, isAllowedEmbed } from "./media.js";

/* ------------------------------------------------------------- fixtures */

const products = (id: string, code: string, type = "multi_select") => ({
  id, code, variableName: code, type, text: `${code}?`,
  options: [
    { code: "A", label: "Product A" },
    { code: "B", label: "Product B" },
    { code: "C", label: "Product C" },
  ],
});

/** Q1, Q2 on separate pages; Q3 single-select; Q4 numeric. */
const def = (punchesOnQ2: any[] = [], punchesOnQ3: any[] = [], extra: Record<string, any> = {}) =>
  SurveyDefinition.parse({
    meta: { id: "ap", code: "AP", title: "Auto punch", version: "1.0" },
    questions: [
      products("q1", "Q1"),
      { ...products("q2", "Q2"), punches: punchesOnQ2 },
      { ...products("q3", "Q3", "single_select"), punches: punchesOnQ3 },
      { id: "q4", code: "Q4", variableName: "Q4", type: "numeric", text: "How many?", ...(extra.q4 ?? {}) },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "block", id: "blk", title: "Products", children: [
        { type: "page", id: "p2", questionIds: ["q2", "q3"] },
        { type: "page", id: "p3", questionIds: ["q4"] },
      ] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

const selectedRule = (src: string, code: string, action: any, targets: string[]) =>
  optionRule({ sourceQuestionId: src, sourceCode: code, test: "selected", action, targetCodes: targets });

/** Answer Q1 on page 1 and advance onto the block page. */
const toPage2 = (d: SurveyDefinition, q1: unknown) => {
  const state = createResponseState(d);
  start(d, state);
  setAnswer(d, state, "q1", q1);
  advance(d, state);
  return state;
};

/* ------------------------------------------------------ the simple form */

test("optionRule builds the canonical PunchRule: literal codes + a selected condition on the source", () => {
  const r = selectedRule("q1", "A", "select", ["B"]);
  assert.deepEqual(r.source, { kind: "codes", codes: ["B"] });
  assert.equal(r.action, "select");
  assert.equal(r.recompute, "always");
  assert.deepEqual(r.when, { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "A", value2: undefined });
  // and reads back as the same simple form
  assert.deepEqual(simpleView(r), { sourceQuestionId: "q1", sourceCode: "A", test: "selected", action: "select", targetCodes: ["B"] });
});

test("simpleView refuses to flatten a rule that carries more than the simple form can hold", () => {
  const d = def();
  const complex = parsePunchExpression(d, "IF Q1.A AND NOT Q1.C THEN SELECT Q2.B").rules[0].rule;
  assert.equal(simpleView(complex), null);
  const mapped = { ...selectedRule("q1", "A", "select", ["B"]), mapping: [{ from: "B", to: "C" }] };
  assert.equal(simpleView(mapped as any), null);
});

/* ------------------------------------------------------- runtime effect */

test("IF Q1.A selected THEN SELECT Q2.B — Q2 arrives with B ticked, and only then", () => {
  const d = def([selectedRule("q1", "A", "select", ["B"])]);
  const yes = toPage2(d, ["A"]);
  assert.deepEqual(yes.answers[answerKey("q2", null)], ["B"]);
  const no = toPage2(d, ["C"]);
  assert.equal(no.answers[answerKey("q2", null)], undefined);
});

test("selects are additive on a multi and never duplicate; DESELECT removes", () => {
  const d = def([
    selectedRule("q1", "A", "select", ["B"]),
    selectedRule("q1", "C", "deselect", ["A"]),
  ]);
  const state = createResponseState(d);
  start(d, state);
  setAnswer(d, state, "q1", ["A", "C"]);
  // the respondent had already picked A and B on Q2 (e.g. via a back/forward)
  state.answers[answerKey("q2", null)] = ["A", "B"];
  advance(d, state);
  assert.deepEqual(state.answers[answerKey("q2", null)], ["B"]);
});

test("a single-select target takes the punched code; a condition on the same page re-punches when the source changes", () => {
  const d = def([], [selectedRule("q2", "A", "select", ["C"])]);
  const state = toPage2(d, ["A"]);
  // Q2 and Q3 share page 2: nothing ticked in Q2 yet
  assert.equal(state.answers[answerKey("q3", null)], undefined);
  setAnswer(d, state, "q2", ["A"]);
  const ctx = { def: d, state, loop: null, quotaCounts: {} };
  const q3 = d.questions.find((q) => q.id === "q3")!;
  const written = applyPunches(q3, ctx, (q) => answerKey(q.id, null));
  assert.deepEqual(written, { key: "q3", value: "C" });
});

test("CLEAR empties the target; SET writes a value that need not be an option (numeric)", () => {
  const d = def(
    [{ ...selectedRule("q1", "C", "clear", []), source: { kind: "codes", codes: [] } }],
    [],
    { q4: { punches: [{ id: "pv", source: { kind: "codes", codes: [7] }, action: "set_value", mapping: [], ignoreUnmatched: true, recompute: "always", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "A" } }] } },
  );
  const state = createResponseState(d);
  start(d, state);
  setAnswer(d, state, "q1", ["A", "C"]);
  state.answers[answerKey("q2", null)] = ["A", "B"];
  advance(d, state); // page 2: Q2 cleared
  assert.equal(state.answers[answerKey("q2", null)], undefined);
  setAnswer(d, state, "q2", ["B"]);
  advance(d, state); // page 3: Q4 set to 7
  assert.equal(state.answers[answerKey("q4", null)], 7);
});

test("SHOW / HIDE / ENABLE / DISABLE act on the option list, not the answer", () => {
  const d = def([
    selectedRule("q1", "A", "hide", ["C"]),
    selectedRule("q1", "B", "disable", ["A"]),
  ]);
  const state = toPage2(d, ["A", "B"]);
  const ctx = { def: d, state, loop: null, quotaCounts: {} };
  const q2 = d.questions.find((q) => q.id === "q2")!;
  const view = effectiveQuestion(q2, ctx);
  assert.deepEqual(view.options.map((o) => o.code), ["A", "B"]);
  assert.equal(view.options[0].meta?.disabled, true);
  assert.equal(view.options[1].meta?.disabled, undefined);
  // and the answer was left alone
  assert.equal(state.answers[answerKey("q2", null)], undefined);
  const res = resolvePunches(q2, ctx);
  assert.deepEqual(res.select, []);
});

test("SHOW puts a programmed option back that another stage removed", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "s", version: "1" },
    questions: [
      products("q1", "Q1"),
      { ...products("q2", "Q2"),
        options: [
          { code: "A", label: "Product A" },
          { code: "B", label: "Product B", visibleIf: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "B" } },
          { code: "C", label: "Product C" },
        ],
        punches: [selectedRule("q1", "A", "show", ["B"])] },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "page", id: "p2", questionIds: ["q2"] },
    ],
  });
  const state = toPage2(d, ["A"]);
  const q2 = d.questions[1];
  const view = effectiveQuestion(q2, { def: d, state, loop: null, quotaCounts: {} });
  assert.deepEqual(view.options.map((o) => o.code), ["A", "B", "C"]);
});

/* --------------------------------------------------------- expressions */

test("parsePunchExpression: IF Q1.A THEN SELECT Q2.B — one rule on Q2, condition from the logic parser", () => {
  const d = def();
  const r = parsePunchExpression(d, "IF Q1.A IS SELECTED THEN SELECT Q2.B");
  assert.deepEqual(r.errors, []);
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].targetQuestionId, "q2");
  assert.deepEqual(r.rules[0].rule.source, { kind: "codes", codes: ["B"] });
  assert.equal(r.rules[0].rule.action, "select");
  assert.equal((r.rules[0].rule.when as any).operator, "selected");
});

test("parsePunchExpression: several targets, several verbs, labels as option names, complex conditions", () => {
  const d = def();
  const r = parsePunchExpression(d, "IF (Q1.A OR Q1.B) AND NOT Q1.C THEN SELECT Q2.B, Q2.C AND DESELECT Q3.A");
  assert.deepEqual(r.errors, []);
  assert.equal(r.rules.length, 2);
  const q2 = r.rules.find((x) => x.targetQuestionId === "q2")!;
  const q3 = r.rules.find((x) => x.targetQuestionId === "q3")!;
  assert.deepEqual((q2.rule.source as any).codes, ["B", "C"]);
  assert.equal(q3.rule.action, "deselect");
  assert.equal(q2.rule.when?.type, "group");
  // both rules share the condition object shape
  assert.deepEqual(q2.rule.when, q3.rule.when);

  const byLabel = parsePunchExpression(d, "IF Q1.A THEN SELECT Q2.Product C");
  assert.deepEqual(byLabel.errors, []);
  assert.deepEqual((byLabel.rules[0].rule.source as any).codes, ["C"]);

  const clear = parsePunchExpression(d, "IF Q1.A THEN CLEAR Q4");
  assert.deepEqual(clear.errors, []);
  assert.equal(clear.rules[0].rule.action, "clear");
  assert.equal(clear.rules[0].targetQuestionId, "q4");
});

test("parsePunchExpression reports what is wrong, in words, without producing rules", () => {
  const d = def();
  assert.match(parsePunchExpression(d, "Q1.A SELECT Q2.B").errors[0].message, /IF <condition> THEN/);
  assert.match(parsePunchExpression(d, "IF Q1.A THEN Q2.B").errors[0].message, /not an action/);
  assert.match(parsePunchExpression(d, "IF Q1.A THEN SELECT Q9.B").errors[0].message, /Unknown question/);
  assert.match(parsePunchExpression(d, "IF Q1.A THEN SELECT Q2.Z").errors[0].message, /no option/);
  assert.match(parsePunchExpression(d, "IF Q1.A THEN SELECT Q2").errors[0].message, /needs an option/);
  assert.match(parsePunchExpression(d, "IF Q1.A THEN CLEAR Q2.B").errors[0].message, /CLEAR takes a whole question/);
  assert.match(parsePunchExpression(d, "IF Q1.A THEN SELECT Q2.B AND DESELECT Q2.C").errors[0].message, /Two different actions/);
  assert.ok(parsePunchExpression(d, "IF Q1.ZZZ THEN SELECT Q2.B").errors.length > 0);
});

test("formatPunchExpression round-trips through parsePunchExpression", () => {
  const d = def();
  const q2 = d.questions.find((q) => q.id === "q2")!;
  for (const src of [
    "IF Q1.A THEN SELECT Q2.B",
    "IF Q1.A AND Q1.B THEN SELECT Q2.B, Q2.C",
    "IF (Q1.A OR Q1.B) AND NOT Q1.C THEN DESELECT Q2.A",
    "IF Q1.A THEN HIDE Q2.C",
  ]) {
    const first = parsePunchExpression(d, src).rules[0].rule;
    const text = formatPunchExpression(d, q2, first);
    const again = parsePunchExpression(d, text).rules[0].rule;
    assert.deepEqual({ ...again, id: "x" }, { ...first, id: "x" }, `${src} → ${text}`);
  }
  const d2 = def([selectedRule("q1", "A", "select", ["B"])]);
  assert.equal(allPunchRules(d2).length, 1);
  assert.equal(allPunchRules(d2)[0].target.id, "q2");
});

/* --------------------------------------------------------- block preview */

test("start({ startAt }) enters the survey at the block's first page, with the same compiled flow", () => {
  const d = def([selectedRule("q1", "A", "select", ["B"])]);
  const state = createResponseState(d);
  const res = start(d, state, {}, { startAt: "blk" });
  assert.deepEqual(res.startAt, { blockId: "blk", found: true });
  const step = res.steps[res.stepIndex];
  assert.equal(step.kind, "page");
  assert.equal((step as any).pageId, "p2");
  assert.deepEqual((step as any).nodePath, ["blk"]);
  // punching still ran on arrival, from the seeded answers
  const seeded = createResponseState(d);
  seeded.answers.q1 = ["A"];
  start(d, seeded, {}, { startAt: "blk" });
  assert.deepEqual(seeded.answers[answerKey("q2", null)], ["B"]);
  // and the rest of the survey follows normally
  setAnswer(d, seeded, "q2", ["B"]);
  setAnswer(d, seeded, "q3", "A");
  const next = advance(d, seeded);
  assert.equal((next.steps[next.stepIndex] as any).pageId, "p3");
});

test("start({ startAt }) says so when the block is not reachable with these answers", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "s", version: "1" },
    questions: [products("q1", "Q1"), products("q2", "Q2")],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1"] },
      { type: "block", id: "blk", visibleIf: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: "A" },
        children: [{ type: "page", id: "p2", questionIds: ["q2"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const state = createResponseState(d);
  assert.equal(findBlockStart(d, state, {}, "blk"), -1);
  const res = start(d, state, {}, { startAt: "blk" });
  assert.deepEqual(res.startAt, { blockId: "blk", found: false });
  assert.equal((res.steps[res.stepIndex] as any).pageId, "p1"); // falls back to the first page, visibly
  state.answers.q1 = ["A"];
  assert.equal(findBlockStart(d, state, {}, "blk"), 1);
});

test("blockDependencies lists the earlier questions a block reads — logic, punches, piping, branch conditions — minus its own", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "s", version: "1" },
    questions: [
      products("q1", "Q1"), products("q0", "Q0"),
      { ...products("q2", "Q2"), text: "About {{Q0}}?", punches: [selectedRule("q1", "A", "select", ["B"])] },
      { ...products("q3", "Q3"), displayLogic: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "selected", value: "B" } },
      products("q5", "Q5"),
    ],
    flow: [
      { type: "page", id: "p0", questionIds: ["q0", "q1", "q5"] },
      { type: "branch", id: "br", branches: [{ id: "b1", when: { type: "rule", source: { kind: "question", ref: "q5" }, operator: "answered" }, children: [
        { type: "block", id: "blk", children: [{ type: "page", id: "p2", questionIds: ["q2", "q3"] }] },
      ] }] },
      { type: "end", id: "e", status: "complete" },
    ],
  });
  const deps = blockDependencies(d, "blk");
  assert.deepEqual(deps.questions.map((q) => q.id), ["q2", "q3"]);
  // survey order: q1, q0 (page order), q5 — q2→q3 is in-block and excluded
  assert.deepEqual(deps.dependsOn.map((q) => q.id).sort(), ["q0", "q1", "q5"]);
  assert.deepEqual(blockDependencies(d, "nope").questions, []);
});

/* ---------------------------------------------------------------- media */

test("resolveMediaUrl: YouTube in every spelling → one embed URL", () => {
  for (const u of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    "https://m.youtube.com/watch?feature=youtu.be&v=dQw4w9WgXcQ",
  ]) {
    const r = resolveMediaUrl(u);
    assert.equal(r.kind, "embed", u);
    assert.equal(r.provider, "youtube");
    assert.equal(r.id, "dQw4w9WgXcQ");
    assert.equal(r.url, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0");
    assert.ok(isAllowedEmbed(r.url!));
  }
  assert.equal(resolveMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s").url, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&start=90");
  assert.equal(resolveMediaUrl("https://www.youtube.com/").kind, "unsupported");
});

test("resolveMediaUrl: Google Drive share links → preview iframe with a sharing note", () => {
  for (const u of [
    "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing",
    "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz",
    "https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOpQrStUvWxYz&export=download",
  ]) {
    const r = resolveMediaUrl(u);
    assert.equal(r.kind, "embed", u);
    assert.equal(r.provider, "google_drive");
    assert.equal(r.url, "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/preview");
    assert.match(r.note ?? "", /Anyone with the link/);
  }
  assert.equal(resolveMediaUrl("https://drive.google.com/drive/my-drive").kind, "unsupported");
});

test("resolveMediaUrl: images by extension or CDN hint (query strings ignored), direct video by extension", () => {
  assert.equal(resolveMediaUrl("https://cdn.example.com/a/b/photo.JPG?w=800&sig=abc").kind, "image");
  assert.equal(resolveMediaUrl("https://images.example.com/x.webp").kind, "image");
  assert.equal(resolveMediaUrl("https://example.com/i/123?format=jpg").kind, "image");
  assert.equal(resolveMediaUrl("/uploads/pic.png").kind, "image");
  const v = resolveMediaUrl("https://media.example.com/clip.mp4?token=1");
  assert.equal(v.kind, "video");
  assert.equal(v.mimeType, "video/mp4");
  assert.equal(resolveMediaUrl("https://media.example.com/clip.webm").mimeType, "video/webm");
  // unknown extension-less URL: rendered as an image, the renderer reports if it isn't
  assert.equal(resolveMediaUrl("https://cdn.example.com/image/upload/v1/abc").kind, "image");
});

test("resolveMediaUrl: refuses javascript:, non-image data:, and never embeds an arbitrary host", () => {
  assert.equal(resolveMediaUrl("javascript:alert(1)").kind, "unsupported");
  assert.equal(resolveMediaUrl("JavaScript:alert(1)").kind, "unsupported");
  assert.equal(resolveMediaUrl("data:text/html,<script>alert(1)</script>").kind, "unsupported");
  assert.equal(resolveMediaUrl("data:image/png;base64,iVBORw0KGgo=").kind, "image");
  assert.equal(resolveMediaUrl("ftp://x/y.png").kind, "unsupported");
  assert.equal(resolveMediaUrl("").kind, "unsupported");
  assert.equal(isAllowedEmbed("https://evil.example.com/embed"), false);
  // an http URL to an unknown host is never an embed
  for (const u of ["https://vimeo.com/76979871", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]) {
    assert.ok(isAllowedEmbed(resolveMediaUrl(u).url!));
  }
});
