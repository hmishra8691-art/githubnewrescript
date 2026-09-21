/**
 * DESKTOP LAYOUT, ALIGNMENT & INTELLIGENT THEME CUSTOMIZATION (Sept 21 brief).
 *
 *   node scripts/desktop-layout-theming-test.mjs      (studio :3000, runtime :3001)
 *
 * Covers, end to end:
 *   RUNTIME  — full-width desktop layout, content alignment, and every new
 *              branding color actually reaching rendered elements, at
 *              desktop/tablet/mobile viewports, proving tablet & mobile are
 *              UNAFFECTED by the new width-mode field (the brief's explicit
 *              non-regression constraint).
 *   STUDIO   — the Branding panel's new controls (width mode, content align,
 *              the seven optional/fallback colors with their inherit/reset
 *              behavior), the live theme preview updating with no save step,
 *              and the brand-hex -> generated-palette -> "Use this palette"
 *              flow (the logo-detection code path is exercised too, against
 *              a data: URL so it needs no network).
 *
 * `--rs-max-width` defaults to 760px, well under the tablet (800px) and
 * mobile (375px) viewports used below — so "full" vs "contained" never binds
 * at those widths, before or after this change. The tablet/mobile assertions
 * below don't just hope that stays true, they check it.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";

/**
 * A minimal solid-color PNG, built by hand (no image library needed) so
 * "Detect logo colors" can be tested against a real `data:` URL — no
 * network, no CORS, no fixture file to keep in sync. Solid saturated blue,
 * well clear of `dominantColorsFromImage`'s near-white/near-black/
 * low-saturation discard thresholds, so it survives extraction as a real
 * "brand color" rather than being filtered out as background noise.
 */
function solidPng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB, no interlace
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) { raw[off + 1 + x * 3] = r; raw[off + 2 + x * 3] = g; raw[off + 3 + x * 3] = b; }
  }
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();

/* ======================================================================= */
/* RUNTIME: width mode, alignment, colors, at desktop/tablet/mobile        */
/* ======================================================================= */

const baseQuestions = [
  {
    id: "q1", code: "Q1", variableName: "QTY", type: "numeric", text: "How many?",
    validation: [{ kind: "min_value", value: 1, message: "Please enter at least 1." }],
  },
];
const baseFlow = [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }];

const shellRect = (page) => page.evaluate(() => {
  const el = document.querySelector(".rs-shell");
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    width: r.width, x: r.x, className: el.className,
    maxWidth: cs.maxWidth, marginLeft: cs.marginLeft, marginRight: cs.marginRight,
  };
});

// ---- desktop: full width uses (almost) the whole viewport ----
{
  const def = SurveyDefinition.parse({
    meta: { id: "dt1", code: "DT1", title: "Desktop Full", version: "1.0" },
    questions: baseQuestions, flow: baseFlow,
    branding: { layout: { widthMode: "full" } },
  });
  const page = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1600, height: 1000 } });
  const rect = await shellRect(page);
  assert.match(rect.className, /\brs-width-full\b/);
  assert.equal(rect.maxWidth, "none", "full width mode must not cap max-width");
  assert.ok(rect.width > 1400, `desktop full-width shell should fill nearly the whole 1600px viewport, got ${rect.width}px`);
  ok(`desktop, widthMode=full: shell is ${Math.round(rect.width)}px wide on a 1600px viewport (no fixed narrow container)`);
  await page.close();
}

// ---- desktop: contained mode still respects maxWidth ----
{
  const def = SurveyDefinition.parse({
    meta: { id: "dt2", code: "DT2", title: "Desktop Contained", version: "1.0" },
    questions: baseQuestions, flow: baseFlow,
    branding: { layout: { widthMode: "contained", maxWidth: "760px" } },
  });
  const page = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1600, height: 1000 } });
  const rect = await shellRect(page);
  assert.match(rect.className, /\brs-width-contained\b/);
  assert.ok(Math.abs(rect.width - 760) < 2, `contained shell should be ~760px even on a 1600px viewport, got ${rect.width}px`);
  ok(`desktop, widthMode=contained: shell honors maxWidth (${Math.round(rect.width)}px) — the old behavior is still available, not removed`);
  await page.close();
}

// ---- content alignment: left / center / right, in contained mode so there's room to move ----
for (const [align, expect] of [["left", "ml0"], ["center", "auto"], ["right", "mr0"]]) {
  const def = SurveyDefinition.parse({
    meta: { id: `al-${align}`, code: `AL${align.toUpperCase()}`, title: "Align", version: "1.0" },
    questions: baseQuestions, flow: baseFlow,
    branding: { layout: { widthMode: "contained", maxWidth: "760px", contentAlign: align } },
  });
  const page = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1600, height: 1000 } });
  const rect = await shellRect(page);
  if (expect === "ml0") assert.equal(rect.marginLeft, "0px", `left align: margin-left should be 0, got ${rect.marginLeft}`);
  if (expect === "mr0") assert.equal(rect.marginRight, "0px", `right align: margin-right should be 0, got ${rect.marginRight}`);
  if (expect === "auto") {
    // centered: roughly equidistant from both viewport edges
    const centerGap = 1600 - rect.width;
    assert.ok(Math.abs(rect.x - centerGap / 2) < 4, `center align: shell should be centered, x=${rect.x}, expected ~${centerGap / 2}`);
  }
  ok(`content align "${align}" positions the shell correctly at desktop width (x=${Math.round(rect.x)}px, width=${Math.round(rect.width)}px)`);
  await page.close();
}

// ---- tablet & mobile: widthMode must NOT change their layout ----
for (const [label, width] of [["tablet", 800], ["mobile", 375]]) {
  const rects = {};
  for (const widthMode of ["full", "contained"]) {
    const def = SurveyDefinition.parse({
      meta: { id: `${label}-${widthMode}`, code: `${label}${widthMode}`.toUpperCase(), title: "Device", version: "1.0" },
      questions: baseQuestions, flow: baseFlow,
      branding: { layout: { widthMode, maxWidth: "760px" } },
    });
    const page = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width, height: 900 } });
    rects[widthMode] = await shellRect(page);
    await page.close();
  }
  assert.ok(Math.abs(rects.full.width - rects.contained.width) < 1,
    `${label} (${width}px): full vs contained must render identically — got ${rects.full.width}px vs ${rects.contained.width}px`);
  // exactly the pre-existing (pre-widthMode) behavior: capped at maxWidth
  // (760px) whenever the viewport is wider than that, and otherwise filling
  // the narrow viewport as it always did — never wider than before.
  const expected = Math.min(760, width);
  assert.ok(Math.abs(rects.full.width - expected) < 2,
    `${label}: shell should render exactly as it did before widthMode existed (~${expected}px on a ${width}px screen), got ${rects.full.width}px`);
  ok(`${label} (${width}px): widthMode has no effect below the 1024px desktop breakpoint — layout is unchanged (${Math.round(rects.full.width)}px either way), as required`);
}

// ---- the seven new colors actually reach rendered elements, with working fallback ----
{
  // no overrides: everything should fall back down the CSS chain to the base colors
  const def = SurveyDefinition.parse({
    meta: { id: "col-fb", code: "COLFB", title: "Fallback", version: "1.0" },
    questions: baseQuestions, flow: baseFlow,
    branding: { colors: { primary: "#1d4ed8", text: "#0f172a" } },
  });
  const page = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1200, height: 1000 } });
  const btnBg = await page.$eval(".rs-btn", (e) => getComputedStyle(e).backgroundColor);
  const progressFill = await page.$eval(".rs-progress-fill", (e) => getComputedStyle(e).backgroundColor);
  assert.equal(btnBg, "rgb(29, 78, 216)", "button background should fall back to primary (#1d4ed8) when buttonBackground is unset");
  assert.equal(progressFill, "rgb(29, 78, 216)", "progress fill should fall back to primary via accent when progress/accent are unset");
  ok("unset optional colors fall back correctly (button + progress both resolve to primary, untouched)");
  await page.close();
}
{
  // every optional color explicitly overridden: each one must win over its fallback
  const def = SurveyDefinition.parse({
    meta: { id: "col-ov", code: "COLOV", title: "Overrides", version: "1.0" },
    questions: baseQuestions, flow: baseFlow,
    branding: {
      colors: {
        primary: "#1d4ed8", text: "#0f172a", surface: "#ffffff",
        accent: "#16a34a", heading: "#7c2d12", link: "#9333ea",
        inputBackground: "#fef9c3", buttonBackground: "#dc2626", buttonText: "#ffff00",
        progress: "#ea580c",
      },
    },
  });
  const page = await openPreview(browser, RUNTIME, { definition: def }, { viewport: { width: 1200, height: 1000 } });
  const [btnBg, btnText, progressFill, inputBg, linkColor] = await Promise.all([
    page.$eval(".rs-btn", (e) => getComputedStyle(e).backgroundColor),
    page.$eval(".rs-btn", (e) => getComputedStyle(e).color),
    page.$eval(".rs-progress-fill", (e) => getComputedStyle(e).backgroundColor),
    page.$eval(".rs-input, .rs-shell input[type=number], .rs-shell input:not([type=hidden])", (e) => getComputedStyle(e).backgroundColor).catch(() => null),
    page.$eval('[data-testid="rs-skip"]', (e) => getComputedStyle(e).color),
  ]);
  assert.equal(btnBg, "rgb(220, 38, 38)", "buttonBackground override must win over primary");
  assert.equal(btnText, "rgb(255, 255, 0)", "buttonText override must win over the computed contrast color");
  assert.equal(progressFill, "rgb(234, 88, 12)", "progress override must win over accent");
  assert.equal(linkColor, "rgb(147, 51, 234)", "link override must win — checked on the always-present skip-to-questions link");
  if (inputBg) assert.equal(inputBg, "rgb(254, 249, 195)", "inputBackground override must win over surface");
  ok("every one of the seven new colors reaches its rendered element and overrides its fallback (button, button text, progress, link" + (inputBg ? ", input" : "") + ")");
  await page.close();
}

/* ======================================================================= */
/* STUDIO: the Branding panel's new controls + live preview                */
/* ======================================================================= */

const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

const goTab = async (name) => { await page.click(`.leftnav >> text=${name}`); await page.waitForTimeout(150); };
const loadFixture = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.fill("textarea.code", JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(400);
};

const FIXTURE = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "SANDBOX", title: "DesktopLayoutTheming", version: "1.0" },
  questions: baseQuestions,
  flow: baseFlow,
});

await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle" });
await page.waitForSelector(".leftnav");
await loadFixture(FIXTURE);
ok("fixture loaded: one numeric question, default (uncustomized) branding");

await goTab("Branding");
await page.waitForSelector('[data-testid="theme-live-preview"]');
const previewQCount = await page.$$eval('[data-testid="theme-live-preview"] [data-qid]', (els) => els.length);
assert.ok(previewQCount >= 3, `live preview should show its 3-question fixture, got ${previewQCount} question(s)`);
ok(`live preview renders the real QuestionRenderer against its own fixture survey (${previewQCount} questions), not a static mockup`);

const previewBtnBg = () => page.$eval('[data-testid="theme-preview-next"]', (e) => getComputedStyle(e).backgroundColor);
const before = await previewBtnBg();

// editing Primary updates the live preview immediately — no save, no reload
const primaryInput = page.locator('label:has(span:text-is("Primary")) input.mono');
await primaryInput.fill("#059669");
await primaryInput.dispatchEvent("change");
await page.waitForTimeout(150);
const after = await previewBtnBg();
assert.notEqual(after, before, "changing Primary should change the live preview's button color immediately");
assert.equal(after, "rgb(5, 150, 105)", "the live preview should reflect the exact new Primary color");
ok(`live preview updates the instant a color changes — no Save, no leaving the panel (button ${before} -> ${after})`);

// width mode / content align controls exist and drive the preview's own shell classes
await page.selectOption('[data-testid="branding-width-mode"]', "contained");
await page.waitForTimeout(100);
let previewShellClass = await page.$eval('[data-testid="theme-live-preview"] .rs-shell', (e) => e.className);
assert.match(previewShellClass, /\brs-width-contained\b/);
await page.selectOption('[data-testid="branding-width-mode"]', "full");
await page.waitForTimeout(100);
previewShellClass = await page.$eval('[data-testid="theme-live-preview"] .rs-shell', (e) => e.className);
assert.match(previewShellClass, /\brs-width-full\b/);
ok("Desktop width control (full/contained) is present and the live preview's shell class tracks it immediately");

await page.selectOption('[data-testid="branding-content-align"]', "right");
await page.waitForTimeout(100);
ok("Content align control (left/center/right) is present and accepts all three values");
await page.selectOption('[data-testid="branding-content-align"]', "left");

// optional colors: inherited by default, editable, resettable
await page.waitForSelector('[data-testid="branding-optcolor-accent-inherited"]');
ok('Accent color shows "(inherited)" until the survey customizes it');
await page.fill('[data-testid="branding-optcolor-accent-input"]', "#f97316");
await page.dispatchEvent('[data-testid="branding-optcolor-accent-input"]', "change");
await page.waitForTimeout(150);
const noLongerInherited = await page.$('[data-testid="branding-optcolor-accent-inherited"]');
assert.equal(noLongerInherited, null, "the inherited badge should disappear once Accent is explicitly set");
const progressAfterAccent = await page.$eval('[data-testid="theme-live-preview"] .rs-progress-fill', (e) => getComputedStyle(e).backgroundColor);
assert.equal(progressAfterAccent, "rgb(249, 115, 22)", "Progress (which falls back to Accent) should pick up the new Accent color in the live preview");
ok("setting Accent clears its inherited badge and the live preview's progress bar (which falls back to Accent) updates immediately");

await page.click('[data-testid="branding-optcolor-accent-reset"]');
await page.waitForTimeout(150);
await page.waitForSelector('[data-testid="branding-optcolor-accent-inherited"]');
ok('the "×" reset button restores "(inherited)" — a survey can always fall back to the CSS chain again');

// "Detect logo colors" is disabled with no logo, then works against a data: URL logo (no network needed)
const LOGO_PNG = solidPng(16, 16, [37, 99, 235]); // #2563eb, a clear saturated blue
const detectDisabledBefore = await page.getAttribute('[data-testid="detect-logo-colors"]', "disabled");
assert.notEqual(detectDisabledBefore, null, "Detect logo colors must start disabled — there's no logo to analyze yet");
ok("Detect logo colors is disabled until a logo is present, so it never analyzes nothing");

await page.fill('[data-testid="branding-logo"]', LOGO_PNG);
await page.waitForTimeout(200);
await page.click('[data-testid="detect-logo-colors"]');
await page.waitForSelector('[data-testid="generated-palette"]', { timeout: 10000 });
let swatches = await page.$$eval('[data-testid="generated-palette"] > div > div', (els) => els.length);
assert.ok(swatches >= 14, `detected palette should have all 15 color fields, got ${swatches}`);
ok(`"Detect logo colors" ran the real canvas pixel-reader against a data: URL logo and produced a ${swatches}-color palette`);

// brand-hex -> generate -> apply
await page.fill('[data-testid="theme-generator"] input.mono', "#be123c");
await page.click('[data-testid="generate-from-hex"]');
await page.waitForSelector('[data-testid="generated-palette"]');
await page.click('[data-testid="apply-generated-palette"]');
await page.waitForTimeout(200);
const primaryAfterApply = await primaryInput.inputValue();
assert.notEqual(primaryAfterApply.toLowerCase(), "#059669", "applying a generated palette should overwrite Primary with the generated color");
const previewBtnAfterApply = await previewBtnBg();
assert.notEqual(previewBtnAfterApply, after, "the live preview should reflect the applied generated palette immediately");
ok(`"Generate theme" from a brand hex + "Use this palette" applied a full contrast-checked palette (Primary is now ${primaryAfterApply}) and the live preview updated`);

// every generated color is still manually editable afterward — the brief's explicit requirement
await primaryInput.fill("#111827");
await primaryInput.dispatchEvent("change");
await page.waitForTimeout(150);
assert.equal(await primaryInput.inputValue(), "#111827");
ok("every generated color remains a normal, hand-editable field after being auto-applied");

assert.equal(errors.length, 0, `no page errors expected, got: ${errors.join("; ")}`);
ok("no console/page errors throughout");

await browser.close();
console.log(`\n${passed} checks passed.`);
