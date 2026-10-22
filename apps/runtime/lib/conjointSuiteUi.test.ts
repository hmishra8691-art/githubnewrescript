import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * THE CONJOINT SUITE'S RESPONDENT UI, RENDERED (F4, 2026-10-22).
 *
 * The rating-based (CVA) task renderer and the dual-response follow-up are rendered to HTML with
 * React's server renderer — the same components the runtime and the Studio preview mount. The renderer
 * package has no build step (Next transpiles it), so this compiles the two source files with the
 * TypeScript compiler the runtime already depends on and imports the result; nothing else is mocked.
 * What is checked: every task of the respondent's version with its profile, the scale's points and end
 * labels, the stored rating checked, the follow-up shown only once a choice is made, and its answer.
 *
 *   node --experimental-strip-types --no-warnings --test apps/runtime/lib/conjointSuiteUi.test.ts
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const req = createRequire(join(ROOT, "apps", "runtime", "package.json"));
const ts = req("typescript") as typeof import("typescript");

async function loadRenderer() {
  const out = mkdtempSync(join(tmpdir(), "rs-cj-"));
  const engine = pathToFileURL(join(ROOT, "packages", "engine", "dist", "index.js")).href;
  const reactJsx = pathToFileURL(req.resolve("react/jsx-runtime")).href;
  const react = pathToFileURL(req.resolve("react")).href;
  for (const f of ["conjointSuite", "registry"]) {
    const src = readFileSync(join(ROOT, "packages", "renderer", "src", "variants", `${f}.tsx`), "utf8");
    let js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    js = js.replace(/from "@rescript\/engine"/g, `from "${engine}"`).replace(/from "react\/jsx-runtime"/g, `from "${reactJsx}"`).replace(/from "react"/g, `from "${react}"`).replace(/from "\.\/registry"/g, `from "./registry.mjs"`);
    writeFileSync(join(out, `${f}.mjs`), js);
  }
  const mod = await import(pathToFileURL(join(out, "conjointSuite.mjs")).href);
  const reg = await import(pathToFileURL(join(out, "registry.mjs")).href);
  rmSync(out, { recursive: true, force: true });
  const { renderToStaticMarkup } = req("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
  const { createElement } = req("react") as { createElement: (...a: unknown[]) => unknown };
  return { mod, reg, html: (C: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(C, props)) };
}

const cvaRows = [1, 2, 3].flatMap((task) => [{ version: 1, task, alt: 1, is_holdout: 0, Brand: ["Alpha", "Beta", "Gamma"][task - 1], Speed: task % 2 ? "Fast" : "Slow" }, { version: 2, task, alt: 1, is_holdout: 0, Brand: "Beta", Speed: "Slow" }]);
const def = {
  meta: { id: "s", code: "S", title: "T", version: "1" },
  designs: [
    { id: "d_cva", kind: "cva", name: "CVA", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Speed", levels: ["Slow", "Fast"] }], scaleMin: 0, scaleMax: 10, maxLabel: "Would surely buy" }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand", "Speed"], rows: cvaRows } },
    { id: "d_pair", kind: "cva", name: "Pairs", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta"] }], mode: "paired" }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand"], rows: [{ version: 1, task: 1, alt: 1, is_holdout: 0, Brand: "Alpha" }, { version: 1, task: 1, alt: 2, is_holdout: 0, Brand: "Beta" }] } },
    { id: "d_dual", kind: "conjoint", name: "Dual", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta"] }], dualResponseNone: true, dualResponsePrompt: "Would you really buy it?" }, file: { format: "json", columns: ["version", "task", "alt", "is_holdout", "Brand", "none_option"], rows: [] } },
    { id: "d_plain", kind: "conjoint", name: "Plain", version: 1, config: { attributes: [{ name: "Brand", levels: ["Alpha", "Beta"] }] }, file: { format: "json", columns: [], rows: [] } },
  ],
  questions: [
    { id: "q_cva", code: "Q1", variableName: "CVA", type: "conjoint_task", variant: "conjoint.cva", text: "Rate", settings: { designRef: "d_cva" } },
    { id: "q_pair", code: "Q2", variableName: "PAIR", type: "conjoint_task", variant: "conjoint.cva", text: "Compare", settings: { designRef: "d_pair" } },
    { id: "q_dual", code: "Q3", variableName: "DUAL", type: "conjoint_task", text: "Choose", settings: { designRef: "d_dual" } },
    { id: "q_plain", code: "Q4", variableName: "PLAIN", type: "conjoint_task", text: "Choose", settings: { designRef: "d_plain" } },
  ],
  flow: [],
};
/* seed 1 → version 1 of the two (designVersionFor: hash of the seed and the question) — found, not assumed */
const props = (q: number, value: unknown, seed: number) => ({ def, q: def.questions[q], state: { seed, answers: {} }, loop: null, value, errors: [], onChange: () => {} });

test("CVA renderer: the respondent's tasks with their profiles, a 0–10 scale with its end labels, the stored rating checked; pairs side by side; registered as cvatasks", async () => {
  const { mod, reg, html } = await loadRenderer();
  assert.equal(reg.variantRenderers.cvatasks, mod.CvaTasks, "registered under the variant's renderer key");
  const { designVersionFor } = await import(pathToFileURL(join(ROOT, "packages", "engine", "dist", "index.js")).href);
  const seed = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => designVersionFor(def.questions[0], cvaRows, s) === "1")!;
  const out = html(mod.CvaTasks, props(0, { "2": 7 }, seed));
  for (const t of ["1", "2", "3"]) assert.ok(out.includes(`data-testid="cva-task-${t}"`), t);
  assert.ok(out.includes(">Alpha<") && out.includes(">Gamma<"), "version 1's profiles");
  assert.equal((out.match(/data-testid="cva-rate-1-/g) ?? []).length, 11, "0 … 10");
  assert.ok(/data-testid="cva-rate-2-7"[^>]*checked|checked=""[^>]*data-testid="cva-rate-2-7"/.test(out), "the stored rating is checked");
  assert.ok(out.includes("Definitely would not buy") && out.includes("Would surely buy"), "default and configured end labels");
  const pair = html(mod.CvaTasks, props(1, {}, 1));
  assert.equal((pair.match(/data-testid="cva-profile"/g) ?? []).length, 2);
  assert.ok(pair.includes("Left") && pair.includes("Right") && pair.includes("Strongly prefer the left"));
  assert.equal((pair.match(/data-testid="cva-rate-1-/g) ?? []).length, 9, "1 … 9");
  const wrong = html(mod.CvaTasks, props(2, {}, 1));
  assert.match(wrong, /not generated yet|needs a Rating-based conjoint/);
});

test("dual-response follow-up: shown only once the task has a choice, with the design's prompt; the answer is checked; never on a plain CBC", async () => {
  const { mod, html } = await loadRenderer();
  const F = mod.DualResponseFollowUp;
  const base = { def, q: def.questions[2], task: "1", onChange: () => {} };
  assert.equal(html(F, { ...base, value: {} }), "", "no choice yet → no follow-up");
  const shown = html(F, { ...base, value: { "1": "2" } });
  assert.ok(shown.includes("Would you really buy it?") && shown.includes('data-testid="cbc-buy-1-yes"') && shown.includes('data-testid="cbc-buy-1-no"'));
  const answered = html(F, { ...base, value: { "1": "2", "1_buy": "no" } });
  assert.ok(/data-testid="cbc-buy-1-no"[^>]*checked|checked=""[^>]*data-testid="cbc-buy-1-no"/.test(answered));
  assert.equal(html(F, { ...base, q: def.questions[3], value: { "1": "2" } }), "", "a design without dual-response never asks");
});
