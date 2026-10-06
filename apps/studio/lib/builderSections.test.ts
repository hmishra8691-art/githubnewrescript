import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * THE SEARCH-BOX SETTING IS OFFERED ONLY WHERE A SEARCH BOX IS DRAWN
 * (October 2026 review).
 *
 * The question editor shows "Search box" for the renderer keys in the
 * engine's OPTION_SEARCH_RENDERERS. It used to list eleven, but only three
 * renderers ever called `useOptionFilter` — so Card / Icon / List / Image
 * Select, Dropdown, Multi-Select Dropdown and Adaptive showed a control that
 * changed nothing, which the review asked to remove. This reads both sources
 * and holds them equal: a renderer that starts drawing a search box must be
 * added to the set, and one that stops must leave it.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const rendererSrc = join(root, "packages/renderer/src");

/** Each component that calls useOptionFilter, and the renderer key it is drawn under. */
const KEY_OF: Record<string, string> = {
  SingleSelect: "base:single_select",
  MultiSelect: "base:multi_select",
  ChoiceButtons: "buttons",
};

function callers(): string[] {
  const files = [join(rendererSrc, "QuestionRenderer.tsx"),
    ...readdirSync(join(rendererSrc, "variants")).filter((f) => f.endsWith(".tsx")).map((f) => join(rendererSrc, "variants", f))];
  const out = new Set<string>();
  for (const f of files) {
    let fn = "";
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
      if (m) fn = m[1];
      if (/\buseOptionFilter\(/.test(line) && !/function\s+useOptionFilter/.test(line)) out.add(fn);
    }
  }
  return [...out].sort();
}

function searchSet(): string[] {
  const src = readFileSync(join(root, "packages/engine/src/rendererReads.ts"), "utf8");
  const m = /OPTION_SEARCH_RENDERERS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(m, "OPTION_SEARCH_RENDERERS found");
  return [...m[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

test("every renderer that draws a search box is mapped to its key", () => {
  const found = callers();
  assert.ok(found.length >= 3, `callers found: ${found.join(", ")}`);
  for (const fn of found) assert.ok(KEY_OF[fn], `${fn} calls useOptionFilter — map it to its renderer key here and add the key to OPTION_SEARCH_RENDERERS`);
});

test("OPTION_SEARCH_RENDERERS is exactly the renderers that draw a search box", () => {
  assert.deepEqual(searchSet(), callers().map((fn) => KEY_OF[fn]).sort());
  for (const dead of ["cards", "icons", "listrows", "adaptive", "base:dropdown", "base:multi_dropdown", "base:image_select"]) {
    assert.ok(!searchSet().includes(dead), `${dead} draws no search box`);
  }
});
