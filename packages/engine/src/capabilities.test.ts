import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_METHODS, questionTypeRegistry } from "@rescript/schema";
import { capabilitiesMentioned, capabilityBrief, capabilityMarkdown, capabilityOf, capabilityRegistry, copilotQuestionTypes, METHOD_CHART, METHODOLOGIES, methodologiesNamed, UNSUPPORTED_PROCEDURES } from "./capabilities.js";
import { SURVEY_ACTION_OPS } from "./surveyActions.js";

/*
 * RESEARCH INTELLIGENCE (2026-10-17) — the capability registry is derived from
 * the real registries (question types, the plan's analysis methods, the action
 * vocabulary), so it cannot say something exists that does not, or miss
 * something that does.
 */

test("the brief the model reads and the page the docs print come from the registry", () => {
  const brief = capabilityBrief();
  assert.match(brief, /^CAPABILITIES \(from the registry\)\. Methodologies: /);
  for (const m of METHODOLOGIES) assert.ok(brief.includes(m.name), m.name);
  assert.ok(brief.length < 2200, `brief ${brief.length}`);
  const md = capabilityMarkdown();
  for (const h of ["## Methodologies", "## Analytical procedures", "## Qualitative support", "## Question types", "## Exports and documents"]) assert.ok(md.includes(h), h);
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const page = readFileSync(join(ROOT, "apps", "studio", "content", "docs", "capabilities.md"), "utf8");
  assert.ok(page.endsWith(md), "the public page is the registry (node scripts/gen-public-docs.mjs)");
});

test("derived: every registered question type and every plan analysis method is in it — a plugin registered later too", () => {
  const reg = capabilityRegistry();
  const types = reg.filter((c) => c.kind === "question_type").map((c) => c.id.replace("question_type:", "")).sort();
  assert.deepEqual(types, questionTypeRegistry.all().map((p) => p.type).sort());
  for (const m of ANALYSIS_METHODS) {
    assert.ok(capabilityOf(`analysis:${m}`), m);
    assert.ok(METHOD_CHART[m], `a chart for ${m}`);
  }
  questionTypeRegistry.register({ type: "zz_cap_plugin", label: "Cap plugin", category: "custom", features: {}, variables: () => [], create: (p: unknown) => p } as never);
  assert.ok(capabilityOf("question_type:zz_cap_plugin"), "no stale cache");
  assert.match(capabilityOf("question_type:zz_cap_plugin")!.note ?? "", /no Intelligent-mode create/);
});

test("the methodologies name only what exists: registered question types, engine actions, plan methods", () => {
  const registered = new Set(questionTypeRegistry.all().map((p) => p.type));
  for (const m of METHODOLOGIES) {
    for (const t of m.questionTypes) assert.ok(registered.has(t), `${m.id}: ${t}`);
    for (const a of m.actions) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(a), `${m.id}: ${a}`);
    for (const a of m.analysis) assert.ok((ANALYSIS_METHODS as readonly string[]).includes(a), `${m.id}: ${a}`);
    assert.ok(m.status !== "partial" || m.note, `${m.id}: a partial methodology says what works`);
  }
  /* 2026-10-22: hb, latent_class and sem became plan methods; their records stay in UNSUPPORTED_PROCEDURES under the same id and the registry files each ONCE, as the method */
  const MERGED = new Set(["analysis:hb", "analysis:latent_class", "analysis:sem"]);
  for (const u of UNSUPPORTED_PROCEDURES) if (!MERGED.has(u.id)) assert.ok(!(ANALYSIS_METHODS as readonly string[]).includes(u.id.replace(/^\w+:/, "")), `${u.id} became a method — update the registry`);
  const ids = capabilityRegistry().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "no capability id twice");
  for (const id of MERGED) assert.deepEqual(capabilityOf(id)?.implementedAs?.analysis, [id.replace("analysis:", "")], `${id} is a plan method`);
  for (const c of capabilityRegistry()) if (c.status === "not_supported") assert.ok(c.note, `${c.id}: names the alternative`);
  assert.ok(copilotQuestionTypes().has("single_select") && copilotQuestionTypes().has("maxdiff_task"));
});

test("asked by the copilot's refusal / clarify logic: what a request names, with its status", () => {
  const ids = (t: string) => capabilitiesMentioned(t).map((c) => `${c.id}:${c.status}`);
  /* F3 2026-10-22: HB is a plan method (a background job) — supported; latent class stays partial (no covariates) */
  assert.ok(ids("estimate HB utilities for the conjoint").includes("analysis:hb:supported"));
  assert.ok(ids("segment them with latent class").includes("analysis:latent_class:partial"));
  assert.ok(ids("fit a structural equation model").includes("analysis:sem:supported"));
  assert.ok(ids("a gabor-granger demand curve").includes("methodology:gabor_granger:supported"));
  assert.ok(ids("run two focus groups first").includes("qualitative:moderated:not_supported"));
  assert.ok(ids("a sequential monadic test of 3 concepts").includes("methodology:sequential_monadic:partial"));
  assert.ok(ids("van westendorp pricing").includes("methodology:van_westendorp:supported"));
  assert.deepEqual(methodologiesNamed("Online survey with a MaxDiff of features").map((m) => m.id), ["maxdiff"]);
  assert.deepEqual(methodologiesNamed("online survey").map((m) => m.id), ["survey"]);
});
