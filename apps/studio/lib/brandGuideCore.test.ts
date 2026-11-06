import { test } from "node:test";
import assert from "node:assert/strict";
import { readBrandGuide } from "./brandGuideCore.ts";

test("a brand book's colours and typefaces, with the roles their words give them", () => {
  const r = readBrandGuide([["Brand colours", "Primary blue — HEX #0B3D91 RGB 11 61 145", "Secondary teal #1FA2A6", "Accent: CTA orange rgb(242, 140, 40)", "Background grey #F4F5F7", "Typography", "Primary typeface: Montserrat; body text Helvetica Neue"]]);
  assert.deepEqual(r.seeds.map((s) => [s.hex, s.role]), [["#0b3d91", "primary"], ["#1fa2a6", "secondary"], ["#f28c28", "accent"], ["#f4f5f7", "background"]]);
  assert.deepEqual(r.fonts, ["Montserrat", "Helvetica Neue"]);
  assert.equal(r.scanned, false);
});
test("a scanned PDF has no text to read", () => {
  assert.equal(readBrandGuide([[]]).scanned, true);
});
