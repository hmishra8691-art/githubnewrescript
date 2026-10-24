import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * THE HIDDEN-QUESTION THEME AND THE AUTO-PUNCH CHROME, RENDERED (brief
 * 19/10/2026; docs/HIDDEN-AUTOPUNCH-2026-10-24.md).
 *
 * `packages/renderer/src/programmerView.tsx` is what `QuestionRenderer` puts
 * on a question's container when the Runner passes `programmerView` (preview
 * and test only). It is compiled here with the TypeScript compiler the
 * runtime already depends on (the renderer has no build step) and rendered
 * with React's server renderer, the way `conjointSuiteUi.test.ts` does.
 *
 * Per mode: live passes no view → no class, nothing rendered; preview / test
 * → the purple theme with banner, badge naming the mode, "Q6 — HIDDEN" and
 * the footer; a visible question with punch rules → the auto-punch block but
 * no hidden theme. The stylesheet that paints punched options green is scoped
 * to the one card and names only the punched codes.
 *
 *   node --experimental-strip-types --no-warnings --test apps/runtime/lib/hiddenQuestionUi.test.ts
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const req = createRequire(join(ROOT, "apps", "runtime", "package.json"));
const ts = req("typescript") as typeof import("typescript");
const { renderToStaticMarkup } = req("react-dom/server") as { renderToStaticMarkup: (el: unknown) => string };
const React = req("react") as typeof import("react");

async function load() {
  const out = mkdtempSync(join(tmpdir(), "rs-pv-"));
  const src = readFileSync(join(ROOT, "packages", "renderer", "src", "programmerView.tsx"), "utf8");
  let js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  js = js.replace(/from "react\/jsx-runtime"/g, `from "${pathToFileURL(req.resolve("react/jsx-runtime")).href}"`)
    .replace(/from "react"/g, `from "${pathToFileURL(req.resolve("react")).href}"`);
  writeFileSync(join(out, "programmerView.mjs"), js);
  const mod = await import(pathToFileURL(join(out, "programmerView.mjs")).href);
  rmSync(out, { recursive: true, force: true });
  return mod;
}

const q = { id: "q6", code: "Q6", text: "Preferred brand?", options: [{ code: "nike", label: "Nike" }, { code: "adidas", label: "Adidas" }] };
const applied = {
  status: "applied", statusLabel: "Auto-Punch Applied", statusIcon: "\u{1F7E2}",
  punchedCodes: ["adidas"], punchedRows: {}, selectedAnswer: "Adidas", expectedCodes: ["adidas"],
  rules: [{ ruleId: "r1", mode: "if", sourceQuestions: ["Q1"], condition: "Q1 is Adidas", target: "Q6", action: "select", selected: ["Adidas"], result: true, status: "applied" }],
};

test("live: no programmer view → no class, and nothing for the head or foot to draw from", async () => {
  const m = await load();
  assert.equal(m.programmerCardClass(null), "");
  assert.equal(m.programmerCardClass(undefined), "");
});

test("preview / test, hidden: purple theme classes, banner, badge naming the mode, 'Q6 — HIDDEN', eye-slash, footer", async () => {
  const m = await load();
  for (const mode of ["preview", "test"]) {
    const pv = { mode, hidden: true, autoPunch: null };
    assert.equal(m.programmerCardClass(pv), "rs-programmer-q rs-hidden-q");
    const head = renderToStaticMarkup(React.createElement(m.HiddenQuestionHead, { q, pv }));
    assert.match(head, /data-testid="rs-hidden-banner"/);
    assert.match(head, /Hidden Question:<\/strong> This question is not visible to respondents in the live survey\. It is displayed here for testing purposes only\./);
    assert.match(head, new RegExp(`HIDDEN QUESTION — ${mode.toUpperCase()} MODE`));
    assert.match(head, /Q6 — <span aria-hidden="true">\u{1F512}<\/span> HIDDEN/u);
    assert.match(head, /class="rs-hidden-eye"/);
    const foot = renderToStaticMarkup(React.createElement(m.ProgrammerFoot, { q, pv }));
    assert.match(foot, /Visibility: Hidden from live respondents/);
    assert.doesNotMatch(foot, /rs-autopunch/, "no auto-punch block without punch rules");
  }
});

test("a visible question with punch rules: the auto-punch block, no hidden theme", async () => {
  const m = await load();
  const pv = { mode: "preview", hidden: false, autoPunch: applied };
  assert.equal(m.programmerCardClass(pv), "rs-programmer-q rs-autopunch-q rs-autopunch-applied");
  assert.equal(renderToStaticMarkup(React.createElement(m.HiddenQuestionHead, { q, pv })), "", "no banner on a visible question");
  const foot = renderToStaticMarkup(React.createElement(m.ProgrammerFoot, { q, pv }));
  assert.match(foot, /data-status="applied"/);
  assert.match(foot, /Auto-Punch Status:<\/strong> <span aria-hidden="true">\u{1F7E2}<\/span> Auto-Punch Applied/u);
  assert.match(foot, /Selected Answer:<\/strong> Adidas/);
  for (const row of ["Source Question</th><td>Q1", "Condition</th><td>Q1 is Adidas", "Target Question</th><td>Q6", "Selected Option</th><td>Adidas", "Execution Result</th><td data-testid=\"rs-autopunch-result\">TRUE", "Status</th><td>Successfully Applied"]) {
    assert.ok(foot.includes(row), `details row: ${row}`);
  }
  assert.doesNotMatch(foot, /Hidden from live respondents/);
});

test("the green stylesheet is scoped to the card and names only the punched codes", async () => {
  const m = await load();
  const css = m.autoPunchCss("q6", applied);
  assert.match(css, /\.rs-card\[data-qid="q6"\] \[data-rs-el="option"\]\[data-rs-id="adidas"\]\{background:#DCFCE7/);
  assert.match(css, /content:"AUTO-PUNCHED"/);
  assert.match(css, /accent-color:#16A34A/);
  assert.doesNotMatch(css, /nike/, "a manual or unpunched option is never painted");
  const grid = m.autoPunchCss('we"ird', { ...applied, punchedCodes: [], punchedRows: { r1: ["5"] } });
  assert.match(grid, /\[data-qid="we\\"ird"\] \[data-rs-el="row"\]\[data-rs-id="r1"\] \[data-rs-el="option"\]\[data-rs-id="5"\]/, "grid cells, ids escaped");
});

test("statuses other than applied render their own label and a FALSE / NOT REACHED result", async () => {
  const m = await load();
  const waiting = { ...applied, status: "waiting", statusLabel: "Waiting for Condition", statusIcon: "\u{1F7E1}", punchedCodes: [], selectedAnswer: "",
    rules: [{ ...applied.rules[0], result: false, status: "condition_false" }, { ...applied.rules[0], ruleId: "r2", mode: "else_if", result: null, status: "not_reached" }] };
  const foot = renderToStaticMarkup(React.createElement(m.ProgrammerFoot, { q, pv: { mode: "test", hidden: true, autoPunch: waiting } }));
  assert.match(foot, /Waiting for Condition/);
  assert.match(foot, /Selected Answer:<\/strong> —/);
  assert.match(foot, /FALSE/);
  assert.match(foot, /NOT REACHED/);
  assert.match(foot, /Rule 2 \(ELSE IF\)/);
  assert.match(foot, /Hidden from live respondents/);
});
