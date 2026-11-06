import { test } from "node:test";
import assert from "node:assert/strict";
import { PLACES, DEFAULT_VIEW, placeOf, resolveTab, type WsTab } from "../components/analytics/navigation.ts";

/* the twelve tabs the workspace had before Phase 5, and the two views the five places added */
const EARLIER: WsTab[] = ["home", "plan", "analysis", "charts", "tables", "segments", "filters", "reports", "ask", "themes", "exports", "sharing", "findings", "architect", "board", "present"];

test("every earlier tab is reachable: it is a view of exactly one mode, or the Ask panel", () => {
  for (const t of EARLIER) {
    if (t === "ask") { assert.equal(resolveTab("ask"), "ask"); continue; }
    const holders = PLACES.filter((p) => p.views.some((v) => v.key === t));
    assert.equal(holders.length, 1, `${t} lives in ${holders.map((p) => p.key).join(", ") || "no mode"}`);
    assert.equal(placeOf(t), holders[0].key);
    assert.equal(resolveTab(t), t, `?tab=${t} still opens ${t}`);
  }
});

test("four modes in the order a researcher works — Overview → Explore → Architect → Present — and a first view for each", () => {
  assert.deepEqual(PLACES.map((p) => p.key), ["overview", "explore", "architect", "present"]);
  for (const p of PLACES) {
    assert.ok(p.views.length >= 1 && p.question.length > 0);
    assert.ok(p.views.some((v) => v.key === DEFAULT_VIEW[p.key]), `${p.key} opens on one of its own views`);
  }
  const all = PLACES.flatMap((p) => p.views.map((v) => v.key));
  assert.equal(new Set(all).size, all.length, "no view is in two modes");
});

test("links: a mode or an earlier place name opens its first view; spacing and case are forgiven; nonsense is nothing", () => {
  assert.equal(resolveTab("explore"), "board"); assert.equal(resolveTab("analysis"), "analysis");
  assert.equal(resolveTab("Present"), "present"); assert.equal(resolveTab("reports"), "reports");
  assert.equal(resolveTab("architect"), "architect");
  assert.equal(resolveTab(" findings "), "findings");
  assert.equal(resolveTab("overview"), "home");
  /* the five places of 2026-10 */
  assert.equal(resolveTab("plan"), "plan"); assert.equal(placeOf("plan"), "architect");
  assert.equal(resolveTab("deliver"), "reports");
  assert.equal(resolveTab("nope"), undefined);
  assert.equal(resolveTab(""), undefined);
  assert.equal(resolveTab(null), undefined);
  assert.equal(placeOf("ask"), "overview");
});
