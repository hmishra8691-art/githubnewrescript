import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys, type SurveyAction } from "./surveyActions.js";
import { checkDeclarations, compileUxCss, parseUxTargetString, resolveUxTarget, reviewUx, scopeCss, uxFullSelector, validateUxScript, uxContextFor, lexJs, evaluateUxTriggers, uxSelectedCodes } from "./ux.js";
import { listBlocks, listPages } from "./blocks.js";

/**
 * THE UX LAYER: styles, animations and behaviours as validated data — scoped
 * to one survey, by stable ids, never able to change the survey itself.
 */
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const base = (): SurveyDefinition => {
  const empty = SurveyDefinition.parse({ meta: { id: "srv-1", code: "S", title: "UX" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", ref: "B1", title: "Screening" },
    { op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?" },
    { op: "create_question", ref: "GENDER", type: "single", text: "Gender?", options: ["Woman", "Man", { label: "Other", other: true }] },
    { op: "create_block", ref: "B2", title: "Brand" },
    { op: "create_question", ref: "FAV", type: "single", text: "Favourite brand?", options: ["Alpha", "Beta", "Gamma", { label: "Other", other: true }] },
    { op: "create_question", ref: "WHY", type: "long_text", text: "Why?", newPage: true },
  ] as SurveyAction[], { ids, now: "2026-09-28T00:00:00Z" });
  assert.equal(r.valid, true, r.errors.join("\n"));
  return r.def;
};
const q = (d: SurveyDefinition, code: string) => d.questions.find((x) => x.code === code)!;
const ux = (d: SurveyDefinition, actions: unknown[], opts: { uxOnly?: boolean } = {}) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  return applySurveyActions(d, c.actions, { ids, now: "2026-09-28T00:00:00Z", ...opts });
};

test("targets: one grammar for actions and scripts, resolved to stable ids", () => {
  const d = base();
  const fav = q(d, "Q3"), blocks = listBlocks(d.flow as unknown[]), pages = listPages(d.flow as unknown[]);
  assert.deepEqual(resolveUxTarget(d, "Q3.options"), { kind: "option", questionId: fav.id });
  const otherCode = String(fav.options.find((o) => o.label === "Other")!.code);
  assert.deepEqual(resolveUxTarget(d, "Q3.option:Other"), { kind: "option", questionId: fav.id, code: otherCode }, "an option by its label");
  assert.deepEqual(resolveUxTarget(d, "Q3.option:2"), { kind: "option", questionId: fav.id, code: "2" });
  assert.deepEqual(resolveUxTarget(d, "Q3.option:beta"), { kind: "option", questionId: fav.id, code: "2" }, "an option by its label, any case");
  assert.deepEqual(resolveUxTarget(d, "Q3.other"), { kind: "question", questionId: fav.id, part: "other_text" });
  assert.deepEqual(resolveUxTarget(d, "block:Brand.questions"), { kind: "question", blockId: blocks[1].id });
  assert.deepEqual(resolveUxTarget(d, "block:2"), { kind: "block", blockId: blocks[1].id });
  assert.deepEqual(resolveUxTarget(d, { kind: "page", page: 3 }), { kind: "page", pageId: pages[2].node.id });
  assert.deepEqual(resolveUxTarget(d, "next"), { kind: "button", button: "next" });
  assert.deepEqual(resolveUxTarget(d, "progress.fill"), { kind: "progress", part: "fill" });
  assert.match(String(resolveUxTarget(d, "Q9")), /no question “Q9”/);
  assert.match(String(resolveUxTarget(d, "Q3.option:Delta")), /Q3 has no option “Delta”/);
  assert.match(String(resolveUxTarget(d, "page:9")), /no page “9”/);
  assert.match(String(resolveUxTarget(d, { kind: "question", question: "Q3", selector: "body .x" })), /outside the survey/);
  assert.equal(parseUxTargetString("Q3.nonsense"), null);
  // the selector is the renderer's own anchors under the survey's own attribute
  assert.equal(uxFullSelector(d, { kind: "option", questionId: fav.id, code: "2" }, { state: "hover" }), `[data-rs-ux="srv-1"] [data-rs-el="question"][data-rs-id="${fav.id}"] [data-rs-el="option"][data-rs-id="2"]:hover`);
  assert.equal(uxFullSelector(d, { kind: "question", blockId: blocks[1].id }), `[data-rs-ux="srv-1"][data-rs-block="${blocks[1].id}"] [data-rs-el="question"]`);
  assert.equal(uxFullSelector(d, { kind: "button", button: "next" }), `[data-rs-ux="srv-1"] :is([data-rs-button="next"],[data-rs-button="submit"])`);
});

test("the CSS gate: nothing that escapes a declaration, runs code or loads from anywhere", () => {
  const c = checkDeclarations({ borderRadius: "12px", "box-shadow": "0 2px 8px rgba(0,0,0,.1)", background: "url(https://cdn.example/x.png)", color: "red}body{color:blue", width: "expression(alert(1))", "-moz-binding": "url(x)", "background-image": "url(javascript:alert(1))", margin: "1px \\7d", "--rs-ux-accent": "#08f", "font weight": "bold" });
  assert.deepEqual(Object.keys(c.ok), ["border-radius", "box-shadow", "background", "--rs-ux-accent"]);
  assert.equal(c.errors.length, 6, c.errors.join("\n"));
  for (const bad of ["url(http://evil.example/x.png)", "url(data:text/html;base64,PHNjcmlwdD4=)", "url(//evil.example/x)"]) assert.match(checkDeclarations({ background: bad }).errors.join(" "), /url\(\) may only load https/, bad);
  assert.deepEqual(checkDeclarations({ background: "url(data:image/png;base64,iVBORw0KGgo=)" }).errors, [], "an inline image is fine");
  const w = checkDeclarations({ display: "none", position: "fixed", "z-index": "99999", width: "900px", color: "red !important" }, { target: { kind: "question", questionId: "q" } });
  assert.equal(w.errors.length, 0);
  for (const re of [/still asked and validated/, /position: fixed/, /z-index/, /wider than a phone/, /!important/]) assert.ok(w.warnings.some((x) => re.test(x)), `${re} in ${w.warnings.join(" | ")}`);
});

test("scoped CSS text: every selector under the target, keyframes namespaced, phone rules answer the device preview", () => {
  const d = base();
  const t = { kind: "option" as const, questionId: q(d, "Q3").id };
  const sel = uxFullSelector(d, t);
  const r = scopeCss(d, t, `/* cards */
    & { border-radius: 14px; animation: glow 1s }
    & input[type=radio] { position: absolute; opacity: 0 }
    @media (max-width: 640px) { & { width: 100% } }
    @keyframes glow { from { opacity: .6 } to { opacity: 1 } }
    .label, span { font-weight: 600 }`, "uxs_9");
  assert.deepEqual(r.errors, []);
  assert.ok(r.css.includes(`${sel}{border-radius:14px;animation:rs-ux-k-uxs_9-glow 1s}`), r.css);
  assert.ok(r.css.includes(`${sel} input[type=radio]{position:absolute;opacity:0}`));
  assert.ok(r.css.includes(`@media (max-width: 640px){${sel}{width:100%}}`));
  assert.ok(r.css.includes(`.rs-viewport.mobile > ${sel}{width:100%}`), "hoisted outside the @media for the device preview");
  assert.ok(r.css.includes("@keyframes rs-ux-k-uxs_9-glow{from{opacity:.6}to{opacity:1}}"));
  assert.ok(r.css.includes(`${sel} .label,${sel} span{font-weight:600}`), "a selector list is scoped item by item");
  const bad = scopeCss(d, t, `body { background: red } @import url(https://x); & + .x { color: red } @font-face { font-family: x } .a { color: red`, "s");
  assert.equal(bad.css, "", "nothing half-applied");
  const bad2 = scopeCss(d, t, `:root { --x: 1 } & ~ p { color: red } @font-face { font-family: x }`, "s");
  assert.ok(bad2.errors.some((e) => /outside the survey/.test(e)) && bad2.errors.some((e) => /beside the target/.test(e)) && bad2.errors.some((e) => /@font-face is not allowed/.test(e)), bad2.errors.join("\n"));
  assert.match(bad.errors.join(" "), /does not parse|not closed/);
  assert.match(scopeCss(d, t, ".a { .b { color: red } }", "s").errors.join(" "), /nested rules/);
});

test("UX actions: styles, animations and behaviours as data — validated, described, reversible, the structure untouched", () => {
  const d = base();
  const fav = q(d, "Q3");
  const r = ux(d, [
    { op: "create_style", ref: "CARDS", label: "Q3 option cards", target: "Q3.options", rules: [
      { declarations: { borderRadius: "14px", padding: "14px 16px", boxShadow: "0 1px 3px rgba(0,0,0,.12)" } },
      { state: "hover", declarations: { transform: "translateY(-2px)" } },
      { state: "selected", declarations: { borderColor: "var(--rs-primary)" } },
      { selector: "input[type=radio]", declarations: { position: "absolute", opacity: "0" } },
      { media: "mobile", declarations: { width: "100%" } },
    ] },
    { op: "create_animation", label: "Selected pop", target: "Q3.options", preset: "pop", trigger: "select", duration: "0.25s" },
    { op: "create_animation", label: "Other expands", target: "Q3.other", preset: "expand", trigger: "appear" },
    { op: "create_animation", label: "Brand one at a time", target: "block:Brand.questions", preset: "fade-up", stagger: 150 },
    { op: "attach_behavior_to_question", label: "Nudge Next", target: "Q3", on: "answer", effects: [{ do: "animate", target: "next", preset: "pulse" }] },
    { op: "create_behavior", label: "Why Other", target: "Q3", on: "select", options: ["Other"], effects: [{ do: "show_message", text: "Tell us which brand in the box." }] },
    { op: "create_responsive_rule", target: "Q3.options", media: "mobile", declarations: { fontSize: "15px" } },
    { op: "create_style", label: "Premium progress", target: "progress.fill", declarations: { transition: "width 600ms ease" } },
  ], { uxOnly: true });
  assert.equal(r.valid, true); assert.deepEqual(r.errors, []);
  assert.equal(r.uxOnly, true); assert.equal(r.structureUnchanged, true, "UX-only: the structure is provably identical");
  const u = r.def.ux!;
  assert.equal(u.styles.length, 3); assert.equal(u.animations.length, 3); assert.equal(u.behaviors.length, 2);
  assert.equal(u.animations[0].durationMs, 250, "“0.25s” read as 250ms");
  assert.deepEqual(u.behaviors[1].options, [String(fav.options.find((o) => o.label === "Other")!.code)], "“Other” resolved to its code");
  assert.equal(u.styles[2].target.kind, "progress");
  assert.deepEqual(r.def.questions, d.questions, "no question changed");
  assert.match(r.results[0].description, /Style “Q3 option cards” on Q3 options \(5 rules, mobile\)/);
  assert.match(r.results[3].description, /one at a time \(150ms apart\)/);
  assert.match(r.results[4].description, /when answered on Q3 → animate the Next button \(pulse\)/);
  const css = compileUxCss(r.def);
  const opt = uxFullSelector(r.def, { kind: "option", questionId: fav.id });
  assert.ok(css.includes("@keyframes rs-ux-pop{") && css.includes("@keyframes rs-ux-pulse{") && css.includes("@keyframes rs-ux-fade-up{"), "only the presets in use, once each");
  assert.ok(css.includes(`${opt}:is(.selected,[aria-checked="true"],[aria-selected="true"],:has(input:checked)){border-color:var(--rs-primary)}`));
  assert.ok(css.includes(`@media (prefers-reduced-motion: no-preference){${opt}:is(.selected`), "motion only for respondents who have not asked to reduce it");
  assert.ok(css.includes("animation:rs-ux-fade-up 400ms ease-out calc(var(--rs-ux-i, 0) * 150ms + 0ms) 1 both"), "stagger by index");
  assert.ok(css.includes(`.rs-viewport.mobile > ${opt}{width:100%}`));
  // the diff names each item
  const diff = diffSurveys(d, r.def);
  assert.ok(diff.summary.includes("Add style “Q3 option cards” on Q3 options"), diff.summary.join("\n"));
  assert.equal(diff.questionsModified.length, 0);
  // modify the existing instead of adding a second: slower, and the same rule changed rather than joined
  const r2 = ux(r.def, [
    { op: "update_animation", id: "Brand one at a time", duration: 900 },
    { op: "update_style", id: u.styles[0].id, state: "hover", declarations: { transform: "translateY(-4px)" } },
  ]);
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.def.ux!.animations[2].durationMs, 900);
  assert.equal(r2.def.ux!.styles[0].rules.filter((x) => x.state === "hover").length, 1);
  assert.equal(r2.def.ux!.styles[0].rules.find((x) => x.state === "hover")!.declarations.transform, "translateY(-4px)");
  assert.match(r2.results[0].description, /400ms → 900ms/);
  // removing is destructive (asks first) and reversible (the old definition is the undo)
  const r3 = ux(r2.def, [{ op: "remove_behavior", id: "Nudge Next" }, { op: "remove_animation", id: "Selected pop" }, { op: "remove_style", id: "Premium progress" }]);
  assert.deepEqual(r3.errors, []);
  assert.equal(r3.destructive.length, 3); assert.match(r3.destructive[0], /Removes the behaviour “Nudge Next”/);
  assert.match(r3.destructive[1], /Removes the animation “Selected pop” \(Q3 options\)/); assert.match(r3.destructive[2], /Removes the style “Premium progress” \(the progress bar fill\)/);
  assert.equal(r3.def.ux!.behaviors.length, 1);
});

test("the UX-only guard refuses structure, and every bad item is refused with its reason", () => {
  const d = base();
  const r = ux(d, [
    { op: "update_question", target: "Q3", text: "Changed" },
    { op: "create_style", label: "Global", target: "Q3", css: "body { color: red }" },
    { op: "create_style", label: "Bad value", target: "Q3", declarations: { background: "url(javascript:x)" } },
    { op: "create_animation", label: "Nope", target: "Q3", preset: "explode" },
    { op: "create_behavior", label: "No option", target: "Q3", on: "select_option", options: ["Zeta"], effects: [{ do: "add_class", className: "x" }] },
    { op: "create_behavior", label: "No class", target: "Q3", on: "answer", effects: [{ do: "add_class" }] },
    { op: "create_behavior", label: "No question", target: "next", on: "answer", effects: [{ do: "animate", preset: "pulse" }] },
    { op: "remove_style", id: "missing" },
    { op: "create_behavior", label: "No text", target: "Q3", on: "answer", effects: [{ do: "show_message" }] },
    { op: "create_style", label: "Fine", target: "Q3.title", declarations: { fontSize: "22px" } },
  ], { uxOnly: true });
  const e = r.errors.join("\n");
  assert.match(e, /Change Q3: this request is about the look and behaviour only/);
  assert.match(e, /reaches outside the survey/);
  assert.match(e, /background: url\(\) may only load https/);
  assert.match(e, /“explode” is not a preset/);
  assert.match(e, /Q3 has no option “Zeta”/);
  assert.match(e, /needs a className/);
  assert.match(e, /answer needs a question to listen to/);
  assert.match(e, /there is no style “missing”/);
  assert.match(e, /“No text” effect 1 \(show_message\) needs text/);
  assert.equal(r.def.ux!.styles.length, 1, "only the valid item is kept");
  assert.equal(q(r.def, "Q3").text, "Favourite brand?");
  assert.equal(r.structureUnchanged, true);
  // without the guard the same batch changes the structure, and says so
  const free = ux(d, [{ op: "update_question", target: "Q3", text: "Changed" }, { op: "create_style", label: "Fine", target: "Q3.title", declarations: { fontSize: "22px" } }]);
  assert.equal(free.structureUnchanged, false); assert.equal(free.uxOnly, false);
});

test("scripts: the rs api only — no loops, no network, no page, targets that exist", () => {
  const d = base();
  const ok = validateUxScript(`rs.listen("select", "Q3", (e) => { if (e.value == 99) rs.showMessage("Q3", "Which one?"); else rs.hideMessage("Q3"); });
    rs.listen("answer", "Q1", () => rs.animate("next", "pulse"));
    const a = rs.getAnswer("Q1"); // "for" in a comment and "while" in a string are fine: "while"`, d);
  assert.deepEqual(ok.errors, []); assert.deepEqual(ok.warnings, []);
  const bad = validateUxScript(`for (;;) {} while (true) {} fetch("https://x"); document.cookie; window.parent.postMessage(1); rs.explode("Q3"); rs.addClass("Q9", "x"); rs.getAnswer("Q77"); rs.listen("tap", "Q3", () => 1);`, d);
  const e = bad.errors.join("\n");
  for (const re of [/“for” loops/, /“while” loops/, /fetch is not available/, /document is not available/, /window is not available/, /postMessage is not available/, /rs.explode is not part/, /rs.addClass\("Q9"/, /rs.getAnswer\("Q77"\)/, /rs.listen\("tap"\)/]) assert.match(e, re);
  assert.match(validateUxScript(`rs.addClass("Q3", "x"`, d).errors.join(" "), /does not parse/);
  const dup = validateUxScript(`rs.listen("select", "Q3", () => {}); rs.listen("select", "Q3", () => {});`, d);
  assert.match(dup.warnings.join(" "), /registered twice/);
  assert.match(validateUxScript(`const x = 1;`, d).warnings.join(" "), /never calls the rs api/);
  assert.match(validateUxScript(`(()=>{}).constructor("return this")()`, d).errors.join(" "), /constructor is not available/);
  // a script behaviour through the action layer
  const r = ux(d, [{ op: "create_behavior", label: "Other message", target: "Q3", script: `rs.listen("select", "self", (e) => rs.showMessage("self", "Thanks"));` }]);
  assert.deepEqual(r.errors, []);
  const r2 = ux(d, [{ op: "create_behavior", label: "Loop", target: "Q3", script: `while(1){}` }]);
  assert.match(r2.errors.join(" "), /loops are not allowed/);
  assert.equal(lexJs(`a("x\\"y") // c`).strings[0].value, 'x"y');
});

test("the UX review: dead targets, conflicts, duplicate animations, theme overrides, phone traps, global branding CSS", () => {
  const d = base();
  const r = ux(d, [
    { op: "create_style", label: "Cards A", target: "Q3.options", declarations: { borderRadius: "12px", display: "inline-flex" } },
    { op: "create_style", label: "Cards B", target: "Q3.options", declarations: { borderRadius: "4px" } },
    { op: "create_animation", label: "Fade 1", target: "Q2", preset: "fade-in" },
    { op: "create_animation", label: "Fade 2", target: "Q2", preset: "fade-up" },
    { op: "create_style", label: "Brand buttons", target: "next", declarations: { background: "#111" } },
    { op: "create_style", label: "About Q4", target: "Q4.title", declarations: { color: "#333" } },
  ]);
  assert.deepEqual(r.errors, []);
  const gone = structuredClone(r.def);
  gone.questions = gone.questions.filter((x) => x.code !== "Q4");
  gone.branding.customCss = "body { margin: 0 }";
  // edited by hand: a behaviour with nothing to listen for
  gone.ux!.behaviors.push({ id: "uxb_hand", label: "Hand-made", target: { kind: "question", questionId: q(gone, "Q3").id }, effects: [{ do: "animate", preset: "pulse" }] });
  const f = reviewUx(gone);
  const m = f.map((x) => `${x.level}: ${x.message}`).join("\n");
  assert.match(m, /warning: Style “About Q4” does nothing: its question no longer exists/);
  assert.equal(f.find((x) => /About Q4/.test(x.message))!.fix!.op, "remove_style", "a mechanical fix");
  assert.match(m, /“Cards A” and “Cards B” both set border-radius on Q3 options \(12px vs 4px\)/);
  assert.match(m, /“Fade 1” and “Fade 2” both animate Q2 on appear/);
  assert.match(m, /overrides the theme's button style/);
  assert.match(m, /Q3 is styled with options side by side and has no phone rule/);
  assert.match(m, /custom CSS \(Branding\) styles html, body or :root/);
  assert.match(m, /critical: “Hand-made” needs an event \(on\) or a script/);
  // and the copilot's view of one question
  const ctx = uxContextFor(r.def, q(r.def, "Q3").id).join("\n");
  assert.match(ctx, /layout: auto, 4 options, has Other/);
  assert.match(ctx, /style uxs_\d+ “Cards A” on Q3 options: base \{border-radius:12px; display:inline-flex\}/);
});

test("runtime triggers: momentary events fire, conditions hold and release, once runs once", () => {
  const d0 = base();
  const blocks = listBlocks(d0.flow as unknown[]);
  const r = ux(d0, [
    { op: "create_behavior", label: "A", target: "Q3", on: "answer", effects: [{ do: "animate", preset: "pulse" }] },
    { op: "create_behavior", label: "S", target: "Q3", on: "select_option", options: ["2"], effects: [{ do: "add_class", className: "two" }] },
    { op: "create_behavior", label: "D", target: "Q3", on: "deselect_option", options: ["2"], effects: [{ do: "animate", preset: "shake" }] },
    { op: "create_behavior", label: "P", target: "survey", on: "page_complete", effects: [{ do: "animate", target: "next", preset: "glow" }] },
    { op: "create_behavior", label: "B", target: "block:Brand", on: "block_complete", effects: [{ do: "show_message", text: "Done!" }] },
    { op: "create_behavior", label: "E", target: "Q3", on: "page_enter", once: true, effects: [{ do: "animate", preset: "fade-in" }] },
  ]);
  assert.deepEqual(r.errors, []);
  const d = r.def;
  const fav = q(d, "Q3").id, why = q(d, "Q4").id;
  const run = (prev: Record<string, unknown> | null, now: Record<string, unknown>, active: string[] = [], fired: string[] = [], shown = [fav], blockId = blocks[1].id) => {
    const o = evaluateUxTriggers({ def: d, prev, now, shown, blockId, active: new Set(active.map((l) => d.ux!.behaviors.find((b) => b.label === l)!.id)), fired: new Set(fired.map((l) => d.ux!.behaviors.find((b) => b.label === l)!.id)) });
    const names = (xs: { label: string }[]) => xs.map((x) => x.label).sort().join(",");
    return { fire: names(o.fire), hold: names(o.hold), release: names(o.release) };
  };
  assert.deepEqual(run(null, {}), { fire: "E", hold: "", release: "" }, "the page opens: page_enter, nothing else");
  assert.deepEqual(run(null, {}, [], ["E"]), { fire: "", hold: "", release: "" }, "once");
  assert.deepEqual(run({}, { [fav]: 1 }), { fire: "A", hold: "B,P", release: "" }, "answered: A fires; the page and its block are complete");
  assert.deepEqual(run({ [fav]: 1 }, { [fav]: 2 }, ["B", "P"]), { fire: "A", hold: "S", release: "" }, "option 2 chosen: S holds");
  assert.deepEqual(run({ [fav]: 2 }, { [fav]: 1 }, ["B", "P", "S"]), { fire: "A,D", hold: "", release: "S" }, "option 2 unchosen: S released, D fires");
  assert.deepEqual(run({ [fav]: 1 }, {}, ["B", "P"]), { fire: "", hold: "", release: "B,P" }, "cleared: no longer complete");
  assert.deepEqual(run({}, { [fav]: 1 }, [], [], [fav], blocks[0].id), { fire: "A", hold: "P", release: "" }, "block_complete only in its own block");
  assert.deepEqual(run({}, { [why]: "x" }, [], [], [why]), { fire: "", hold: "B,P", release: "" }, "a behaviour on a question not on the page does nothing (A, S, D stay quiet); the page and its block's page are complete");
  assert.deepEqual([...uxSelectedCodes({ r1: 2, r2: [3, 4] })].sort(), ["2", "3", "4"], "a grid's codes");
});
