import test from "node:test";
import assert from "node:assert/strict";
import { THEME_PRESETS, hexToRgb, isDarkTheme, luminance, mixHex, rgbToHex, themeSurfaces } from "./themes.js";
import { DEFAULT_THEME } from "./types.js";

test("hex parsing takes both forms and never throws into a render", () => {
  assert.deepEqual(hexToRgb("#ffffff"), [255, 255, 255]);
  assert.deepEqual(hexToRgb("000000"), [0, 0, 0]);
  assert.deepEqual(hexToRgb("#f00"), [255, 0, 0]);
  assert.deepEqual(hexToRgb("nonsense"), [128, 128, 128], "an unparseable colour reads as grey rather than breaking the page");
  assert.deepEqual(hexToRgb(""), [128, 128, 128]);
  assert.equal(rgbToHex(255, 0, 0), "#ff0000");
  assert.equal(rgbToHex(300, -20, 12.6), "#ff000d", "clamped and rounded");
});

test("mixing walks from one colour to the other", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0), "#000000");
  assert.equal(mixHex("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixHex("#000000", "#ffffff", 5), "#ffffff", "clamped");
});

test("luminance knows light from dark", () => {
  assert.ok(luminance("#ffffff") > 0.9);
  assert.ok(luminance("#000000") < 0.05);
  assert.ok(luminance("#0f1524") < luminance("#6b7690"));
});

test("a theme is dark when its background is", () => {
  assert.equal(isDarkTheme(DEFAULT_THEME), false);
  assert.equal(isDarkTheme(THEME_PRESETS.find((t) => t.name === "Midnight")!), true);
  assert.equal(isDarkTheme(THEME_PRESETS.find((t) => t.name === "Graphite")!), true);
  assert.equal(isDarkTheme(THEME_PRESETS.find((t) => t.name === "Warm paper")!), false);
});

test("a dark theme's card is LIGHTER than its page, and a light theme's is not darker", () => {
  /*
   * This is the bug the surfaces exist to prevent: a dark theme used to draw
   * white cards on a dark page, because the card colour came from the
   * stylesheet and never from the theme at all.
   */
  const midnight = THEME_PRESETS.find((t) => t.name === "Midnight")!;
  const s = themeSurfaces(midnight);
  assert.ok(luminance(s.surface) > luminance(s.background), "a card must lift off a dark page");
  assert.ok(luminance(s.surface) < luminance("#ffffff") * 0.5, "…without being white");

  const light = themeSurfaces(DEFAULT_THEME);
  assert.ok(luminance(light.surface) >= luminance(light.background) - 0.01, "a light theme's card is not darker than its page");
});

test("grid lines stay visible without becoming a cage", () => {
  for (const preset of THEME_PRESETS) {
    const s = themeSurfaces(preset);
    const gridVsPage = Math.abs(luminance(s.grid) - luminance(s.background));
    assert.ok(gridVsPage > 0.005, `${preset.name}: grid lines must be visible against the page`);
    const gridVsText = Math.abs(luminance(s.grid) - luminance(s.text));
    assert.ok(gridVsText > gridVsPage, `${preset.name}: grid lines must stay closer to the page than to the text`);
  }
});

test("every preset keeps its text readable against its own page", () => {
  const contrast = (a: string, b: string) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  for (const preset of THEME_PRESETS) {
    const s = themeSurfaces(preset);
    assert.ok(contrast(s.text, s.background) >= 7, `${preset.name}: body text on the page should clear AAA, got ${contrast(s.text, s.background).toFixed(1)}`);
    assert.ok(contrast(s.text, s.surface) >= 7, `${preset.name}: body text on a card should clear AAA, got ${contrast(s.text, s.surface).toFixed(1)}`);
    assert.ok(contrast(s.subtle, s.surface) >= 3, `${preset.name}: muted text on a card should still be legible, got ${contrast(s.subtle, s.surface).toFixed(1)}`);
  }
});

test("every preset's chart palette is distinguishable from its own background", () => {
  for (const preset of THEME_PRESETS) {
    const bg = luminance(preset.colors.background);
    for (const c of preset.colors.palette) {
      assert.ok(Math.abs(luminance(c) - bg) > 0.03, `${preset.name}: palette colour ${c} disappears into the background`);
    }
  }
});

test("the presets include the default, two dark ones, and are all complete themes", () => {
  assert.ok(THEME_PRESETS.length >= 4);
  assert.equal(THEME_PRESETS[0].name, DEFAULT_THEME.name, "the house theme comes first");
  assert.equal(THEME_PRESETS.filter(isDarkTheme).length, 2);
  for (const p of THEME_PRESETS) {
    assert.ok(p.name && p.fontFamily && p.colors.palette.length >= 6, `${p.name} is a complete theme`);
  }
});

test("surfaces survive a theme with missing colours", () => {
  const s = themeSurfaces({ name: "sparse", colors: {} as never, fontFamily: "x" } as never);
  assert.ok(s.surface && s.border && s.grid && s.background && s.text, "a half-written theme still renders");
});
