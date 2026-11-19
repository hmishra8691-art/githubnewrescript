import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { toolByName, dryRunTool } from "@rescript/engine";
import { fieldPace } from "./fieldwork.js";
import { proposeFieldworkActions, decideProposal, openProposals, type FieldworkSnapshot } from "./fieldworkAgent.js";

/*
 * THE FIELDWORK AGENT IN SIMULATION (audit P3-03 gate). A 10-day field of 500 completes, simulated day by day
 * under five scenarios. Each scenario has the proposals a fieldwork manager would want and none they would not.
 */
const FROM = "2026-11-01", TO = "2026-11-10", TARGET = 500;
type Day = { completes: number; last: number /* completes in the last 24 h */; cells: [number, number]; flagged: number; recentFlagged: number; srcA: [number, number]; srcB: [number, number]; quietHours?: number };

function snapshot(day: number, d: Day): FieldworkSnapshot {
  const now = new Date(Date.parse(`${FROM}T00:00:00Z`) + day * 86_400_000).toISOString();
  const pace = fieldPace({ completes: d.completes, target: TARGET, fieldFrom: FROM, fieldTo: TO, recentCompletes: d.last, recentHours: 24, lastCompleteAt: new Date(Date.parse(now) - (d.quietHours ?? 1) * 3_600_000).toISOString(), now, stallHours: 24 });
  return {
    surveyId: "s1", now, pace, fieldTo: TO,
    cells: [{ quota: "Gender", cell: "f", label: "Women", target: 250, count: d.cells[0] }, { quota: "Gender", cell: "m", label: "Men", target: 250, count: d.cells[1] }],
    quality: { assessed: d.completes, flagged: d.flagged, recentAssessed: d.last, recentFlagged: d.recentFlagged, recentHours: 24 },
    sources: [{ name: "PanelA", completes: d.srcA[0], flagged: d.srcA[1] }, { name: "PanelB", completes: d.srcB[0], flagged: d.srcB[1] }],
  };
}
const healthy = (day: number): Day => { const c = 50 * day; return { completes: c, last: 50, cells: [c / 2, c / 2], flagged: Math.round(c * 0.05), recentFlagged: 2, srcA: [c / 2, Math.round(c * 0.025)], srcB: [c / 2, Math.round(c * 0.025)] }; };
const kinds = (s: FieldworkSnapshot) => proposeFieldworkActions(s).map((p) => p.kind);

test("healthy field: no proposals on any day, then 'done' when the target is met", () => {
  for (let day = 2; day <= 9; day++) assert.deepEqual(kinds(snapshot(day, healthy(day))), [], `day ${day}`);
  assert.deepEqual(kinds(snapshot(10, healthy(10))), ["done"]);
});

test("a stall after day 3 is raised as high severity; a slow field gets 'extend the window' with the registry tool and a date", () => {
  const stall = snapshot(4, { ...healthy(3), last: 0, quietHours: 30 });
  const ps = proposeFieldworkActions(stall);
  assert.equal(ps[0].kind, "stalled"); assert.equal(ps[0].severity, "high");
  const slow = snapshot(5, { ...healthy(5), completes: 150, last: 25, cells: [75, 75], srcA: [75, 4], srcB: [75, 4], flagged: 8 });
  const behind = proposeFieldworkActions(slow).find((p) => p.kind === "behind")!;
  assert.ok(behind, JSON.stringify(proposeFieldworkActions(slow)));
  assert.equal(behind.tool?.name, "survey.set_deployment");
  assert.match(String(behind.tool?.input.activeUntil), /^2026-11-\d\d|^2026-12-\d\d/);
  assert.match(behind.saw, /150 of 500/);
});

test("a lagging quota cell, a quality spike and a bad supplier are each raised once, naming what they saw", () => {
  const d = healthy(6);
  const s = snapshot(6, { ...d, cells: [210, 90], srcA: [150, 45], srcB: [150, 4], flagged: 49, recentFlagged: 20 });
  const ps = proposeFieldworkActions(s);
  const quota = ps.filter((p) => p.kind === "quota");
  assert.equal(quota.length, 1); assert.match(quota[0].saw, /Men/); assert.equal(quota[0].tool?.name, "recruitment.plan");
  const quality = ps.find((p) => p.kind === "quality")!; assert.match(quality.saw, /40% of the last 24 hours/);
  const source = ps.find((p) => p.kind === "source")!; assert.match(source.saw, /^PanelA: 30%/); assert.equal(source.tool?.name, "recruitment.order");
  assert.ok(!ps.some((p) => p.kind === "source" && /PanelB/.test(p.saw)), "the clean supplier is not blamed");
});

test("every tool a proposal names is in the registry; the questionnaire one dry-runs; decisions need reasons and are not re-raised", () => {
  const slow = snapshot(5, { ...healthy(5), completes: 150, last: 25, cells: [75, 75], srcA: [75, 4], srcB: [75, 4], flagged: 8 });
  const s2 = snapshot(6, { ...healthy(6), cells: [210, 90], srcA: [150, 45], srcB: [150, 4], flagged: 49, recentFlagged: 20 });
  const all = [...proposeFieldworkActions(slow), ...proposeFieldworkActions(s2)];
  for (const p of all) if (p.tool) assert.ok(toolByName(p.tool.name), `${p.tool.name} is a registry tool`);
  const def = SurveyDefinition.parse({ meta: { id: "s1", code: "S1", title: "x", version: "1", schemaVersion: 1, status: "draft" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const behind = all.find((p) => p.kind === "behind")!;
  const dry = dryRunTool(def, behind.tool!.name, behind.tool!.input);
  assert.equal(dry.ok, true, JSON.stringify(dry)); assert.equal(dry.approval, "confirm");

  assert.deepEqual(decideProposal(behind, "reject", "  ", "u1"), { error: "Say why you reject it — the reason is what makes the next proposal better." });
  const d = decideProposal(behind, "reject", "The client will accept 480", "u1", "2026-11-05T10:00:00Z");
  assert.ok(!("error" in d) && d.decision === "reject" && d.tool === "survey.set_deployment");
  /* the same situation tomorrow morning: the same proposal id, so it stays decided */
  const again = proposeFieldworkActions(slow);
  assert.deepEqual(openProposals(again, [d as { proposalId: string }]).map((p) => p.kind).filter((k) => k === "behind"), []);
  /* deterministic */
  assert.deepEqual(proposeFieldworkActions(s2).map((p) => p.id), proposeFieldworkActions(s2).map((p) => p.id));
});
