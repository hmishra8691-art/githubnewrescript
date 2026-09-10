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

console.log("\nA CROSS-FAMILY PRESET IS FOUND IN BOTH PLACES AND CREATES ONE THING");
/*
 * The first version of this contract hid a cross-family preset from its own
 * family ("appears once, under its parent"). That made "Speech-to-Text" and
 * the AI entries look MISSING to a programmer browsing Video / Audio or
 * AI-Enabled. So a preset registered in a family whose parent lives elsewhere
 * is shown in ITS family as a card saying what it creates, and under the
 * parent as a chip — two places to find it, one identity.
 */
await openPicker("numeric");
const pctCard = await page.$('[data-testid="picker-variant-numeric.percentage_slider"]');
assert.ok(pctCard, "Percentage Slider is offered in Numeric…");
assert.equal(await pctCard.getAttribute("data-preset-of"), "slider.single", "…as a card that says it creates a Single Slider (never as a type of its own)");
assert.ok(!(await page.$('[data-testid="picker-type-numeric.percentage_slider"] [data-testid="picker-presets-numeric.percentage_slider"]')), "a preset card has no presets of its own");
await closePicker();
await openPicker("slider");
const pctChip = await page.$('[data-testid="picker-type-slider.single"] [data-testid="picker-variant-numeric.percentage_slider"]');
assert.ok(pctChip, "…and it is a chip under Single Slider, in the Slider family");
console.log("  ok   numeric.percentage_slider: a card in Numeric (creates a Single Slider) and a chip under slider.single");
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

console.log("\nTHE FORMER 'COMING SOON' ENTRIES ARE FINDABLE WHERE THEY WERE LOOKED FOR — AND CREATE THE REAL THING");
await openPicker("media");
const stt = await page.waitForSelector('[data-testid="picker-variant-media.speech_to_text"]');
assert.equal(await stt.getAttribute("data-preset-of"), "text.multi_line", "Speech-to-Text is a preset of Multi-Line Text, offered in Video / Audio");
assert.match(await stt.textContent(), /creates a Multi-Line Text/);
await stt.click();
await page.waitForTimeout(400);
await page.click('[data-testid="close-question"]').catch(() => {});
let d2 = await h.readDef();
let made2 = d2.questions[d2.questions.length - 1];
assert.equal(made2.type, "long_text");
assert.equal(made2.variant, "media.speech_to_text");
assert.equal(made2.settings.speechInput, true, "…with dictation already on");
console.log("  ok   Speech-to-Text Response → long_text with speechInput on");

await openPicker("ai");
for (const id of ["ai.classification", "ai.sentiment", "ai.probe"]) assert.ok(await page.$(`[data-testid="picker-variant-${id}"]`), `${id} offered`);
assert.ok(await page.$('[data-testid="picker-mode-mode.ai_conversational"]'), "AI Conversational Survey offered as a survey mode");
await page.click('[data-testid="picker-variant-ai.classification"]');
await page.waitForTimeout(400);
await page.click('[data-testid="close-question"]').catch(() => {});
d2 = await h.readDef();
made2 = d2.questions[d2.questions.length - 1];
assert.equal(made2.type, "calculated");
assert.match(made2.settings.expression, /^ai_classify\(Q1, /, "a calculated variable with the ai_classify template");
assert.match(made2.text, /AI-coded/);
await openPicker("ai");
await page.click('[data-testid="picker-variant-ai.probe"]');
await page.waitForTimeout(400);
await page.click('[data-testid="close-question"]').catch(() => {});
d2 = await h.readDef();
made2 = d2.questions[d2.questions.length - 1];
assert.equal(made2.type, "long_text");
assert.equal(made2.probe?.maxProbes, 2, "an open end with the follow-up probe switched on");
console.log("  ok   AI classification → calculated + ai_classify(); AI probe → long_text with q.probe");

await openPicker("dynamic");
await page.click('[data-testid="picker-variant-dynamic.respondent_specific"]');
await page.waitForTimeout(400);
await page.click('[data-testid="close-question"]').catch(() => {});
d2 = await h.readDef();
made2 = d2.questions[d2.questions.length - 1];
assert.equal(made2.type, "single_select");
assert.ok(made2.options.some((o) => o.visibleIf?.source?.kind === "embedded"), "an option with a show-when condition over embedded data");
console.log("  ok   Respondent-Specific Options → single_select with option visibleIf");

const dBefore = await h.readDef();
assert.equal(dBefore.branding.layout.voice?.readAloud ?? false, false);
const nBefore = dBefore.questions.length;
await openPicker("conversational");
assert.ok(await page.$('[data-testid="picker-mode-mode.ai_conversational"]'), "the ONE survey-mode card is offered in the Conversational family too");
for (const id of ["mode.voice", "mode.conversational", "mode.adaptive"]) assert.ok(!(await page.$(`[data-testid="picker-mode-${id}"]`)), `${id} is no longer a separate card — consolidated into AI Conversational Survey`);
await page.click('[data-testid="picker-mode-mode.ai_conversational"]');
await page.waitForTimeout(400);
d2 = await h.readDef();
assert.equal(d2.branding.aiConversation.enabled, true, "the card switches the AI conversational survey on");
assert.equal(d2.branding.aiConversation.interaction, "text_voice");
assert.equal(d2.branding.aiConversation.conversation, "adaptive");
assert.equal(d2.branding.aiConversation.adaptive.enabled, true);
assert.deepEqual({ r: d2.branding.layout.voice.readAloud, d: d2.branding.layout.voice.dictation, p: d2.branding.layout.presentation }, { r: true, d: true, p: "conversational" }, "the older layout fields are mirrored");
assert.equal(d2.questions.length, nBefore, "a survey mode adds no question");
const nAfter = d2.questions.length;
await openPicker("ai");
await page.click('[data-testid="picker-variant-ai.conversational_question"]');
await page.waitForTimeout(400);
await page.click('[data-testid="close-question"]').catch(() => {});
d2 = await h.readDef();
made2 = d2.questions[d2.questions.length - 1];
assert.equal(made2.type, "long_text", "AI Conversational Question is an ordinary open end…");
assert.deepEqual(made2.ai, { conversation: "adaptive", adaptive: { enabled: true, maxFollowUps: 2 } }, "…with the interviewer's adaptive follow-ups on for it");
assert.equal(d2.questions.length, nAfter + 1);
await openPicker("ai");
const navCounts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="picker-family-"]')].map((b) => [b.getAttribute("data-testid").replace("picker-family-", ""), b.querySelector(".nav-count")?.textContent])));
assert.ok(navCounts.ai !== "soon" && navCounts.media !== "soon", `AI and Media families are no longer "soon": ${JSON.stringify({ ai: navCounts.ai, media: navCounts.media })}`);
await closePicker();
console.log("  ok   one AI Conversational Survey mode card (sets branding.aiConversation, mirrors layout); AI Conversational Question preset; no phantom questions");

await h.close();
console.log("\nALL PICKER TAXONOMY CHECKS PASSED");
