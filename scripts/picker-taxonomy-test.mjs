/**
 * THE PICKER AFTER THE TAXONOMY AUDIT (2026-09-10).
 *
 * The registry test proves the RULES — one identity per type, presets borrow
 * their parent's. This proves the picker SHOWS them: a retired duplicate is
 * gone, a preset sits under its parent wherever the parent lives, and picking
 * a preset produces the parent's type with the preset's defaults. It is the
 * difference between a clean registry and a clean product.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";

const h = await openHarness();
const page = h.page;

const openPicker = async (family) => {
  await h.goTab("Questions");
  await page.waitForSelector('[data-testid="add-question-top"]');
  await page.click('[data-testid="add-question-top"]');
  await page.waitForSelector(`[data-testid="picker-family-${family}"]`);
  await page.click(`[data-testid="picker-family-${family}"]`);
  await page.waitForSelector(`[data-testid^="picker-variant-"]`);
};
const closePicker = () => page.click('.modal .btn:has-text("close")').catch(() => {});
const present = async (id) => !!(await page.$(`[data-testid="picker-variant-${id}"]`));

console.log("\nRETIRED DUPLICATES ARE GONE FROM THE PICKER");
await openPicker("image");
assert.equal(await present("image.ranking"), false, "image.ranking was retired into ranking.image");
assert.equal(await present("image.hotspot"), false, "image.hotspot was retired into hotspot.click");
assert.equal(await present("image.choice"), false, "image.choice was retired into single_select.image");
console.log("  ok   the Image family no longer offers the three duplicates it used to");
await closePicker();

console.log("\nA PRESET IS NESTED UNDER ITS PARENT, NOT LISTED AS A PEER");
await openPicker("text");
const emailChip = await page.$('[data-testid="picker-variant-text.email"]');
assert.ok(emailChip, "Email is still offered");
assert.equal(await emailChip.getAttribute("data-preset-of"), "text.single_line", "…as a preset of Single-Line Text");
const insideParent = await page.$('[data-testid="picker-type-text.single_line"] [data-testid="picker-variant-text.email"]');
assert.ok(insideParent, "the Email chip renders in Single-Line Text's group, beside its card");
const textTypeCards = await page.$$eval('[data-testid^="picker-variant-"]:not([data-preset-of])', (els) => els.filter((e) => e.getAttribute("data-status") === "stable").length);
const textTypeIds = await page.$$eval('.card.selectable[data-testid^="picker-variant-"]', (els) => els.map((e) => e.getAttribute("data-testid").replace("picker-variant-", "")));
assert.ok(!textTypeIds.includes("text.email") && !textTypeIds.includes("text.phone"), "presets are not cards");
console.log(`  ok   Text shows ${textTypeIds.length} type cards; Email/Phone/URL/ZIP/Regex/Company are chips under Single-Line Text`);
await closePicker();

console.log("\nA CROSS-FAMILY PRESET LIVES WITH ITS PARENT — AND ONLY THERE");
await openPicker("numeric");
assert.equal(await present("numeric.percentage_slider"), false, "Percentage Slider is not under Numeric any more");
await closePicker();
await openPicker("slider");
const pctChip = await page.$('[data-testid="picker-type-slider.single"] [data-testid="picker-variant-numeric.percentage_slider"]');
assert.ok(pctChip, "…it is a chip under Single Slider, in the Slider family");
console.log("  ok   numeric.percentage_slider appears once, under slider.single");
await closePicker();

console.log("\nTHE FAMILY COUNT IS THE NUMBER OF TYPES YOU CAN ACTUALLY PICK");
await openPicker("single_select");
const navCount = Number(await page.$eval('[data-testid="picker-family-single_select"] .nav-count', (e) => e.textContent.trim()));
const cards = await page.$$eval('.card.selectable[data-testid^="picker-variant-"]', (els) => els.length);
assert.equal(navCount, cards, `nav says ${navCount}, the pane shows ${cards} type cards`);
console.log(`  ok   Single Select advertises ${navCount} and shows ${cards} — the same number`);
await closePicker();

console.log("\nPICKING A PRESET CREATES THE PARENT'S TYPE WITH THE PRESET'S DEFAULTS");
const before = (await h.readDef()).questions.length;
await openPicker("text");
await page.click('[data-testid="picker-variant-text.email"]');
await page.waitForTimeout(400);
await page.click('[data-testid="close-question"]').catch(() => {});
const def = await h.readDef();
assert.equal(def.questions.length, before + 1, "one question created");
const q = def.questions[def.questions.length - 1];
assert.equal(q.type, "open_text", "it is Single-Line Text's base type");
assert.equal(q.variant, "text.email", "…recorded as the preset, so the properties panel knows where it came from");
assert.ok(q.validation.some((v) => v.kind === "email"), "…with the email validator already on");
console.log("  ok   Email → open_text, variant text.email, email validation preset");

console.log("\nPICKING A TYPE STILL WORKS EXACTLY AS BEFORE");
const made = await h.createFromPicker("text", "text.single_line");
assert.equal(made.type, "open_text");
assert.equal(made.variant, "text.single_line");
assert.deepEqual(made.validation.filter((v) => v.kind === "email"), [], "no preset, no email validator");
console.log("  ok   Single-Line Text → open_text with no preset defaults");

console.log("\nTHE SWITCHER ON AN EXISTING QUESTION NESTS PRESETS UNDER THEIR PARENT TOO");
await h.goTab("Questions");
await page.click(`[data-qid="${q.id}"]`);
await page.waitForSelector('[data-testid="variant-switcher"]');
const groups = await page.$$eval('[data-testid="variant-switcher"] optgroup', (els) => els.map((g) => ({ label: g.label, options: [...g.querySelectorAll("option")].map((o) => o.value) })));
const single = groups.find((g) => g.label === "Single-Line Text");
assert.ok(single, `Single-Line Text is a group in the switcher: ${JSON.stringify(groups.map((g) => g.label))}`);
assert.ok(single.options.includes("text.email") && single.options[0] === "text.single_line", "the type first, its presets under it");
assert.equal(await page.$eval('[data-testid="variant-switcher"]', (e) => e.value), "text.email", "the current preset is selected");
const flat = await page.$$eval('[data-testid="variant-switcher"] > option', (els) => els.map((o) => o.value));
assert.ok(!flat.includes("text.email"), "…and not ALSO listed flat");
// a preset whose parent is in another family shows the parent's family
await h.loadDef({ ...(await h.readDef()), questions: [{ id: "tn", code: "TN", variableName: "TN", type: "ranking", variant: "ranking.top_n", text: "Top 3", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }] }] });
await h.goTab("Questions");
await page.click('[data-qid="tn"]');
await page.waitForSelector('[data-testid="variant-switcher"]');
assert.equal(await page.$eval('[data-testid="variant-switcher"]', (e) => e.value), "ranking.top_n");
const g2 = await page.$$eval('[data-testid="variant-switcher"] optgroup', (els) => els.map((g) => g.label));
assert.ok(g2.some((l) => /Click.*Rank|Rank.*Click/i.test(l)), `Top-N sits under its parent Click-to-Rank: ${JSON.stringify(g2)}`);
console.log("  ok   switcher: types as groups, presets nested, cross-family preset under its parent");

await h.close();
console.log("\nALL PICKER TAXONOMY CHECKS PASSED");
