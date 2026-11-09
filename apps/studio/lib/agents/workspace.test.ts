import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, agentOf } from "./workspace.ts";

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
