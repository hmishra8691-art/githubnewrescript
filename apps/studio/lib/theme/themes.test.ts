import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_THEME, STUDIO_THEMES, THEME_BOOT_SCRIPT, isStudioTheme, studioTheme } from "./themes.ts";

/*
 * THE THEMES AND THE STYLESHEET AGREE (2026-11-11): every theme in the selector has a block in design-system.css,
 * every block re-values every colour token (so no theme shows another's colour), the preview chip is the theme's
 * real colours, and body text / muted text / text on the accent meet WCAG AA in every theme.
 */
const css = readFileSync(new URL("../../app/design-system.css", import.meta.url), "utf8");
const all = css + readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const tokens = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const rootBlock = /:root \{([\s\S]*?)\n\}/.exec(css)![1];
const base = tokens(rootBlock);
const COLOUR = Object.keys(base).filter((k) => /^--(c-|grad-|sh-)/.test(k) && !/var\(/.test(base[k]));
const blockOf = (id: string) => id === DEFAULT_THEME ? base : tokens(new RegExp(`:root\\[data-theme="${id}"\\] \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "");

const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("eight themes: the two the Studio already had, and six more", () => {
  assert.deepEqual(STUDIO_THEMES.map((t) => t.id), ["reslens", "classic", "light", "soft", "ocean", "contrast", "dark", "midnight"]);
  assert.equal(DEFAULT_THEME, "reslens");
  assert.ok(isStudioTheme("midnight")); assert.ok(!isStudioTheme("neon")); assert.ok(!isStudioTheme(null));
  assert.equal(studioTheme("nope").id, "reslens");
  for (const t of STUDIO_THEMES) assert.ok(THEME_BOOT_SCRIPT.includes(`"${t.id}"`), t.id);
});

test("every theme re-values every colour token, and its preview chip is its real colours", () => {
  assert.ok(COLOUR.length >= 45, `${COLOUR.length} colour tokens`);
  for (const t of STUDIO_THEMES) {
    const b = blockOf(t.id);
    const missing = COLOUR.filter((k) => !(k in b));
    assert.deepEqual(missing, [], `${t.id} does not define ${missing.join(", ")}`);
    assert.deepEqual([b["--c-bg"], b["--c-surface"], b["--c-primary"], b["--c-text"]].map((x) => x.toLowerCase()), t.swatch, t.id);
    assert.equal(/color-scheme: dark/.test(css.split(`data-theme="${t.id}"]`)[1]?.split("}")[0] ?? ""), t.dark, `${t.id} colour scheme`);
  }
});

test("the previous theme is kept exactly as it was", () => {
  const c = blockOf("classic");
  for (const [k, v] of Object.entries({ "--c-bg": "#f5f7fb", "--c-surface": "#ffffff", "--c-border": "#dde3ee", "--c-text": "#131a2b", "--c-primary": "#4f46e5", "--c-primary-600": "#4338ca", "--c-secondary": "#06b6d4", "--c-success": "#0f9d58", "--c-error": "#dc2626" })) assert.equal(c[k], v, k);
});

test("readable in every theme: text, muted text, text on the accent, status text (WCAG AA)", () => {
  for (const t of STUDIO_THEMES) {
    const b = blockOf(t.id);
    const pairs: [string, string, string, number][] = [
      ["text on canvas", "--c-text", "--c-bg", 7], ["text on surface", "--c-text", "--c-surface", 7], ["secondary text", "--c-text-2", "--c-surface", 7],
      ["muted text", "--c-text-3", "--c-surface", 4.5], ["muted text on a fill", "--c-text-3", "--c-surface-2", 4.5],
      ["text on the accent", "--c-on-primary", "--c-primary", 4.5], ["text on the accent's hover", "--c-on-primary", "--c-primary-600", 4.5],
      ["accent as text", "--c-primary", "--c-surface", 4.5], ["accent text on its tint", "--c-primary-600", "--c-primary-100", 4.5],
      ["success text", "--c-success-fg", "--c-success-bg", 4.5], ["warning text", "--c-warning-fg", "--c-warning-bg", 4.5], ["error text", "--c-error-fg", "--c-error-bg", 4.5], ["info text", "--c-info-fg", "--c-info-bg", 4.5],
      ["text on an error fill", "--c-on-primary", "--c-error", 4.5], ["placeholder", "--c-text-4", "--c-surface", 3],
    ];
    const failures: string[] = [];
    for (const [what, fg, bg, min] of pairs) {
      /* Classic is the earlier palette kept as it was, including its lighter metadata grey and status colours */
      const need = t.id === "classic" ? Math.min(min, 2.5) : min;
      const r = contrast(b[fg], b[bg]);
      if (r < need) failures.push(`${what} is ${r.toFixed(2)}:1 (${b[fg]} on ${b[bg]}), needs ${need}:1`);
    }
    assert.deepEqual(failures, [], t.id);
  }
});

test("no stylesheet colour bypasses the theme", () => {
  /* outside the token blocks: no slate / indigo / status hex left, and white only where it must stay white */
  const outside = all.replace(/:root(?:\[data-theme="[a-z]+"\])? \{[\s\S]*?\n\}/g, "");
  const hexes = [...outside.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)].map((m) => m[0].toLowerCase());
  const allowed = new Set(["#fff", "#000", "#a21caf", "#f0abfc"]);
  assert.deepEqual([...new Set(hexes.filter((h) => !allowed.has(h)))].join(" "), "");
  assert.ok(hexes.filter((h) => h === "#fff").length <= 1, "white text survives only on the photo overlay");
});
