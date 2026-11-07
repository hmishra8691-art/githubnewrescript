import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, agentGraph, agentOf, agentStatuses, isLive } from "./workspace.ts";

const step = (stepId: string, kind: string | undefined, status: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ stepId, kind, status, dependsOn, planVersion: 1, retryCount: 0, title: stepId, ...extra }) as never;

test("every step kind a registered handler runs belongs to exactly one agent — no orphan work, no double counting", () => {
  const dir = join(import.meta.dirname, "..", "tasks", "handlers");
  const kinds = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.includes(".test.") && !/Fake/i.test(x))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/kind: "((?:gen|translation|assessment|copilot|analysis|report|decision)\.[a-z_]+)"/g)) kinds.add(m[1]);
  }
  assert.ok(kinds.size >= 15, `found ${kinds.size} kinds`);
  for (const k of kinds) {
    const owners = AGENTS.filter((a) => a.kinds.includes(k));
    assert.equal(owners.length, 1, `${k} is owned by ${owners.map((o) => o.id).join(", ") || "nobody"}`);
    assert.notEqual(agentOf({ kind: k }), null);
  }
  /* a plan item (the survey_build path) has no kind and is the writer's */
  assert.equal(agentOf({}), "writer");
  /* planned agents own nothing, so nothing can ever be drawn as theirs */
  for (const a of AGENTS.filter((x) => x.availability === "planned")) assert.deepEqual(a.kinds, []);
});

test("the graph is the step rows: columns follow dependencies, edges are dependsOn, only work in flight is live", () => {
  const g = agentGraph({ planVersion: 1, steps: [
    step("design", "gen.design", "completed"), step("skeleton", "gen.skeleton", "completed"),
    step("b1", "gen.batch", "running", ["skeleton"]), step("b2", "gen.batch", "pending", ["skeleton"]),
    step("logic", "gen.logic", "pending", ["b1", "b2"]), step("validate", "gen.validate", "pending", ["logic", "design", "ghost"]),
    step("old", "gen.batch", "tombstoned"),
  ] });
  assert.deepEqual(g.nodes.map((n) => [n.stepId, n.column]), [["design", 0], ["skeleton", 0], ["b1", 1], ["b2", 1], ["logic", 2], ["validate", 3]]);
  assert.equal(g.columns, 4);
  assert.ok(!g.nodes.some((n) => n.stepId === "old"), "a tombstoned step is not drawn");
  assert.equal(g.edges.length, 6, "a dependency on a step that does not exist is not drawn");
  assert.deepEqual(g.edges.filter((e) => e.live), [{ from: "skeleton", to: "b1", live: true }], "only the edge into the running step, from a finished one");
  assert.deepEqual(g.agents, ["design", "writer", "logic", "validation"]);
});

test("a dependency loop is cut, not looped forever", () => {
  const g = agentGraph({ planVersion: 1, steps: [step("a", "gen.batch", "pending", ["b"]), step("b", "gen.batch", "pending", ["a"])] });
  assert.equal(g.nodes.length, 2);
});

test("agent states come from the rows: working only while a step runs in an open task; a planned agent never works", () => {
  const open = { status: "running", steps: [step("b1", "gen.batch", "running"), step("v", "gen.validate", "pending", ["b1"]), step("t", "translation.batch", "failed", [], { finishedAt: 5 })] } as never;
  const done = { status: "completed", steps: [step("l", "gen.logic", "completed", [], { finishedAt: 9 }), step("x", "gen.repair", "failed")] } as never;
  const s = Object.fromEntries(agentStatuses([open, done]).map((a) => [a.id, a]));
  assert.equal(s.writer.state, "working");
  assert.equal(s.writer.now, "b1");
  assert.equal(s.validation.state, "waiting");
  assert.equal(s.translation.state, "attention");
  assert.equal(s.logic.state, "done", "finished work in a closed task");
  assert.equal(s.logic.lastActive, 9);
  assert.equal(s.assessment.state, "idle");
  assert.equal(s.writing.state, "idle", "the report agent exists now and has not run here");
  assert.equal(s.decision.state, "idle");
  assert.equal(s.writer.steps.failed, 1, "a failure in a closed task is counted but does not raise attention");
  assert.equal(isLive({ status: "running" }), true);
  assert.equal(isLive({ status: "needs_attention" }), false);
  assert.equal(isLive(null), false);
});

test("the journey reads the overview's module states; unreadable stages are unknown, not 'not started'", async () => {
  const { workflowStages } = await import("./workflow.ts");
  const m = (key: string, state: string) => ({ key, label: key, state, detail: "", tab: key }) as never;
  const v = workflowStages([m("research", "configured"), m("programming", "configured"), m("quotas", "not_configured"), m("languages", "configured"),
    m("fieldwork", "not_configured"), m("collection", "not_configured"), m("quality", "not_configured"), m("analysis", "needs_attention"), m("reporting", "configured")]);
  assert.deepEqual(v.map((s) => s.state), ["in_progress", "not_started", "attention", "done"]);
  const u = workflowStages([m("research", "configured"), m("programming", "configured"), m("quotas", "configured"), m("languages", "configured")], { unknown: ["collect", "analyze", "act"] });
  assert.deepEqual(u.map((s) => s.state), ["done", "unknown", "unknown", "unknown"]);
});

test("every launcher names a planner that is registered, and says plainly what the agent is asked", async () => {
  const { LAUNCHERS, launchMessage } = await import("./launch.ts");
  const dir = join(import.meta.dirname, "..", "tasks", "handlers");
  const src = readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.includes(".test.")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  for (const l of LAUNCHERS) {
    assert.ok(src.includes(`id: "${l.planner}"`), `${l.id}: planner ${l.planner} is registered`);
    assert.ok(AGENTS.some((a) => a.id === l.agent && a.availability !== "planned"), `${l.id}: its agent ${l.agent} exists`);
  }
  const tr = LAUNCHERS.find((l) => l.id === "translate")!;
  assert.equal(launchMessage(tr, { language: "French" }), "Translate the whole survey into French");
  assert.equal(launchMessage(tr, { scope: "Q1–Q5" }), "", "a required field missing sends nothing");
  assert.equal(launchMessage(LAUNCHERS.find((l) => l.id === "build")!, { brief: "Bank app CSAT", count: "40" }), "Write a 40 question survey: Bank app CSAT");
});

test("an agent whose queued work sits in a paused task needs attention, not 'queued'", () => {
  const paused = { status: "needs_attention", steps: [step("c", "analysis.check", "pending")] } as never;
  assert.equal(agentStatuses([paused]).find((a) => a.id === "analysis")!.state, "attention");
});
