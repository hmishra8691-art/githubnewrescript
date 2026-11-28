/**
 * P5, REUSABLE LIBRARIES — THE SCREEN (2026-11-27), in the sandbox editor.
 *
 * Insert from a library → "Linked from a library" and "Links here". The library route is answered in the browser by
 * the real engine functions the route calls (libraryItems, insertFromLibrary, libraryStatus, applyLibraryUpdate,
 * sourceDiff over toSource), over a library survey this script holds and changes from saved version 3 to 4. What is
 * tested is the screen and the editor round trip; the route's database and permission path is not (no database here).
 *
 *   1  a block inserted with a link: preview (notes, diff) first, then the copy and the link in the survey
 *   2  an option list into an existing question, with a link
 *   3  "Links here": both up to date
 *   4  the library saves version 4 (a wording change, an option removed) and a local question reads that option;
 *      a copied question is also edited here → "both", with the change, the broken rule and the overwrite named
 *   5  the update previewed, then applied through the editor: the new wording, the link up to date again
 *   6  the route always receives the editor's survey (unsaved edits included), never asks to apply on the server
 *
 *   AI_API_URL=fake: next dev -p 3000 (apps/studio), then   node scripts/library-links-browser.mjs
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applyLibraryUpdate, insertFromLibrary, libraryItems, libraryStatus, sourceDiff, toSource } from "../packages/engine/dist/index.js";

const LIB_ID = "22222222-2222-4222-8222-222222222222";
const opts5 = [1, 2, 3].map((c) => ({ code: String(c), label: ["Man", "Woman", "Another way"][c - 1] }));
const libraryV = (version) => SurveyDefinition.parse({
  meta: { id: "lib", code: "LIB", title: "Standard demographics", version: String(version) },
  questions: [
    { id: "q_age", code: "AGE", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q_gender", code: "GENDER", variableName: "GENDER", type: "single_select", text: version === 3 ? "Which describes you?" : "Which of these describes you best?", options: version === 3 ? opts5 : opts5.slice(0, 2) },
  ],
  flow: [{ type: "block", id: "b_demo", title: "Demographics", children: [{ type: "page", id: "p_demo", questionIds: ["q_age", "q_gender"] }] }, { type: "end", id: "e", status: "complete" }],
});
let library = { def: libraryV(3), version: "3" };

const h = await openHarness();
const page = h.page;
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const seen = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

await page.route("**/api/projects", (r) => json(r, { owned: [{ surveyId: LIB_ID, code: "LIB", title: "Standard demographics" }], workspace: [], shared: [] }));
await page.route("**/api/surveys/*/library", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  seen.push(body);
  if (body.action === "items") return json(route, { library: { id: body.library, title: library.def.meta.title, version: library.version }, items: libraryItems(library.def) });
  const def = body.definition ? SurveyDefinition.parse(body.definition) : null;
  if (!def) return json(route, { error: "the screen must send the editor's survey" }, 400);
  if (body.action === "status") return json(route, { links: libraryStatus(def, { [LIB_ID]: library }) });
  const result = body.action === "insert"
    ? insertFromLibrary(def, library.def, body.itemId, { library: { surveyId: body.library, title: library.def.meta.title }, version: library.version, after: body.after, into: body.into, now: new Date().toISOString() })
    : applyLibraryUpdate(def, body.linkId, library.def, library.version);
  if ("error" in result) return json(route, { ok: false, error: result.error }, 422);
  return json(route, { ok: true, notes: result.notes, diff: sourceDiff(toSource(def), toSource(result.def)), mode: "preview", definition: result.def, link: result.link });
});

await h.loadDef({
  meta: { id: "sandbox", code: "SANDBOX", title: "Library test", version: "1.0" },
  questions: [{ id: "q_s1", code: "S1", variableName: "S1", type: "single_select", text: "Your gender?", options: [{ code: "x", label: "Old option" }] }],
  flow: [{ type: "page", id: "p1", title: "Page 1", questionIds: ["q_s1"] }, { type: "end", id: "e1", status: "complete" }],
});

const openDialog = async (mode) => {
  await h.goTab("Questions");
  await page.waitForSelector('[data-testid="library-open"]', { timeout: 60000 });
  await page.locator('[data-testid="library-open"]').first().click();
  await page.waitForSelector('[data-testid="library-dialog"]');
  await page.click(`[data-testid="library-mode-${mode}"]`);
};

console.log("\n1  A BLOCK, INSERTED WITH A LINK");
await openDialog("linked");
await page.selectOption('[data-testid="library-linked-source"]', LIB_ID);
await page.waitForSelector('[data-testid="library-linked-items"]');
assert.match(await page.innerText('[data-testid="library-linked-version"]'), /Standard demographics · saved version 3/);
const itemText = await page.innerText('[data-testid="library-linked-items"]');
assert.match(itemText, /Blocks[\s\S]*Demographics[\s\S]*Questions[\s\S]*AGE[\s\S]*Option lists[\s\S]*GENDER options/);
assert.equal(await page.isDisabled('[data-testid="library-linked-insert"]'), true, "nothing to insert before an item is picked");
await page.click('[data-testid="library-linked-item"][data-item="b_demo"]');
await page.waitForSelector('[data-testid="library-linked-preview"]');
const pv = await page.innerText('[data-testid="library-linked-preview"]');
assert.match(pv, /Inserted the block “Demographics” \(2 questions\) from the library, version 3/);
assert.match(await page.innerText('[data-testid="library-diff"]'), /^\+.*AGE/m);
let def = null;
ok("the block previewed first: the note, and a diff adding AGE and GENDER");
await page.click('[data-testid="library-linked-insert"]');
await page.waitForTimeout(400);
def = await h.readDef();
assert.ok(def.questions.some((q) => q.code === "AGE") && def.questions.some((q) => q.code === "GENDER"), def.questions.map((q) => q.code).join(","));
assert.equal(def.libraryLinks?.length, 1);
assert.equal(def.libraryLinks[0].itemId, "b_demo");
assert.equal(String(def.libraryLinks[0].version), "3");
ok("inserted: AGE and GENDER in the survey, and one link (block b_demo, version 3)");

console.log("\n2  AN OPTION LIST INTO S1");
await openDialog("linked");
await page.selectOption('[data-testid="library-linked-source"]', LIB_ID);
await page.waitForSelector('[data-testid="library-linked-items"]');
await page.click('[data-testid="library-linked-item"][data-item="list:q_gender"]');
await page.waitForSelector('[data-testid="library-linked-into"]');
assert.equal(await page.isDisabled('[data-testid="library-linked-insert"]'), true, "a list needs a question to go into");
await page.selectOption('[data-testid="library-linked-into"]', "q_s1");
await page.waitForSelector('[data-testid="library-linked-preview"]');
assert.match(await page.innerText('[data-testid="library-linked-preview"]'), /S1 now has the library's 3 options/);
await page.click('[data-testid="library-linked-insert"]');
await page.waitForTimeout(400);
def = await h.readDef();
assert.deepEqual(def.questions.find((q) => q.code === "S1").options.map((o) => o.label), ["Man", "Woman", "Another way"]);
assert.equal(def.libraryLinks.length, 2);
ok("S1 has the library's three options, and a second link");

console.log("\n3  LINKS HERE: UP TO DATE");
await openDialog("links");
assert.match(await page.innerText('[data-testid="library-mode-links"]'), /Links here \(2\)/);
await page.waitForSelector('[data-testid="library-link"]');
let states = await page.$$eval('[data-testid="library-link"]', (els) => els.map((e) => e.getAttribute("data-state")));
assert.deepEqual(states, ["up_to_date", "up_to_date"]);
assert.equal(await page.locator('[data-testid="library-link-preview"]').count(), 0, "nothing to update");
ok("both links up to date with version 3; no update offered");
await page.keyboard.press("Escape").catch(() => {});
await page.click('[data-testid="library-dialog"] button:has-text("Close")');

console.log("\n4  THE LIBRARY SAVES VERSION 4");
library = { def: libraryV(4), version: "4" };
def = await h.readDef();
const genderId = def.questions.find((q) => q.code === "GENDER").id;
const age = def.questions.find((q) => q.code === "AGE");
age.text = "Your age in years (edited here)";
def.questions.push({ id: "q_dep", code: "DEP", variableName: "DEP", type: "open_text", text: "Tell us more", displayLogic: { type: "rule", source: { kind: "question", ref: genderId }, operator: "eq", value: "3" } });
def.flow.splice(def.flow.length - 1, 0, { type: "page", id: "p_dep", questionIds: ["q_dep"] });
await h.loadDef(def);
await openDialog("links");
await page.waitForSelector('[data-testid="library-link"]');
states = await page.$$eval('[data-testid="library-link"]', (els) => els.map((e) => e.getAttribute("data-state")));
assert.deepEqual(states, ["both", "update_available"], states.join(","));
const block = page.locator('[data-testid="library-link"][data-state="both"]');
const blockText = await block.innerText();
assert.match(blockText, /Update available · edited here/);
assert.match(blockText, /Version 4 is available, and this copy was also edited here/);
assert.match(blockText, /GENDER: wording; options removed: 3/);
assert.match(blockText, /DEP's display logic reads option 3 of GENDER, which the update removes/);
assert.match(blockText, /Would overwrite edits made here to: AGE/);
ok("the block: \"both\" — the wording change, the removed option, DEP's rule it breaks, and the AGE edit it would overwrite");
assert.match(await page.locator('[data-testid="library-link"][data-state="update_available"]').innerText(), /S1: options removed: 3/);
ok("the list: update available, option 3 removed from S1");
if (process.env.SHOTS) await page.locator('[data-testid="library-dialog"]').screenshot({ path: `${process.env.SHOTS}/library-links.png` });

console.log("\n5  THE UPDATE PREVIEWED, THEN APPLIED");
await block.locator('[data-testid="library-link-preview"]').click();
await block.locator('[data-testid="library-linked-preview"]').waitFor();
assert.match(await block.locator('[data-testid="library-diff"]').innerText(), /Which of these describes you best\?/);
ok("the update previewed: the diff shows version 4's wording; nothing applied yet");
await block.locator('[data-testid="library-link-apply"]').click();
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="library-link"]')].map((e) => e.getAttribute("data-state")).join(",") === "up_to_date,update_available", null, { timeout: 15000 });
ok("applied: the block's link is up to date with version 4; the list still offers its update");
await page.click('[data-testid="library-dialog"] button:has-text("Close")');
def = await h.readDef();
assert.equal(def.questions.find((q) => q.code === "GENDER").text, "Which of these describes you best?");
assert.deepEqual(def.questions.find((q) => q.code === "GENDER").options.map((o) => o.code), ["1", "2"]);
assert.equal(def.questions.find((q) => q.code === "AGE").text, "How old are you?", "the local edit was overwritten, as the screen said");
assert.equal(String(def.libraryLinks.find((l) => l.itemId === "b_demo").version), "4");
ok("the survey has version 4's wording and options; AGE back to the library's text; the link records version 4");

console.log("\n6  WHAT THE ROUTE WAS SENT");
assert.ok(seen.filter((b) => b.action !== "items").every((b) => b.definition && b.apply !== true), "every preview carried the editor's survey; none asked the server to save");
const lastStatus = seen.filter((b) => b.action === "status")[0];
assert.ok(lastStatus.definition.libraryLinks.length === 2);
ok(`${seen.length} route calls: each preview sent the editor's survey and none asked the server to save`);

assert.deepEqual(errors, [], errors.join("\n"));
ok("no page errors");
console.log(`\n${passed} checks passed`);
await h.browser?.close?.();
process.exit(0);
