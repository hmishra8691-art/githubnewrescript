import { test } from "node:test";
import assert from "node:assert/strict";
import { checkViewerRules, restrictToRule, ruleForViewer, type FrozenAnswers } from "./viewerAccess.js";
import type { AnalysisResult } from "./types.js";

/* R3 — each viewer sees only their segment; the others' numbers never leave the server */
const report = { viewerFilters: ["f-north", "f-south"], drillDown: { variable: "REGION", label: "Region", values: [{ value: 1, label: "North" }, { value: 2, label: "South" }] } };
const r = (name: string) => ({ name, base: { n: 100 } } as unknown as AnalysisResult);
const frozen: FrozenAnswers = {
  results: { a: r("all") },
  filters: [{ id: "f-north", name: "North stores" }, { id: "f-south", name: "South stores" }],
  filterResults: { "f-north": { a: r("north") }, "f-south": { a: r("south") } },
  drill: { label: "Region", values: report.drillDown.values, results: { "1": { a: r("d-north") }, "2": { a: r("d-south") } } },
};

test("rules are cleaned and checked against what the published version froze", () => {
  const { rules, problems } = checkViewerRules([
    { label: "HQ", domains: ["@Client.com"], sees: { kind: "all" } },
    { emails: ["Ann@North.client.com", "ann@north.client.com"], sees: { kind: "filter", filterId: "f-north" } },
    { emails: ["bad"], sees: { kind: "filter", filterId: "f-unknown" } },
    { domains: ["x.com"], sees: { kind: "drill", value: 9 } },
    { sees: { kind: "all" } },
  ], report);
  assert.deepEqual(rules[0].domains, ["client.com"]);
  assert.deepEqual(rules[1].emails, ["ann@north.client.com"]);
  assert.equal(problems.length, 4, problems.join(" | "));
  assert.ok(problems.some((p) => /“bad” is not an email/.test(p)));
  assert.ok(problems.some((p) => /not one of this report's viewer filters/.test(p)));
  assert.ok(problems.some((p) => /“9” is not one of this report's drill-down values/.test(p)));
  assert.ok(problems.some((p) => /Rule 5: say who/.test(p)));
});

test("an exact email beats a domain; the longest domain wins; nobody named sees nothing", () => {
  const { rules } = checkViewerRules([
    { id: "hq", domains: ["client.com"], sees: { kind: "all" } },
    { id: "north", domains: ["north.client.com"], sees: { kind: "filter", filterId: "f-north" } },
    { id: "ann", emails: ["ann@north.client.com"], sees: { kind: "drill", value: 2 } },
  ], report);
  assert.equal((ruleForViewer(rules, "ann@north.client.com") as { rule: { id: string } }).rule.id, "ann");
  assert.equal((ruleForViewer(rules, "bob@north.client.com") as { rule: { id: string } }).rule.id, "north");
  assert.equal((ruleForViewer(rules, "cy@client.com") as { rule: { id: string } }).rule.id, "hq");
  assert.match((ruleForViewer(rules, "eve@notclient.com") as { denied: string }).denied, /no part of its data/);
  assert.match((ruleForViewer(rules, "eve@evilclient.com") as { denied: string }).denied, /no part/, "a suffix that is not a subdomain does not match");
  assert.match((ruleForViewer(rules, null) as { denied: string }).denied, /Sign in/);
});

test("a restricted viewer receives only their segment as the main results, with no other segment in the payload", () => {
  const north = restrictToRule(frozen, { id: "n", domains: ["x.com"], sees: { kind: "filter", filterId: "f-north" } });
  assert.ok("view" in north);
  if ("view" in north) {
    assert.equal(north.view.results.a.name, "north");
    assert.equal(north.view.filterResults, null);
    assert.equal(north.view.drill, null);
    assert.equal(north.view.scopeLabel, "North stores");
    assert.ok(!JSON.stringify(north.view).includes("south"), "nothing of the South leaves");
  }
  const d = restrictToRule(frozen, { id: "d", domains: ["x.com"], sees: { kind: "drill", value: 2 } });
  assert.ok("view" in d && d.view.results.a.name === "d-south" && d.view.scopeLabel === "Region: South");
  const all = restrictToRule(frozen, { id: "a", domains: ["x.com"], sees: { kind: "all" } });
  assert.ok("view" in all && all.view.filterResults !== null);
  assert.ok("missing" in restrictToRule({ ...frozen, filterResults: null }, { id: "m", domains: ["x.com"], sees: { kind: "filter", filterId: "f-north" } }));
});
