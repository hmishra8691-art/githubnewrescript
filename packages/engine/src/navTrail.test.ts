import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { start, advance, setAnswer, goBack } from "./flow.js";
import { navTrailOf, sanitizeNavTrail, restoreNavTrail, goToPage, NAV_TRAIL_MAX_IDS } from "./sectionNav.js";

/** THE TRAIL IN THE RESPONSE ROW (migration 0077): what the save stores, checked against the definition. */
const yesNo = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const q = (id: string) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: id, options: yesNo, required: true });
export const navDef = () => SurveyDefinition.parse({
  meta: { id: "trail", code: "TR", title: "Trail", version: "1" },
  navigation: { sectionNav: "visited" },
  questions: [q("h1"), q("h2"), q("g1"), q("p1"), q("r1")],
  flow: [
    { type: "block", id: "b_hist", title: "History", children: [{ type: "page", id: "ph1", questionIds: ["h1"] }, { type: "page", id: "ph2", questionIds: ["h2"] }] },
    { type: "block", id: "b_geo", title: "Geography", children: [{ type: "page", id: "pg1", questionIds: ["g1"] }] },
    { type: "block", id: "b_pol", title: "Polity", children: [
      { type: "page", id: "pp1", questionIds: ["p1"] },
      { type: "loop", id: "lp", loopVar: "x", source: { kind: "static", items: [{ code: "a", label: "A" }, { code: "b", label: "B" }] }, children: [{ type: "page", id: "pr", questionIds: ["r1"] }] },
    ] },
    { type: "end", id: "e", status: "complete" },
  ],
});

test("navTrailOf: the Back trail, the pages seen and the current page — null before anything happened", () => {
  const def = navDef();
  const st = createResponseState(def);
  start(def, st);
  assert.equal(navTrailOf(st), null);
  setAnswer(def, st, "h1", "1", null); advance(def, st, {}, { fromPageId: "ph1" });
  setAnswer(def, st, "h2", "1", null); advance(def, st, {}, { fromPageId: "ph2" });
  assert.deepEqual(navTrailOf(st, "pg1"), { v: 1, stack: ["ph1", "ph2"], visited: ["ph1", "ph2"], at: "pg1" });
});

test("sanitizeNavTrail: page ids of THIS definition only (loop iterations by their page), bounded, deduplicated; unknown ids dropped and counted", () => {
  const def = navDef();
  const r = sanitizeNavTrail(def, { v: 1, stack: ["ph1", "ph1", "ph2", "nope", 7, "pr@a", "x".repeat(200)], visited: ["ph1", "ph2", "ph1", "gone@b", "pr@b"], at: "pg1" });
  assert.deepEqual(r.trail, { v: 1, stack: ["ph1", "ph2", "pr@a"], visited: ["ph1", "ph2", "pr@b"], at: "pg1" });
  assert.equal(r.dropped, 4);
  assert.equal(sanitizeNavTrail(def, null).trail, null);
  assert.match(sanitizeNavTrail(def, ["ph1"]).invalid ?? "", /object/);
  assert.match(sanitizeNavTrail(def, { v: 2, stack: [] }).invalid ?? "", /version 2/);
  assert.equal(sanitizeNavTrail(def, { v: 1, stack: "ph1" }).dropped, 1, "a non-array list is dropped");
  assert.equal(sanitizeNavTrail(def, { v: 1, stack: ["nope"] }).trail, null, "nothing left → nothing stored");
  const long = Array.from({ length: 5000 }, (_, i) => (i % 2 ? "ph1" : "ph2"));
  assert.equal(sanitizeNavTrail(def, { v: 1, stack: long }).trail!.stack.length, NAV_TRAIL_MAX_IDS);
});

test("restoreNavTrail: Back and the navigator read the restored trail exactly as they read the original", () => {
  const def = navDef();
  const a = createResponseState(def);
  start(def, a);
  setAnswer(def, a, "h1", "1", null); advance(def, a, {}, { fromPageId: "ph1" });
  setAnswer(def, a, "h2", "1", null); advance(def, a, {}, { fromPageId: "ph2" });
  setAnswer(def, a, "g1", "1", null); advance(def, a, {}, { fromPageId: "pg1" });
  goToPage(def, a, "b_hist");                      // back to ph1: the trail is trimmed, pp1 stays seen
  const stored = sanitizeNavTrail(def, JSON.parse(JSON.stringify(navTrailOf(a, "ph1")))).trail;
  // another device: the same answers and position, no meta
  const b = createResponseState(def);
  b.answers = { ...a.answers }; b.stepIndex = a.stepIndex;
  restoreNavTrail(b, stored);
  // before any move: the navigator's view is the same (Polity was seen on device A, so it is reachable on B)
  const fwdA = goToPage(def, a, "b_pol");
  const fwdB = goToPage(def, b, "b_pol");
  assert.equal(fwdA.ok, true); assert.equal(fwdB.ok, true, fwdB.reason);
  assert.equal(fwdB.via, "visited");
  const page = (r: { steps: { kind: string; pageId?: string }[]; stepIndex: number }) => r.steps[r.stepIndex]?.pageId;
  assert.equal(page(fwdB), "pp1");
  assert.equal(page(goBack(def, b)), page(goBack(def, a)), "Back goes to the same page on both devices");
  assert.equal(page({ steps: fwdB.steps, stepIndex: b.stepIndex }), "pg1");
});

test("chooseNavTrail: the row's trail on another device; the newer of the two on this one; stale ids dropped", async () => {
  const { chooseNavTrail } = await import("./sectionNav.js");
  const def = navDef();
  const server = { nav: { v: 1, stack: ["ph1", "ph2"], visited: ["ph1", "ph2", "pg1"], at: "pp1" }, savedAt: "2026-10-30T10:00:00.000Z" };
  const browser = { visited: ["ph1"], seen: ["ph1"], at: Date.parse("2026-10-30T09:00:00.000Z") };
  // another device: no browser copy
  assert.deepEqual(chooseNavTrail(def, server, null), { source: "server", trail: server.nav, dropped: 0 });
  // this device, the row saved later → the row
  assert.equal(chooseNavTrail(def, server, browser).source, "server");
  // this device, a browser copy written after the last save that reached the server → the browser
  const later = { ...browser, at: Date.parse("2026-10-30T11:00:00.000Z") };
  const b = chooseNavTrail(def, server, later);
  assert.equal(b.source, "browser");
  assert.deepEqual(b.trail, { v: 1, stack: ["ph1"], visited: ["ph1"] });
  // the same instant: the row (the server is the shared truth)
  assert.equal(chooseNavTrail(def, server, { ...browser, at: Date.parse(server.savedAt) }).source, "server");
  // a row without a time (pre-0006): a browser copy with a time is preferred only if the row has nothing
  assert.equal(chooseNavTrail(def, { nav: server.nav, savedAt: null }, browser).source, "browser");
  // nothing anywhere
  assert.deepEqual(chooseNavTrail(def, null, null), { source: null, trail: null, dropped: 0 });
  assert.deepEqual(chooseNavTrail(def, { nav: null }, null), { source: null, trail: null, dropped: 0 });
});

test("chooseNavTrail: a new survey version — pages it deleted are dropped from the row's trail; a trail left empty falls back to the browser", async () => {
  const { chooseNavTrail } = await import("./sectionNav.js");
  const v2 = navDef();
  v2.flow = v2.flow.filter((n) => n.id !== "b_geo");          // version 2 deleted Geography (pg1)
  const server = { nav: { v: 1, stack: ["ph1", "pg1"], visited: ["ph1", "pg1", "pr@b"] }, savedAt: "2026-10-30T10:00:00.000Z" };
  const r = chooseNavTrail(v2, server, null);
  assert.deepEqual(r.trail, { v: 1, stack: ["ph1"], visited: ["ph1", "pr@b"] });
  assert.equal(r.dropped, 2);
  const onlyDeleted = { nav: { v: 1, stack: ["pg1"], visited: ["pg1"] }, savedAt: "2026-10-30T10:00:00.000Z" };
  const fb = chooseNavTrail(v2, onlyDeleted, { visited: ["ph1"], seen: ["ph1", "ph2"], at: 1 });
  assert.equal(fb.source, "browser");
  assert.deepEqual(fb.trail, { v: 1, stack: ["ph1"], visited: ["ph1", "ph2"] });
});
