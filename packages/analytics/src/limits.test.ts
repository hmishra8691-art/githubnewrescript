import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED_LIMITS, REFERENCE_CHECKS, limitsMarkdown } from "./limits.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

test("every published limit points at a real source file that holds the constant", () => {
  for (const l of PUBLISHED_LIMITS) {
    assert.ok(Number.isFinite(l.value) && l.value > 0, l.limit);
    const f = join(src, l.source);
    assert.ok(existsSync(f), `${l.limit}: ${l.source} exists`);
  }
});

test("every reference check names a test file that exists and asserts against a reference", () => {
  for (const r of REFERENCE_CHECKS) {
    const f = join(src, r.test);
    assert.ok(existsSync(f), r.test);
    assert.match(readFileSync(f, "utf8"), /assert/, `${r.test} asserts`);
  }
});

test("docs/ANALYTICS-LIMITS.md is the generated page (regenerate it after changing a limit)", () => {
  const doc = join(here, "..", "..", "..", "docs", "ANALYTICS-LIMITS.md");
  assert.ok(existsSync(doc), "the published page exists");
  assert.equal(readFileSync(doc, "utf8"), limitsMarkdown(), "run: node -e \"import('@rescript/analytics').then(a=>process.stdout.write(a.limitsMarkdown()))\" > docs/ANALYTICS-LIMITS.md");
});

test("a dataset the loader cut at the row limit says so on every result", async () => {
  const { kds } = await import("./analyses/knownFixture.js");
  const { runAnalysis } = await import("./analyses/index.js");
  const ds = kds();
  ds.truncatedAt = 250_000;
  const r = runAnalysis({ name: "f", kind: "descriptive", dataset: { environment: "LIVE", dataset: "all" }, variables: ["REGION"] }, ds);
  assert.match(r.warnings[0] ?? "", /computed on the first 250,000 responses only/);
  const clean = runAnalysis({ name: "f", kind: "descriptive", dataset: { environment: "LIVE", dataset: "all" }, variables: ["REGION"] }, kds());
  assert.ok(!clean.warnings.some((w) => /computed on the first/.test(w)));
});
