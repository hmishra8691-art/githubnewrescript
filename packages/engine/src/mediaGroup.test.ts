import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaGroupHtml, mediaGroupFromAttrs, mediaDisplayCss, mediaDisplayFromCss, MEDIA_GROUP_LAYOUTS } from "./mediaDisplay.js";
import { sanitizeHtml } from "./html.js";
import { renderRichContent } from "./scopedHtml.js";

/*
 * INSERT MEDIA — SEVERAL ITEMS AND HOW THEY SIT (October 2026 review):
 * Vertical (default) / Horizontal / Grid (columns) / Carousel, with gap and
 * alignment; for images "Original Size" and "Custom Width/Height".
 */
const A = '<img src="https://x/a.png" alt="A">';
const B = '<video src="https://x/b.mp4" controls preload="metadata"></video>';

test("mediaGroupHtml — the layout travels with the media, through the sanitizer and the render pipeline", () => {
  assert.deepEqual(MEDIA_GROUP_LAYOUTS.map((l) => l.value), ["vertical", "horizontal", "grid", "carousel"]);
  const grid = mediaGroupHtml([A, B], { layout: "grid", columns: 3, gap: 16, align: "center" });
  assert.match(grid, /^<div class="rs-media-group" data-rs-layout="grid" data-rs-cols="3" data-rs-align="center" style="gap: 16px">/);
  assert.match(grid, /<div class="rs-media-cell"><img src="https:\/\/x\/a\.png"/);
  assert.match(grid, /<div class="rs-media-cell"><video /, "mixed media in one group");
  const drawn = renderRichContent(`<p>Look</p>${grid}`, "q1");
  assert.match(drawn, /data-rs-layout="grid" data-rs-cols="3" data-rs-align="center" style="gap: 16px"/, "survives sanitising");
  const vertical = mediaGroupHtml([A, B], { layout: "vertical" });
  assert.match(vertical, /data-rs-layout="vertical"/);
  assert.doesNotMatch(vertical, /data-rs-cols/, "columns belong to a grid");
  assert.match(mediaGroupHtml([A, B], { layout: "grid", columns: 9 }), /data-rs-cols="4"/, "1–4 columns");
});

test("mediaGroupFromAttrs — the editor reopens a group with what was chosen", () => {
  const html = mediaGroupHtml([A, B], { layout: "carousel", gap: 0 });
  const attrs = Object.fromEntries([...html.slice(0, html.indexOf(">")).matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(mediaGroupFromAttrs((n) => attrs[n] ?? null), { layout: "carousel", gap: 0, align: "left" });
  assert.equal(mediaGroupFromAttrs(() => null), null);
  assert.equal(mediaGroupFromAttrs((n) => (n === "data-rs-layout" ? "spiral" : null)), null, "an unknown layout is no group");
});

test("fit: Original size and Custom size, written as CSS and read back", () => {
  const orig = mediaDisplayCss({ fit: "original", width: "300px" });
  assert.match(orig, /width: auto; height: auto/);
  assert.match(orig, /max-width: 100%/, "still shrinks on a narrow screen");
  assert.equal(mediaDisplayFromCss(orig).fit, "original");
  const custom = mediaDisplayCss({ fit: "custom", width: "320px", height: "180px" });
  assert.match(custom, /width: 320px; height: 180px/);
  assert.match(custom, /object-fit: contain/, "proportions kept by letterboxing");
  assert.match(mediaDisplayCss({ fit: "custom", width: "320px", height: "180px", keepRatio: false }), /object-fit: fill/);
  assert.equal(mediaDisplayFromCss(custom).fit, "custom");
  assert.equal(mediaDisplayFromCss(mediaDisplayCss({ fit: "cover" })).fit, "cover", "the existing fits are unchanged");
  assert.match(sanitizeHtml(`<img src="https://x/a.png" style="${custom}">`), /--rs-fit: custom/, "the intent survives sanitising");
});
