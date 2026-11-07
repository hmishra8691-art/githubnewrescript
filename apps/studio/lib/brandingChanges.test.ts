import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBrandingChanges, metaFor } from "./brandingChanges.ts";

const base = { colors: { primary: "#2563eb", text: "#0f172a" }, layout: { radius: "12px", autoAdvance: undefined }, buttons: { nextLabel: "Next" } };

test("a colour change is named, shows before → after and the part of the page it affects", () => {
  const after = structuredClone(base); after.colors.primary = "#e11d48";
  const [c, ...rest] = describeBrandingChanges(base, after);
  assert.equal(rest.length, 0);
  assert.equal(c!.label, "Primary colour");
  assert.equal(c!.before, "#2563eb");
  assert.equal(c!.after, "#e11d48");
  assert.equal(c!.region, "buttons");
  assert.match(c!.impact, /buttons/);
});

test("switching a setting on from unset reads as default → on; nothing changed → nothing listed", () => {
  const after = structuredClone(base) as any; after.layout.autoAdvance = true;
  const [c] = describeBrandingChanges(base, after);
  assert.equal(c!.label, "Auto-next");
  assert.equal(c!.before, "default");
  assert.equal(c!.after, "on");
  assert.deepEqual(describeBrandingChanges(base, structuredClone(base)), []);
});

test("several fields under one heading collapse into it; unknown paths are humanised", () => {
  const after = { ...structuredClone(base), background: { image: "x.png", overlay: "rgba(0,0,0,.5)" } };
  const cs = describeBrandingChanges(base, after);
  assert.equal(cs.filter((c) => c.label === "Background image").length, 1);
  assert.equal(metaFor("layout.someNewThing").label, "Some New Thing");
});
