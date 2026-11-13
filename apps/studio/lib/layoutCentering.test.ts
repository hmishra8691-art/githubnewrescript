/**
 * LAYOUT CENTERING (layout brief §12, 2026-10-17) — the unit half.
 * The browser half, with measurements at five viewports, is scripts/layout-centering-test.mjs.
 *
 * 1. A theme never moves the survey frame: `contentAlign` (default "left", stored on every survey)
 *    used to become the frame's margins, so any theme narrower than the window pinned the survey
 *    to the left edge. It now only aligns the text inside the frame.
 * 2. The stylesheet rules that keep Intelligent Mode centred and free of sideways scroll stay put.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SurveyDefinition } from "@rescript/schema";
import { brandingVars, contentAlignVars } from "../../../packages/renderer/src/branding.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const css = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** the declarations of the first top-level rule whose selector is exactly `sel` */
const rule = (src: string, sel: string): string => {
  const i = src.search(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`));
  assert.ok(i >= 0, `no rule for ${sel}`);
  const open = src.indexOf("{", i);
  return src.slice(open + 1, src.indexOf("}", open));
};
const branding = (layout: Record<string, unknown>) => SurveyDefinition.parse({
  meta: { id: "lc", code: "LC", title: "LC" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }], branding: { layout },
}).branding;

test("contentAlign never sets the frame's margins — 'left' (the stored default) sets nothing at all", () => {
  assert.deepEqual(contentAlignVars("left"), {});
  assert.deepEqual(contentAlignVars(undefined), {});
  assert.deepEqual(contentAlignVars("center"), { "--rs-content-align": "center", "--rs-align-ml": "auto", "--rs-align-mr": "auto" });
  assert.deepEqual(contentAlignVars("right"), { "--rs-content-align": "right", "--rs-align-ml": "auto", "--rs-align-mr": "0" });
  const def = brandingVars(branding({ widthMode: "contained", maxWidth: "640px" }));
  assert.equal(def["--rs-align-ml"], undefined, "a contained theme with the default alignment no longer zeroes the left margin");
  assert.equal(def["--rs-content-align"], undefined);
  assert.equal(def["--rs-max-width"], "640px", "the width still reaches the frame");
  assert.equal(brandingVars(branding({ contentAlign: "center" }))["--rs-content-align"], "center");
});

test("the survey frame is centred by the stylesheet, not by a theme variable", () => {
  const q = css("packages/renderer/styles/questions.css");
  const shell = rule(q, ".rs-shell");
  assert.match(shell, /margin-left:\s*auto;/);
  assert.match(shell, /margin-right:\s*auto;/);
  assert.doesNotMatch(shell, /--rs-align-m[lr]/, "the frame's margins do not read the alignment variables");
  assert.match(rule(q, ".rs-qtext, .rs-qinstruction"), /text-align:\s*var\(--rs-content-align,\s*start\)/, "alignment is the text's, defaulting to the writing direction");
  assert.match(q, /\.rs-qtext, \.rs-qinstruction \{ overflow-wrap: break-word; \}/, "a long word wraps in the question text");
});

test("Intelligent Mode: one centred column, no sideways scroll, a toolbar that wraps, a menubar probe with no width", () => {
  const d = css("apps/studio/app/design-system.css");
  assert.match(rule(d, ".iq"), /--iq-column:\s*860px/);
  for (const sel of [".iq-welcome", ".iq-turn"]) {
    const r = rule(d, sel);
    assert.match(r, /max-width:\s*var\(--iq-column\)/, `${sel} uses the column`);
    assert.match(r, /margin:\s*\S+\s+auto/, `${sel} is centred`);
  }
  assert.match(rule(d, ".iq-turn"), /overflow-wrap:\s*anywhere/);
  assert.match(rule(d, ".iq-ask"), /calc\(\(100% - var\(--iq-column\)\) \/ 2\)/, "the ask bar lines up with the column");
  assert.match(rule(d, ".iq-toolbar"), /flex-wrap:\s*wrap/);
  assert.match(rule(d, ".iq-hint"), /flex:\s*1 1 0/);
  const probe = rule(d, ".menubar-measure");
  assert.match(probe, /width:\s*0/); assert.match(probe, /overflow:\s*hidden/);
});
