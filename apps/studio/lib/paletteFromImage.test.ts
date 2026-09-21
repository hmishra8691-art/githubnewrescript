import test from "node:test";
import assert from "node:assert/strict";
import {
  hexToRgb, rgbToHex, contrastRatio, bestTextColor, generatePalette, generatePaletteFromHex, ensureContrast,
  type RGB,
} from "./paletteFromImage.ts";

/*
 * THE PART OF "LOGO -> THEME" THAT DOESN'T NEED A BROWSER.
 *
 * `dominantColorsFromImage` needs a real canvas and a real image, so it is
 * not exercised here — the Playwright suite drives it against a data: URL
 * logo. Everything downstream of "here are some RGB colors" is pure and
 * tested directly: this is also where the brief's actual requirement lives
 * ("should not simply apply the logo color everywhere... maintaining
 * readability, accessibility/contrast").
 */

test("hex <-> rgb round-trips", () => {
  assert.deepEqual(hexToRgb("#2563eb"), { r: 37, g: 99, b: 235 });
  assert.equal(rgbToHex({ r: 37, g: 99, b: 235 }), "#2563eb");
  assert.equal(hexToRgb("not-a-color"), null);
  assert.equal(hexToRgb("#fff"), null, "3-digit shorthand is not accepted — every consumer expects #rrggbb");
});

test("contrast ratio matches the known black-on-white extreme", () => {
  const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
  assert.ok(Math.abs(ratio - 21) < 0.01, `black on white must be ~21:1, got ${ratio}`);
});

test("bestTextColor picks white on a dark background and dark on a light one", () => {
  assert.equal(bestTextColor({ r: 10, g: 10, b: 30 }), "#ffffff");
  assert.equal(bestTextColor({ r: 250, g: 245, b: 200 }), "#111827", "a pale/light brand color gets dark text, not invisible white-on-pastel");
});

test("ensureContrast actually nudges a color that starts out too low-contrast", () => {
  // a mid-gray on a near-white background: ~2.5:1, well under any real
  // WCAG floor, and NOT already safe by luck the way the palette's hardcoded
  // dark text/near-white background pairing is — this is the case that
  // catches the contrast guarantee being silently disabled or short-circuited.
  const low: RGB = { r: 150, g: 150, b: 150 };
  const bg: RGB = { r: 248, g: 250, b: 252 };
  const before = contrastRatio(low, bg);
  assert.ok(before < 4.5, `test setup: the starting color must actually be low-contrast, got ${before.toFixed(2)}`);
  const nudged = ensureContrast(low, bg, 4.5);
  assert.ok(contrastRatio(nudged, bg) >= 4.5, `ensureContrast must raise the ratio to at least 4.5, got ${contrastRatio(nudged, bg).toFixed(2)}`);
  assert.notDeepEqual(nudged, low, "it must actually change the color, not return the input unchanged");
});

test("ensureContrast leaves an already-sufficient color untouched", () => {
  const dark: RGB = { r: 15, g: 23, b: 42 };
  const bg: RGB = { r: 248, g: 250, b: 252 };
  assert.deepEqual(ensureContrast(dark, bg, 4.5), dark);
});

test("a single brand color produces every field the schema's colors object needs", () => {
  const p = generatePaletteFromHex("#8b5cf6");
  for (const key of [
    "primary", "secondary", "accent", "background", "surface", "text", "heading",
    "subtleText", "border", "error", "link", "inputBackground", "buttonBackground", "buttonText", "progress",
  ] as const) {
    assert.match(p[key], /^#[0-9a-f]{6}$/i, `${key} must be a real hex color, got ${p[key]}`);
  }
});

test("THE ACTUAL REQUIREMENT: generated text/background and button colors are readable, not just colorful", () => {
  const p = generatePaletteFromHex("#f5e642"); // a pale, low-contrast brand yellow on purpose
  const bg = hexToRgb(p.background)!, text = hexToRgb(p.text)!, heading = hexToRgb(p.heading)!;
  const btnBg = hexToRgb(p.buttonBackground)!, btnText = hexToRgb(p.buttonText)!;
  assert.ok(contrastRatio(text, bg) >= 7, `body text vs background must clear WCAG AAA (7:1) — got ${contrastRatio(text, bg).toFixed(2)}`);
  assert.ok(contrastRatio(heading, bg) >= 7, `heading vs background must clear 7:1 — got ${contrastRatio(heading, bg).toFixed(2)}`);
  assert.ok(contrastRatio(btnText, btnBg) >= 4.5, `button text vs button background must clear WCAG AA (4.5:1) — got ${contrastRatio(btnText, btnBg).toFixed(2)}`);
});

test("it does not just paint the logo color over everything — background and surface stay distinct from primary", () => {
  const p = generatePaletteFromHex("#1d4ed8");
  assert.notEqual(p.background.toLowerCase(), p.primary.toLowerCase());
  assert.notEqual(p.text.toLowerCase(), p.primary.toLowerCase());
  // background is a near-white TINT of the brand hue, not a copy of primary
  const bg = hexToRgb(p.background)!;
  assert.ok(bg.r > 200 && bg.g > 200 && bg.b > 200, `background should stay near-white — got ${p.background}`);
});

test("two seed colors (e.g. from a real logo) are used directly for primary/secondary, not re-derived", () => {
  const primary = { r: 220, g: 38, b: 38 };   // red
  const secondary = { r: 30, g: 64, b: 175 }; // blue
  const p = generatePalette([primary, secondary]);
  // primary is clamped into a usable lightness range but keeps its hue family (red)
  const pr = hexToRgb(p.primary)!;
  assert.ok(pr.r > pr.g && pr.r > pr.b, `primary should stay red-ish, got ${p.primary}`);
  assert.equal(p.secondary.toLowerCase(), rgbToHex(secondary).toLowerCase(), "a genuine second seed color is used as-is for secondary");
});

test("generatePaletteFromHex rejects a non-hex string rather than silently producing garbage", () => {
  assert.throws(() => generatePaletteFromHex("purple"), /not a #rrggbb color/);
});

test("generatePalette refuses an empty seed list rather than crashing on seeds[0]", () => {
  assert.throws(() => generatePalette([]), /at least one color/);
});
