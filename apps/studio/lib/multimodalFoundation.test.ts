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
  // every declared mode now has a renderer (Phase 4 delivered Intelligent),
  // so each one may be opened from the URL or from memory; the fallback
  // below is exercised by values that name no mode at all
  for (const m of MODES) assert.equal(m.available, true, `${m.id} has a renderer`);
  assert.equal(resolveInitialMode("?mode=intelligent", null), "intelligent");
  assert.equal(resolveInitialMode("?tab=logic", "intelligent"), "intelligent");
  assert.equal(resolveInitialMode("?mode=flow", null), "flow");
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
  assert.deepEqual(ids, ["mode.grid", "mode.architect", "mode.flow", "mode.intelligent"], "in Studio, the four other built modes are offered");
  const inGrid = fakeCtx({ mode: "grid" });
  assert.deepEqual(applicable(builtinCommands(), inGrid).map((c) => c.id).filter((i) => i.startsWith("mode.")), ["mode.studio", "mode.architect", "mode.flow", "mode.intelligent"]);
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

/* ------------------------------------------------------------ split + chooser (Phase 5) */

test("the split comes from the URL, then memory, never the same mode as the primary", async () => {
  const { resolveInitialSplit, withSplitInUrl, nextPair, shouldShowChooser } = await import("./programmingMode.ts");
  assert.equal(resolveInitialSplit("?mode=grid&split=flow", null, "grid"), "flow");
  assert.equal(resolveInitialSplit("?mode=grid&split=grid", "flow", "grid"), null, "a split of a mode with itself is refused, and memory does not rescue it");
  assert.equal(resolveInitialSplit("", "flow", "grid"), "flow", "memory when the URL says nothing");
  assert.equal(resolveInitialSplit("?mode=grid", "flow", "grid"), null, "a URL that names a mode but no split is a deliberate single view");
  assert.equal(resolveInitialSplit("?split=nonsense", "alsononsense", "studio"), null);
  assert.equal(withSplitInUrl("?mode=grid", "flow"), "?mode=grid&split=flow");
  assert.equal(withSplitInUrl("?mode=grid&split=flow", null), "?mode=grid");
  assert.equal(withSplitInUrl("", null), "");
  // pairs
  assert.deepEqual(nextPair({ mode: "grid", split: "flow" }, { mode: "flow" }), { mode: "flow", split: "grid" }, "choosing the secondary as primary swaps");
  assert.deepEqual(nextPair({ mode: "grid", split: "flow" }, { mode: "architect" }), { mode: "architect", split: "flow" }, "another primary keeps the split");
  assert.deepEqual(nextPair({ mode: "grid", split: "flow" }, { split: "grid" }), { mode: "grid", split: null }, "secondary = primary clears");
  assert.deepEqual(nextPair({ mode: "grid", split: null }, { split: "intelligent" }), { mode: "grid", split: "intelligent" });
  assert.deepEqual(nextPair({ mode: "grid", split: "flow" }, { split: null }), { mode: "grid", split: null });
  // chooser
  assert.equal(shouldShowChooser("", null, null), true, "first run, nothing asked, nothing remembered");
  assert.equal(shouldShowChooser("?mode=grid", null, null), false, "a shared link is an answer");
  assert.equal(shouldShowChooser("", "flow", null), false, "a remembered mode is an answer");
  assert.equal(shouldShowChooser("", null, "1"), false, "dismissed stays dismissed");
  assert.equal(shouldShowChooser("?tab=logic", "nonsense", null), true, "junk memory is no answer");
  assert.equal(shouldShowChooser("", null, null, { sandbox: true }), false, "the sandbox is not a first project");
  assert.equal(shouldShowChooser("?chooser=1", "grid", "1", { sandbox: true }), true, "?chooser=1 always asks");
});

test("split commands: offered for other modes when the window is wide enough; off only when split; the chooser reopens", () => {
  const split = (ctx: StudioCommandContext) => applicable(builtinCommands(), ctx).map((c) => c.id).filter((i) => i.startsWith("split.") || i === "mode.choose");
  const none = fakeCtx();
  assert.deepEqual(split(none), [], "no mode layer (setSplit absent): nothing offered");
  const log: string[] = [];
  const wide = fakeCtx({ mode: "grid", split: null, splitAllowed: true, setSplit(m) { log.push(`split:${m}`); }, openChooser() { log.push("chooser"); } });
  assert.deepEqual(split(wide), ["split.studio", "split.architect", "split.flow", "split.intelligent", "mode.choose"], "every other mode, no 'off' while single");
  const already = fakeCtx({ mode: "grid", split: "flow", splitAllowed: true, setSplit(m) { log.push(`split:${m}`); } });
  assert.deepEqual(split(already), ["split.studio", "split.architect", "split.intelligent", "split.off"], "the current partner is not offered again; off is");
  const narrow = fakeCtx({ mode: "grid", split: null, splitAllowed: false, setSplit(m) { log.push(`split:${m}`); } });
  assert.deepEqual(split(narrow), [], "too narrow: no split offered");
  const run = (ctx: StudioCommandContext, id: string) => builtinCommands().find((c) => c.id === id)!.run(ctx);
  run(wide, "split.flow"); run(already, "split.off"); run(wide, "mode.choose");
  assert.deepEqual(log, ["split:flow", "split:null", "chooser"]);
});

test("the permission model: five purposes, and a split keeps the properties panel when any pane wants it", async () => {
  const { MODE_CAPABILITIES, propertiesWanted, MODES } = await import("./programmingMode.ts");
  for (const m of MODES) assert.ok(MODE_CAPABILITIES[m.id], `${m.id} has capabilities`);
  assert.equal(MODE_CAPABILITIES.studio.edit, "full");
  assert.equal(MODE_CAPABILITIES.flow.create, false);
  assert.equal(MODE_CAPABILITIES.flow.edit, "none");
  assert.equal(MODE_CAPABILITIES.flow.opensInStudio, true);
  assert.equal(MODE_CAPABILITIES.architect.create, true);
  assert.equal(MODE_CAPABILITIES.grid.edit, "fields");
  assert.equal(MODE_CAPABILITIES.intelligent.edit, "proposals");
  assert.equal(propertiesWanted("studio", "intelligent"), true, "Studio beside Intelligent keeps its Properties (§1)");
  assert.equal(propertiesWanted("intelligent", "studio"), true, "either way round");
  assert.equal(propertiesWanted("grid", "flow"), true, "Grid selects rows and edits them in the panel");
  assert.equal(propertiesWanted("flow", "architect"), false, "neither wants it");
  assert.equal(propertiesWanted("flow", null), false);
  assert.equal(propertiesWanted("studio", null), true);
});

test("insertionPoint (round 2): after the selected question, at the end of a selected page, of a selected block's last page, else the last page", async () => {
  const { insertionPoint } = await import("./commands/builtins.ts");
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "t" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "a" }, { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", text: "b" }, { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "c" }],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2"] },
      { type: "block", id: "b1", title: "B", children: [{ type: "page", id: "p2", questionIds: [] }, { type: "page", id: "p3", questionIds: ["q3"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });
  assert.deepEqual(insertionPoint({ def, questionId: "q1", primary: "question:q1" }), { pageId: "p1", index: 1 });
  assert.deepEqual(insertionPoint({ def, questionId: null, primary: "flowNode:p1" }), { pageId: "p1", index: 2 });
  assert.deepEqual(insertionPoint({ def, questionId: null, primary: "flowNode:b1" }), { pageId: "p3", index: 1 }, "a block: its last page");
  assert.deepEqual(insertionPoint({ def, questionId: null, primary: "flowNode:e" }), {}, "an end: the default (last page)");
  assert.deepEqual(insertionPoint({ def, questionId: null, primary: null }), {});
});
