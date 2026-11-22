import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTACKS, redTeamCorpus } from "./redTeam.js";
import { evaluateQuality } from "./validation.js";

test("the red-team corpus is the same on every run, labelled by construction, and covers every attack", () => {
  const a = redTeamCorpus(), b = redTeamCorpus();
  assert.deepEqual(a.responses.map((r) => [r.response.sessionId, r.persona, JSON.stringify(r.response.answers)]), b.responses.map((r) => [r.response.sessionId, r.persona, JSON.stringify(r.response.answers)]));
  const byAttack = new Map<string, number>();
  for (const r of a.responses) if (r.label === "fraudulent") byAttack.set(r.persona, (byAttack.get(r.persona) ?? 0) + 1);
  assert.deepEqual([...byAttack.keys()].sort(), ATTACKS.map((x) => x.id).sort());
  for (const [id, n] of byAttack) assert.equal(n, 30, id);
  assert.equal(a.responses.filter((r) => r.label === "genuine").length, 240);
  assert.equal(new Set(a.responses.map((r) => r.response.sessionId)).size, a.responses.length, "session ids repeat");
  /* a language-model agent's open ends are all different: it is not caught by being a copy */
  const llm = a.responses.filter((r) => r.persona === "llm_agent_typed").map((r) => String(r.response.answers.oe));
  assert.ok(new Set(llm).size >= 20, `only ${new Set(llm).size} distinct open ends in 30`);
});

test("the engine is measured on it: the crude bot is caught, and the report names every attack it misses", () => {
  const { def, responses } = redTeamCorpus();
  const r = evaluateQuality(def, responses);
  const bot = r.byPersona.classic_bot!;
  assert.equal(bot.PASS, 0, "a classic bot passed");
  for (const a of ATTACKS) assert.ok(r.byPersona[a.id], `${a.id} is not in the report`);
  /* the corpus is hard on purpose: if every attack were caught, it would not be telling us anything */
  assert.ok(r.misses.length > 0, "nothing was missed — the corpus is too easy to be a red team");
  /* genuine people are the same as in the validation corpus, and must not suffer for the attackers' presence */
  assert.ok(r.flagged.genuineFalsePositive.rate <= 0.02, `genuine people flagged: ${r.flagged.genuineFalsePositive.rate}`);
});
