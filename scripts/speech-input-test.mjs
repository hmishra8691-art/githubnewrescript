/**
 * SPEECH INPUT — dictation on EVERY open text field, on by default (October 2026).
 *
 *   node scripts/speech-input-test.mjs      (studio :3000, runtime :3001)
 *
 * What is proven:
 *   STUDIO   the per-question switch ("allow dictation", Properties → State) is
 *            offered exactly where a field would take dictation (text, a choice
 *            with an Other box, a form with a text field — not numeric, not email),
 *            starts ON, and unticking stores `settings.speechInput: false`; the
 *            survey switch (Survey Settings) stores `deployment.speechInput: false`
 *            and removes the key again when re-ticked.
 *   RUNTIME  a mic on single-line, multi-line, the Other boxes and a form's text
 *            field — none on numeric, email, read-only, a form's email field;
 *            transcripts APPEND to typed text through the field's own onChange;
 *            manual edits after; interim results; not-allowed and no-speech give
 *            reasons; a browser without a recogniser shows no control; required /
 *            min-length still hold a dictated answer; the response state holds the
 *            edited final text under the question id, the `__other__<code>` key and
 *            the form's row key — and no extra key; per-question and per-survey
 *            opt-outs remove the mic.
 *
 * Headless Chromium has no working recogniser, so a fake `webkitSpeechRecognition`
 * is installed with `addInitScript`: the test emits results and errors itself.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab } from "./lib/nav.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const h = await openHarness();

/* a fake recogniser the test drives from outside via window.__speech (the instance last started) */
const FAKE = () => {
  class FakeRecognition {
    constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; this.onresult = null; this.onerror = null; this.onend = null; window.__speech = this; }
    start() { this.started = true; }
    stop() { this.started = false; this.onend && this.onend(); }
    abort() { this.started = false; }
    say(text, isFinal) { const r = [Object.assign([{ transcript: text }], { isFinal })]; this.onresult && this.onresult({ resultIndex: 0, results: r }); }
    fail(code) { this.onerror && this.onerror({ error: code }); this.onend && this.onend(); }
  }
  delete window.SpeechRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
};

const opts = (other) => [{ code: 1, label: "Apple", flags: [] }, { code: 2, label: "Pear", flags: [] }, { code: other, label: "Other", flags: ["other_specify"] }];
const Q = (id, type, over = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type, text: `Question ${id}`, ...over });
const baseDef = () => ({
  meta: { id: "sandbox", code: "SPEECH", title: "Speech everywhere", version: "1.0" },
  questions: [
    Q("q_line", "open_text", { variant: "text.single_line", validation: [{ kind: "required" }, { kind: "min_length", value: 12, message: "At least 12 characters, please." }] }),
    Q("q_multi", "long_text", { variant: "text.multi_line" }),
    Q("q_sel", "single_select", { options: opts(9) }),
    Q("q_msel", "multi_select", { options: opts(99) }),
    Q("q_form", "text_list", { rows: [{ code: "name", label: "Name", fieldType: "text", flags: [], validation: [] }, { code: "mail", label: "Email", fieldType: "email", flags: [], validation: [] }] }),
    Q("q_num", "numeric"),
    Q("q_mail", "open_text", { variant: "text.email", validation: [{ kind: "email" }] }),
    Q("q_ro", "open_text", { settings: { readOnly: true } }),
  ],
  flow: [{ type: "page", id: "p1", title: "Page 1", questionIds: ["q_line", "q_multi", "q_sel", "q_msel", "q_form", "q_num", "q_mail", "q_ro"] }, { type: "end", id: "e1", status: "complete" }],
});

/* ------------------------------------------------------------------ STUDIO */
console.log("\nSTUDIO — the switches");
await h.loadDef(baseDef());
const openQ = async (id) => {
  await h.goTab("Questions");
  const card = await h.page.waitForSelector(`[data-testid="qcard"][data-qid="${id}"]`);
  if (!/\bselected\b/.test(await card.getAttribute("class"))) await card.click();
  await h.page.waitForTimeout(250);
  const head = '[data-testid="psec-head-state"]';
  if (await h.page.$(head) && (await h.page.getAttribute(head, "aria-expanded")) !== "true") await h.page.click(head);
  await h.page.waitForTimeout(150);
};
const toggle = '[data-testid="speech-input-toggle"]';
for (const id of ["q_line", "q_multi", "q_sel", "q_form"]) {
  await openQ(id);
  assert.ok(await h.page.$(toggle), `${id} offers the switch`);
  assert.equal(await h.page.isChecked(toggle), true, `${id}: on by default`);
}
for (const id of ["q_num", "q_mail"]) {
  await openQ(id);
  assert.ok(!(await h.page.$(toggle)), `${id} has no field that takes dictation — no switch`);
}
ok("the per-question switch is offered on text, Other-box and form questions (on by default), not on numeric or email");
await openQ("q_multi");
await h.page.click(toggle);
await h.page.waitForTimeout(300);
let def = await h.readDef();
assert.equal(def.questions.find((q) => q.id === "q_multi").settings.speechInput, false);
assert.equal(def.questions.find((q) => q.id === "q_line").settings.speechInput, undefined, "nothing written on the others");
await openQ("q_multi");
await h.page.click(toggle);
await h.page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.questions.find((q) => q.id === "q_multi").settings.speechInput, undefined, "re-ticked: back to the default (key removed)");
ok("unticking stores settings.speechInput = false; re-ticking removes it");
await openTab(h.page, "Survey Settings");
await h.page.waitForSelector('[data-testid="survey-speech-input"]');
assert.equal(await h.page.isChecked('[data-testid="survey-speech-input"]'), true, "on by default");
await h.page.click('[data-testid="survey-speech-input"]');
await h.page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.deployment.speechInput, false);
await openQ("q_line");
assert.equal(await h.page.isDisabled(toggle), true, "a question's switch is moot while the survey's is off");
assert.ok(await h.page.$('[data-testid="speech-input-survey-off"]'), "…and says why");
await openTab(h.page, "Survey Settings");
await h.page.click('[data-testid="survey-speech-input"]');
await h.page.waitForTimeout(300);
def = await h.readDef();
assert.equal(def.deployment.speechInput, undefined, "re-ticked: the key is gone, the default applies");
ok("Survey Settings stores deployment.speechInput = false and removes it again");

/* ----------------------------------------------------------------- RUNTIME */
const open = async (definition, { fake = true } = {}) => {
  const pv = await h.browser.newPage({ viewport: { width: 1000, height: 1200 } });
  pv.on("pageerror", (e) => console.error("RUNTIME PAGE ERROR:", e.message));
  if (fake) await pv.addInitScript(FAKE);
  else await pv.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(pv, { definition });
  return pv;
};
const mic = (qid, field = "answer") => `[data-qid="${qid}"] [data-speech-field="${field}"] [data-testid="speech-toggle"]`;
const answers = (pv) => pv.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState.answers)));
const waitValue = async (pv, sel, want) => {
  await pv.waitForFunction(([s, w]) => document.querySelector(s)?.value === w, [sel, want], { timeout: 5000 }).catch(() => {});
  assert.equal(await pv.inputValue(sel), want);
};
const dictate = async (pv, sel, phrases) => {
  await pv.click(sel);
  await pv.waitForSelector(`${sel}[aria-pressed="true"]`);
  for (const [t, fin] of phrases) await pv.evaluate(([x, f]) => window.__speech.say(x, f), [t, fin]);
  await pv.click(sel);
  await pv.waitForSelector(`${sel}[aria-pressed="false"]`);
};

console.log("\nRUNTIME — where the microphone appears");
const pv = await open(baseDef());
for (const [qid, field] of [["q_line", "answer"], ["q_multi", "answer"], ["q_form", "field"]]) assert.ok(await pv.$(mic(qid, field)), `${qid}: a mic`);
assert.equal((await pv.$$('[data-qid="q_form"] [data-testid="speech-toggle"]')).length, 1, "the form's Name field has one, its Email field none");
for (const qid of ["q_num", "q_mail", "q_ro"]) assert.ok(!(await pv.$(`[data-qid="${qid}"] [data-testid="speech-toggle"]`)), `${qid}: no mic`);
assert.ok(!(await pv.$(mic("q_sel", "other"))), "the Other box (and its mic) appears only once Other is chosen");
ok("mic on single-line, multi-line and the form's text field; none on numeric, email, read-only or the form's email field");

console.log("\nRUNTIME — single-line: typed text, voice appended, edited by hand");
const line = '[data-qid="q_line"] input.rs-input';
await pv.fill(line, "I liked the");
await pv.click(mic("q_line"));
await pv.waitForSelector('[data-qid="q_line"] [data-testid="speech-interim"]');
assert.equal(await pv.evaluate(() => window.__speech.continuous && window.__speech.interimResults), true);
await pv.evaluate(() => window.__speech.say("packaging but", false));
assert.match(await pv.textContent('[data-qid="q_line"] [data-testid="speech-interim"]'), /packaging but/, "interim shown live");
assert.equal(await pv.inputValue(line), "I liked the", "…without touching the value");
await pv.evaluate(() => window.__speech.say("packaging but not the price", true));
await waitValue(pv, line, "I liked the packaging but not the price");
await pv.click(mic("q_line"));
await pv.fill(line, "I liked the packaging but not the delivery");
assert.equal((await answers(pv)).q_line, "I liked the packaging but not the delivery", "the edited final text is the answer");
ok("existing text + voice → appended; edited by hand afterwards; the state holds the edited text");

console.log("\nRUNTIME — multi-line");
const ta = '[data-qid="q_multi"] textarea';
await dictate(pv, mic("q_multi"), [["The checkout was quick.", true], ["Support answered in minutes.", true]]);
await waitValue(pv, ta, "The checkout was quick. Support answered in minutes.");
await pv.click(ta); await pv.press(ta, "End"); await pv.type(ta, " Thanks!");
await waitValue(pv, ta, "The checkout was quick. Support answered in minutes. Thanks!");
ok("multi-line: two phrases appended, then typed after");

console.log("\nRUNTIME — the Other boxes");
await pv.click('[data-qid="q_sel"] input[type=radio][value="9"]');
await pv.waitForSelector(mic("q_sel", "other"));
const otherSel = '[data-qid="q_sel"] [data-testid="rs-other-input"]';
await pv.fill(otherSel, "A local");
await dictate(pv, mic("q_sel", "other"), [["brand from Pune", true]]);
await waitValue(pv, otherSel, "A local brand from Pune");
assert.equal(await pv.isChecked('[data-qid="q_sel"] input[type=radio][value="9"]'), true, "the mic is not a click on the option");
await pv.click('[data-qid="q_msel"] input[type=checkbox][value="99"]');
await dictate(pv, mic("q_msel", "other"), [["Mango", true]]);
await waitValue(pv, '[data-qid="q_msel"] [data-testid="rs-other-input"]', "Mango");
assert.equal(await pv.isChecked('[data-qid="q_msel"] input[type=checkbox][value="99"]'), true);
ok("single- and multi-select Other boxes take dictation into their own box");

console.log("\nRUNTIME — a form's text field");
await dictate(pv, mic("q_form", "field"), [["Asha Rao", true]]);
await waitValue(pv, '[data-qid="q_form"] #q_form__f__name', "Asha Rao");
ok("form field dictated");

console.log("\nRUNTIME — the response state: right keys, edited text, nothing extra");
const a = await answers(pv);
assert.equal(a.q_line, "I liked the packaging but not the delivery");
assert.equal(a.q_multi, "The checkout was quick. Support answered in minutes. Thanks!");
assert.equal(a.q_sel, 9);
assert.equal(a["q_sel__other__9"], "A local brand from Pune");
assert.equal(a["q_msel__other__99"], "Mango");
assert.deepEqual(a.q_form, { name: "Asha Rao" });
assert.ok(!Object.keys(a).some((k) => /voice|speech|dictat/i.test(k)), `no extra keys: ${Object.keys(a).join(", ")}`);
ok(`answers under q_line, q_multi, q_sel__other__9, q_msel__other__99, q_form.name — keys: ${Object.keys(a).sort().join(", ")}`);

console.log("\nRUNTIME — errors explained");
await pv.click(mic("q_multi"));
await pv.evaluate(() => window.__speech.fail("not-allowed"));
await pv.waitForSelector('[data-qid="q_multi"] [data-testid="speech-reason"]');
assert.match(await pv.textContent('[data-qid="q_multi"] [data-testid="speech-reason"]'), /Microphone access was refused/);
assert.equal(await pv.getAttribute(mic("q_multi"), "aria-pressed"), "false");
await pv.click(mic("q_line"));
await pv.evaluate(() => window.__speech.fail("no-speech"));
await pv.waitForSelector('[data-qid="q_line"] [data-testid="speech-reason"]');
assert.match(await pv.textContent('[data-qid="q_line"] [data-testid="speech-reason"]'), /No speech was heard/);
assert.equal((await answers(pv)).q_line, "I liked the packaging but not the delivery", "a failed dictation changes nothing");
ok("permission denied and no-speech: readable reasons, button reset, answer untouched");
await pv.close();

console.log("\nRUNTIME — required / min length still hold a dictated answer");
{
  const d = baseDef();
  d.flow[0].questionIds = ["q_line"];
  const p2 = await open(d);
  await p2.click('[data-testid="rs-next"]');
  await p2.waitForSelector('[data-qid="q_line"] [data-testid="rs-errors"]');
  ok("required: empty → held");
  await dictate(p2, mic("q_line"), [["too short", true]]);
  await waitValue(p2, '[data-qid="q_line"] input.rs-input', "too short");
  await p2.click('[data-testid="rs-next"]');
  await p2.waitForTimeout(500);
  assert.match(await p2.textContent('[data-qid="q_line"] [data-testid="rs-errors"]'), /At least 12 characters/);
  ok("min length: a short dictated answer → held with the survey's message");
  await dictate(p2, mic("q_line"), [["but now it is long enough", true]]);
  await waitValue(p2, '[data-qid="q_line"] input.rs-input', "too short but now it is long enough");
  await p2.click('[data-testid="rs-next"]');
  await p2.waitForSelector('[data-testid="rs-ended"]');
  const fin = await answers(p2);
  assert.equal(fin.q_line, "too short but now it is long enough");
  assert.deepEqual(Object.keys(fin).filter((k) => k.startsWith("q_")), ["q_line"], "one key, the question's");
  ok("then accepted, and the survey completes with the dictated text as the answer");
  await p2.close();
}

console.log("\nRUNTIME — opt-outs and unsupported browsers");
{
  const d = baseDef();
  d.questions.find((q) => q.id === "q_line").settings = { speechInput: false };
  const p3 = await open(d);
  assert.ok(!(await p3.$('[data-qid="q_line"] [data-testid="speech-toggle"]')), "the opted-out question has none");
  assert.ok(await p3.$(mic("q_multi")), "…the others keep theirs");
  await p3.close();
  ok("per question: settings.speechInput = false removes its mic");
  const s = baseDef();
  s.deployment = { speechInput: false };
  s.questions.find((q) => q.id === "q_line").settings = { speechInput: true };
  const p4 = await open(s);
  await p4.click('[data-qid="q_sel"] input[type=radio][value="9"]');
  await p4.waitForSelector('[data-qid="q_sel"] [data-testid="rs-other-input"]');
  assert.equal((await p4.$$('[data-testid="speech-toggle"]')).length, 0, "no mic anywhere — not even on a question that opted in");
  await p4.close();
  ok("per survey: deployment.speechInput = false removes every mic");
  const p5 = await open(baseDef(), { fake: false });
  assert.equal((await p5.$$('[data-testid="speech-toggle"]')).length, 0, "no recogniser → no button, never one that fails");
  assert.ok(await p5.$('[data-qid="q_line"] input.rs-input'), "the fields themselves are untouched");
  await p5.close();
  ok("a browser without speech recognition shows no control");
}

await h.close();
console.log(`\nALL SPEECH INPUT CHECKS PASSED (${passed})`);
