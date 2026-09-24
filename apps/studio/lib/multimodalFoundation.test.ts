import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import type { Question, FlowNode } from "@rescript/schema";
import {
  resolveInitialMode, withModeInUrl, MODES, DEFAULT_MODE, isProgrammingMode,
} from "./programmingMode.ts";
import { selectionReducer, EMPTY_SELECTION, questionIdOf } from "./selection.ts";
import {
  parseShortcut, matchesShortcut, formatShortcut, fuzzyScore, rank, applicable, commandForKey,
} from "./commands/core.ts";
import { builtinCommands, navigationCommands, findCommands, type StudioCommandContext } from "./commands/builtins.ts";

/**
 * THE SHARED LAYER UNDER THE FIVE ENVIRONMENTS.
 *
 * Mode resolution, the selection reducer, shortcut matching, palette ranking
 * and the built-in commands are all pure, so they are tested here without a
 * browser. The palette UI and the mode selector are covered by
 * scripts/multimodal-foundation-test.mjs.
 */

/* ------------------------------------------------------------ mode */

test("the URL wins over memory, memory over the default, and an unavailable mode falls back", () => {
  assert.equal(resolveInitialMode("", null), DEFAULT_MODE);
  assert.equal(resolveInitialMode("?mode=studio", "studio"), "studio");
  // Flow is declared but has no renderer yet: never open on an empty screen
  const flow = MODES.find((m) => m.id === "flow")!;
  assert.equal(flow.available, false, "this test assumes Flow is not yet built; update it when it is");
  assert.equal(resolveInitialMode("?mode=flow", null), DEFAULT_MODE);
  assert.equal(resolveInitialMode("?tab=logic", "flow"), DEFAULT_MODE);
  // Grid and Architect ARE available: the URL and memory both work for them
  assert.equal(resolveInitialMode("?mode=grid", null), "grid");
  assert.equal(resolveInitialMode("", "grid"), "grid");
  assert.equal(resolveInitialMode("?mode=architect", null), "architect");
  assert.equal(resolveInitialMode("?mode=nonsense", "alsononsense"), DEFAULT_MODE);
  assert.equal(isProgrammingMode("flow"), true);
  assert.equal(isProgrammingMode("Flow"), false);
});

test("withModeInUrl keeps the other params and drops the default", () => {
  assert.equal(withModeInUrl("?tab=logic", "studio"), "?tab=logic");
  assert.equal(withModeInUrl("?tab=logic&mode=grid", "studio"), "?tab=logic");
  assert.equal(withModeInUrl("", "studio"), "");
  assert.equal(withModeInUrl("?tab=logic", "grid"), "?tab=logic&mode=grid");
});

test("all five modes are declared with distinct ids and indexes", () => {
  assert.deepEqual(MODES.map((m) => m.id), ["studio", "grid", "architect", "flow", "intelligent"]);
  assert.deepEqual(MODES.map((m) => m.index), [1, 2, 3, 4, 5]);
});

/* ------------------------------------------------------------ selection */

const Q = (id: string) => `question:${id}` as const;

test("plain select replaces; toggle adds and removes; primary follows the last touch", () => {
  let st = selectionReducer(EMPTY_SELECTION, { type: "select", key: Q("a") });
  assert.deepEqual(st, { primary: Q("a"), keys: [Q("a")], anchor: Q("a") });
  st = selectionReducer(st, { type: "toggle", key: Q("b") });
  assert.deepEqual(st.keys, [Q("a"), Q("b")]);
  assert.equal(st.primary, Q("b"));
  st = selectionReducer(st, { type: "toggle", key: Q("b") });
  assert.deepEqual(st.keys, [Q("a")]);
  assert.equal(st.primary, Q("a"), "removing the primary promotes the last remaining key");
  st = selectionReducer(st, { type: "select", key: Q("c") });
  assert.deepEqual(st.keys, [Q("c")], "a plain click replaces the whole set");
});

test("shift-range selects between the anchor and the clicked key in the given order, keeping outside picks", () => {
  const order = ["a", "b", "c", "d", "e"].map(Q);
  let st = selectionReducer(EMPTY_SELECTION, { type: "select", key: Q("b") });
  st = selectionReducer(st, { type: "toggle", key: Q("e") });   // an outside pick
  st = selectionReducer(st, { type: "range", key: Q("d"), order });
  assert.deepEqual(new Set(st.keys), new Set([Q("e"), Q("b"), Q("c"), Q("d")]));
  assert.equal(st.primary, Q("d"));
  assert.equal(st.anchor, Q("b"), "the anchor is the plain click, not the shift click");
  // backwards range works too
  st = selectionReducer(st, { type: "range", key: Q("a"), order });
  assert.ok(st.keys.includes(Q("a")) && st.keys.includes(Q("b")));
});

test("range with no anchor degrades to a plain select", () => {
  const st = selectionReducer(EMPTY_SELECTION, { type: "range", key: Q("c"), order: ["a", "b", "c"].map(Q) });
  assert.deepEqual(st.keys, [Q("c")]);
});

test("drop removes deleted objects and promotes a new primary; clear and no-op selects keep identity", () => {
  let st = selectionReducer(EMPTY_SELECTION, { type: "set", keys: ["a", "b", "c"].map(Q) });
  assert.equal(st.primary, Q("a"));
  st = selectionReducer(st, { type: "drop", keys: [Q("a")] });
  assert.deepEqual(st.keys, [Q("b"), Q("c")]);
  assert.equal(st.primary, Q("c"));
  const same = selectionReducer(st, { type: "drop", keys: [Q("zzz")] });
  assert.equal(same, st, "dropping something not selected returns the same object (no re-render)");
  const again = selectionReducer(st, { type: "select", key: Q("c") });
  assert.notEqual(again, st, "c was primary but not the only key, so this is a real change");
  const only = selectionReducer(again, { type: "select", key: Q("c") });
  assert.equal(only, again, "selecting the sole selected key again is a no-op");
  assert.equal(selectionReducer(EMPTY_SELECTION, { type: "clear" }), EMPTY_SELECTION);
  assert.equal(questionIdOf(Q("x")), "x");
  assert.equal(questionIdOf("flowNode:x"), null);
  assert.equal(questionIdOf(null), null);
});

/* ------------------------------------------------------------ shortcuts */

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) =>
  ({ key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt });

test("shortcuts parse in any order and match ⌘ or Ctrl as `mod`", () => {
  assert.deepEqual(parseShortcut("shift+mod+K"), { key: "k", mod: true, shift: true, alt: false });
  assert.ok(matchesShortcut(key("k", { meta: true }), "mod+k"));
  assert.ok(matchesShortcut(key("K", { ctrl: true }), "mod+k"), "Ctrl is mod on Windows/Linux");
  assert.ok(!matchesShortcut(key("k", { meta: true, shift: true }), "mod+k"), "an extra modifier is a different chord");
  assert.ok(!matchesShortcut(key("k"), "mod+k"));
  assert.ok(matchesShortcut(key("ArrowUp", { alt: true }), "alt+arrowup"));
  assert.equal(formatShortcut("mod+shift+d", true), "⌘⇧D");
  assert.equal(formatShortcut("mod+shift+d", false), "Ctrl+Shift+D");
  assert.equal(formatShortcut("alt+arrowup", true), "⌥Arrowup");
});

test("commandForKey respects typing, `global`, `when` and read-only", () => {
  const cmds = builtinCommands();
  const base: StudioCommandContext = fakeCtx();
  const palette = commandForKey(cmds, key("k", { meta: true }), base, true);
  assert.equal(palette?.id, "palette.open", "⌘K opens the palette even while typing");
  const add = commandForKey(cmds, key("a", { meta: true, shift: true }), base, false);
  assert.equal(add?.id, "question.add");
  assert.equal(commandForKey(cmds, key("a", { meta: true, shift: true }), base, true), null, "not while typing");
  assert.equal(commandForKey(cmds, key("a", { meta: true, shift: true }), { ...base, readOnly: true }, false), null, "an edit is refused in read-only");
  assert.equal(commandForKey(cmds, key("d", { meta: true, shift: true }), base, false), null, "duplicate needs a selected question");
  assert.equal(commandForKey(cmds, key("d", { meta: true, shift: true }), { ...base, questionId: "q1", primary: "question:q1" }, false)?.id, "question.duplicate");
});

/* ------------------------------------------------------------ matching */

test("fuzzy ranking prefers contiguous, word-start and exact matches", () => {
  assert.ok(fuzzyScore("logic", "Open Logic") > fuzzyScore("logic", "Add display logic rule"), "contiguous at a word start beats a later hit");
  assert.ok(fuzzyScore("adq", "Add question") > 0, "subsequence matches");
  assert.equal(fuzzyScore("xyz", "Add question"), 0, "no match is zero");
  assert.ok(fuzzyScore("Undo", "Undo") > fuzzyScore("Undo", "Undo last edit"), "exact beats prefix");
  const items = ["Add question", "Add block", "Open Questions", "Duplicate question"];
  const r = rank("quest", items, (s) => [s]);
  assert.equal(r[0].item, "Add question");
  assert.ok(r.every((x) => x.item !== "Add block"));
  assert.equal(rank("", items, (s) => [s]).length, items.length, "an empty query lists everything");
});

/* ------------------------------------------------------------ built-ins */

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "Age" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "text", text: "City" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

function fakeCtx(over: Partial<StudioCommandContext> = {}): StudioCommandContext {
  let def = over.def ?? survey();
  const log: string[] = [];
  let n = 0;
  const ctx: StudioCommandContext = {
    tab: "questions", mode: "studio", primary: null, questionId: null, readOnly: false,
    get def() { return def; },
    update(label, mutator) { const d = structuredClone(def); mutator(d); def = d; log.push(`update:${label}`); },
    undo: () => true, redo: () => true, canUndo: true, canRedo: false,
    selectQuestion(id) { log.push(`select:${id}`); ctx.questionId = id; ctx.primary = id ? `question:${id}` : null; },
    setTab(t) { log.push(`tab:${t}`); ctx.tab = t; },
    setMode(m) { log.push(`mode:${m}`); ctx.mode = m; },
    focus: false,
    setFocus(on) { log.push(`focus:${on}`); ctx.focus = on; },
    uid: (p) => `${p}_${n++}`,
    newQuestion: (d) => ({ id: `q_new${n++}`, code: `Q${d.questions.length + 1}`, variableName: `Q${d.questions.length + 1}`, type: "text", text: "", options: [], rows: [], columns: [] } as unknown as Question),
    newFlowNode: (type) => ({ type, id: `${type}_${n++}`, children: [], branches: [{ id: "b", when: { type: "group", op: "and", children: [] }, children: [] }], otherwise: [] } as unknown as FlowNode),
    shell: { save: () => { log.push("save"); }, openPalette: () => { log.push("palette"); } },
    toast: (m) => { log.push(`toast:${m}`); },
    tabs: [{ key: "questions", label: "Questions", group: "Programming" }, { key: "logic", label: "Logic", group: "Programming" }],
    ...over,
  };
  (ctx as unknown as { log: string[] }).log = log;
  return ctx;
}
const logOf = (ctx: StudioCommandContext) => (ctx as unknown as { log: string[] }).log;

test("question.add inserts after the selected question through the engine, selects the copy and goes to Questions", () => {
  const ctx = fakeCtx({ tab: "logic" });
  ctx.selectQuestion("q1");
  builtinCommands().find((c) => c.id === "question.add")!.run(ctx);
  const page = ctx.def.flow[0] as { questionIds: string[] };
  assert.equal(page.questionIds[1], ctx.def.questions[2].id, "the new question sits right after Q1 on the page");
  assert.ok(logOf(ctx).some((l) => l.startsWith("update:add ")), "a labelled edit");
  assert.equal(ctx.tab, "questions");
  assert.equal(ctx.questionId, ctx.def.questions[2].id);
});

test("question.duplicate is applicable only with a selection and produces a uniquely named copy", () => {
  const ctx = fakeCtx();
  const dup = builtinCommands().find((c) => c.id === "question.duplicate")!;
  assert.ok(!applicable([dup], ctx).length, "nothing selected → not offered");
  ctx.selectQuestion("q1");
  assert.ok(applicable([dup], ctx).length);
  dup.run(ctx);
  assert.equal(ctx.def.questions.length, 3);
  assert.equal(ctx.def.questions[2].code, "Q1_COPY");
  assert.equal(ctx.questionId, ctx.def.questions[2].id, "the copy becomes the selection");
});

test("flow.add.branch inserts before the End and opens Survey Flow", () => {
  const ctx = fakeCtx();
  builtinCommands().find((c) => c.id === "flow.add.branch")!.run(ctx);
  const types = ctx.def.flow.map((n) => n.type);
  assert.deepEqual(types, ["page", "branch", "end"]);
  assert.equal(ctx.tab, "flow");
});

test("logic.addDisplayRule targets the selected question and opens Logic", () => {
  const ctx = fakeCtx();
  ctx.selectQuestion("q2");
  builtinCommands().find((c) => c.id === "logic.addDisplayRule")!.run(ctx);
  assert.equal(ctx.def.displayRules.length, 1);
  assert.equal(ctx.def.displayRules[0].target.ref, "q2");
  assert.equal(ctx.tab, "logic");
});

test("edits are hidden in read-only; navigation and mode commands are not", () => {
  const ctx = fakeCtx({ readOnly: true });
  ctx.selectQuestion("q1");
  const ids = applicable(builtinCommands(), ctx).map((c) => c.id);
  assert.ok(!ids.includes("question.add") && !ids.includes("question.duplicate") && !ids.includes("block.add"));
  assert.ok(ids.includes("palette.open"));
  assert.ok(!ids.includes("survey.save"), "saving a version is a write");
});

test("mode commands offer only available modes other than the current one", () => {
  const ctx = fakeCtx();
  const ids = applicable(builtinCommands(), ctx).map((c) => c.id).filter((i) => i.startsWith("mode."));
  assert.deepEqual(ids, ["mode.grid", "mode.architect"], "in Studio, Grid and Architect are the other available modes");
  const inGrid = fakeCtx({ mode: "grid" });
  assert.deepEqual(applicable(builtinCommands(), inGrid).map((c) => c.id).filter((i) => i.startsWith("mode.")), ["mode.studio", "mode.architect"]);
});

test("navigation commands skip the current tab; find commands locate questions by code, variable and text", () => {
  const ctx = fakeCtx();
  const nav = applicable(navigationCommands(ctx.tabs), ctx);
  assert.deepEqual(nav.map((c) => c.id), ["nav.logic"]);
  const find = findCommands(ctx.def);
  const r = rank("city", find, (c) => [c.title, ...(c.keywords ?? [])]);
  assert.equal(r[0].item.id, "find.question.q2");
  r[0].item.run(ctx);
  assert.equal(ctx.questionId, "q2");
  assert.equal(ctx.tab, "questions");
});

test("every built-in id is unique and every shortcut is unique", () => {
  const cmds = builtinCommands();
  const ids = cmds.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate command ids");
  const keys = cmds.map((c) => c.shortcut).filter(Boolean) as string[];
  assert.equal(new Set(keys.map((k) => JSON.stringify(parseShortcut(k)))).size, keys.length, `two commands share a key: ${keys.join(", ")}`);
});
