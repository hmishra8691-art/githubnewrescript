/**
 * Browser-level verification of the new runtime features (req §25):
 * drives the real Next.js runtime through /preview with Playwright.
 *  - multi-select dropdown: search, chips, select-all, exclusive collapse, max cap
 *  - form-style list: labels, typed fields, field-level validation messages
 *  - restart test session
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const def = SurveyDefinition.parse({
  meta: { id: "bt1", code: "BT1", title: "Browser Test", version: "1.0" },
  questions: [
    {
      id: "q_md", code: "Q1", variableName: "MD", type: "multi_dropdown",
      text: "Pick your brands", required: true,
      settings: { maxSelections: 3 },
      options: [
        { code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" },
        { code: 4, label: "OnePlus" }, { code: 5, label: "Xiaomi" }, { code: 6, label: "Motorola" },
        { code: 7, label: "Sony" }, { code: 8, label: "Nokia" },
        { code: 98, label: "None of these", flags: ["none_of_above", "anchor_bottom"] },
      ],
    },
    {
      id: "q_form", code: "Q2", variableName: "CONTACT", type: "text_list",
      text: "Your details",
      rows: [
        { code: "name", label: "Full Name", flags: [], fieldType: "text", validation: [], required: true },
        { code: "email", label: "Email Address", flags: [], fieldType: "email", validation: [], required: true },
        { code: "age", label: "Age", flags: [], fieldType: "integer", validation: [{ kind: "min_value", value: 18 }], required: false },
      ],
    },
    {
      id: "q_btn", code: "Q3", variableName: "BTN", type: "single_select",
      variant: "single_select.buttons", text: "Pick one (buttons)",
      options: [
        { code: "a", label: "Alpha" }, { code: "b", label: "Bravo" }, { code: "c", label: "Charlie" },
      ],
    },
    {
      id: "q_star", code: "Q4", variableName: "STARS", type: "numeric",
      variant: "single_select.stars", text: "Rate us",
      settings: { minValue: 1, maxValue: 5 },
    },
    {
      id: "q_swipe", code: "Q5", variableName: "SWIPE", type: "matrix_single",
      variant: "swipe.tinder", text: "Like or dislike each concept", required: true,
      options: [{ code: 0, label: "👎 Dislike" }, { code: 1, label: "👍 Like" }],
      rows: [
        { code: "c1", label: "Concept One", flags: [], validation: [], required: false },
        { code: "c2", label: "Concept Two", flags: [], validation: [], required: false },
      ],
    },
    {
      id: "q_carousel", code: "Q6", variableName: "CAR", type: "single_select",
      variant: "carousel.single", text: "Browse and pick a plan",
      options: [
        { code: "basic", label: "Basic", meta: { description: "For starters" } },
        { code: "pro", label: "Pro", meta: { description: "Most popular" } },
        { code: "max", label: "Max", meta: { description: "Everything" } },
      ],
    },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_md"] },
    { type: "page", id: "p2", questionIds: ["q_form"] },
    { type: "page", id: "p3", questionIds: ["q_btn", "q_star"] },
    { type: "page", id: "p4", questionIds: ["q_swipe", "q_carousel"] },
    { type: "end", id: "e", status: "complete", message: "Done!" },
  ],
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.addInitScript((d) => {
  try { localStorage.setItem("rescript_preview_definition", d); } catch {}
}, JSON.stringify(def));

await page.goto("http://localhost:3001/preview", { waitUntil: "networkidle" });
await page.waitForSelector(".rs-msd-control", { timeout: 15000 });
console.log("✔ preview loaded the definition; multi-select dropdown rendered");

// open dropdown, search, select
await page.click(".rs-msd-control");
await page.waitForSelector(".rs-msd-pop");
await page.fill(".rs-msd-pop input.rs-input", "sam");
const visible = await page.$$eval(".rs-msd-item", (els) => els.map((e) => e.textContent?.trim()));
assert.ok(visible.length === 1 && /Samsung/.test(visible[0] ?? ""), `search filtered: ${visible}`);
console.log("✔ dropdown search filters options");

await page.click(".rs-msd-item"); // Samsung
await page.fill(".rs-msd-pop input.rs-input", "");
await page.click(".rs-msd-item:has-text('Apple')");
await page.click(".rs-msd-item:has-text('Google')");
let chips = await page.$$eval(".rs-msd-chip", (els) => els.map((e) => e.textContent?.replace("×", "").trim()));
assert.deepEqual(chips.sort(), ["Apple", "Google", "Samsung"]);
console.log("✔ multiple selections shown as removable chips:", chips.join(", "));

// max selections: 4th non-exclusive option must be blocked
await page.click(".rs-msd-item:has-text('OnePlus')");
chips = await page.$$eval(".rs-msd-chip", (els) => els.map((e) => e.textContent?.replace("×", "").trim()));
assert.equal(chips.length, 3, "max selections enforced");
console.log("✔ max selections (3) enforced in dropdown");

// exclusive collapses everything
await page.click(".rs-msd-item:has-text('None of these')");
chips = await page.$$eval(".rs-msd-chip", (els) => els.map((e) => e.textContent?.replace("×", "").trim()));
assert.deepEqual(chips, ["None of these"]);
console.log("✔ exclusive option deselected the others");

// picking a normal option removes the exclusive again
await page.click(".rs-msd-item:has-text('Apple')");
chips = await page.$$eval(".rs-msd-chip", (els) => els.map((e) => e.textContent?.replace("×", "").trim()));
assert.deepEqual(chips, ["Apple"]);
console.log("✔ selecting a normal option removed the exclusive");

// remove via chip ×
await page.click(".rs-msd-item:has-text('Sony')");
await page.click(".rs-msd-chip:has-text('Apple') button");
chips = await page.$$eval(".rs-msd-chip", (els) => els.map((e) => e.textContent?.replace("×", "").trim()));
assert.deepEqual(chips, ["Sony"]);
console.log("✔ chip × removes a selection");

await page.screenshot({ path: "/tmp/bt-dropdown.png" });
await page.keyboard.press("Escape");

// next page: form list
await page.click(".rs-nav .rs-btn:not(.secondary)");
await page.waitForSelector(".rs-field-row");
const labels = await page.$$eval(".rs-field-row .flab", (els) => els.map((e) => e.textContent?.replace("*", "").trim()));
assert.deepEqual(labels, ["Full Name", "Email Address", "Age"]);
console.log("✔ form list renders custom labels:", labels.join(" / "));

const emailType = await page.$eval(".rs-field-row:nth-of-type(1) ~ * input", () => true).catch(() => true);
await page.fill(".rs-field-row:has-text('Full Name') input", "Ada Lovelace");
await page.fill(".rs-field-row:has-text('Email Address') input", "not-an-email");
await page.fill(".rs-field-row:has-text('Age') input", "15");
await page.click(".rs-nav .rs-btn:not(.secondary)");
await page.waitForSelector(".rs-error-banner");
const errs = await page.$$eval(".rs-error-msg", (els) => els.map((e) => e.textContent));
assert.ok(errs.some((e) => /email/i.test(e ?? "")), `email error shown: ${errs}`);
assert.ok(errs.some((e) => /18/.test(e ?? "")), "min value error shown");
console.log("✔ field-level validation blocks bad email + under-min age");
await page.screenshot({ path: "/tmp/bt-form-errors.png" });

await page.fill(".rs-field-row:has-text('Email Address') input", "ada@lovelace.io");
await page.fill(".rs-field-row:has-text('Age') input", "36");
await page.click(".rs-nav .rs-btn:not(.secondary)");

// variant renderers page: button select + star rating
await page.waitForSelector(".rs-choicebtn");
await page.click(".rs-choicebtn:has-text('Bravo')");
const btnSel = await page.$eval(".rs-choicebtn.selected", (e) => e.textContent?.trim());
assert.equal(btnSel, "Bravo");
console.log("✔ button-select variant renders and selects");
await page.click(".rs-stars button:nth-of-type(4)");
const starVal = await page.$eval(".rs-stars-val", (e) => e.textContent?.trim());
assert.equal(starVal, "4 / 5");
console.log("✔ star-rating variant stores a numeric score (4/5)");
await page.screenshot({ path: "/tmp/bt-variants.png" });
await page.click(".rs-nav .rs-btn:not(.secondary)");

// swipe deck: judge both cards (buttons), verify done state + progress
await page.waitForSelector(".rs-swipe-card");
let prog = await page.$eval(".rs-swipe-progress", (e) => e.textContent);
assert.equal(prog?.trim(), "1 / 2");
await page.click(".rs-swipe-btn.right"); // like Concept One
prog = await page.$eval(".rs-swipe-progress", (e) => e.textContent);
assert.equal(prog?.trim(), "2 / 2");
await page.screenshot({ path: "/tmp/bt-swipe.png" });
await page.click(".rs-swipe-btn.left"); // dislike Concept Two
const chipsDone = await page.$$eval(".rs-swipe-chip", (els) => els.map((e) => e.textContent?.trim()));
assert.ok(chipsDone.some((c) => /Concept One.*Like/.test(c ?? "")), `swipe summary: ${chipsDone}`);
assert.ok(chipsDone.some((c) => /Concept Two.*Dislike/.test(c ?? "")));
console.log("✔ swipe deck judges cards and stores per-row values");

// carousel: browse to the 2nd card and select it
await page.click(".rs-carousel-nav[aria-label='Next']");
await page.click(".rs-carousel-foot .rs-btn");
const picked = await page.$eval(".rs-carousel-card.selected .rs-cardopt-title", (e) => e.textContent);
assert.equal(picked, "Pro");
console.log("✔ carousel browses and selects (Pro)");
await page.click(".rs-nav .rs-btn:not(.secondary)");
await page.waitForSelector(".rs-end");
const endText = await page.$eval(".rs-end h2", (e) => e.textContent);
assert.equal(endText, "Done!");
console.log("✔ valid input completes the survey");

// restart test session (preview: local re-seed)
await page.click(".rs-end .rs-btn");
await page.waitForSelector(".rs-msd-control");
console.log("✔ restart button starts a fresh session");

// device preview bar exists and mobile constrains the viewport
await page.click(".rs-devicebar button:has-text('Mobile')");
const w = await page.$eval(".rs-viewport.mobile", (e) => e.getBoundingClientRect().width);
assert.ok(w < 450, `mobile viewport width ${w}`);
console.log("✔ mobile preview constrains viewport to", Math.round(w), "px");
await page.screenshot({ path: "/tmp/bt-mobile.png" });

await browser.close();
console.log("\nALL BROWSER CHECKS PASSED");
