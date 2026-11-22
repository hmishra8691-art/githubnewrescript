import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSurvey, redTeamCorpus, type ResponseRecord } from "./index.js";

/* a text answer's last 20 changes, as the collector keeps them: [ms since start, { len }] */
const history = (gaps: number[], from = 100): [number, unknown][] => { let t = 40_000, len = from; const h: [number, unknown][] = [[t, { len }]]; for (const g of gaps) { t += g; len += 1; h.push([t, { len }]); } return h; };
const corpus = redTeamCorpus({ perAttack: 1, genuine: 60 });
const person = corpus.responses.find((l) => l.label === "genuine" && !!l.response.telemetry?.questions.oe && (l.response.telemetry.device?.type ?? "desktop") === "desktop")!.response;
const withHistory = (id: string, h: [number, unknown][]): ResponseRecord => {
  const r = JSON.parse(JSON.stringify(person)) as ResponseRecord;
  r.sessionId = id; r.ipHash = `ip-${id}`; r.deviceHash = `dev-${id}`;
  r.telemetry!.questions.oe = { ...r.telemetry!.questions.oe!, history: h, historyDropped: 80 };
  r.answers.oe = `A different sentence for ${id}, so that no open end repeats another one here.`;
  return r;
};
const flagsOf = (rec: ResponseRecord) => assessSurvey(corpus.def, [...corpus.responses.filter((l) => l.label === "genuine").map((l) => l.response), rec]).bySession.get(rec.sessionId)!.flags.map((f) => f.ruleId).filter((x) => x.startsWith("bot."));

test("typing at a fixed delay, never corrected, is flagged; a person's uneven typing is not", () => {
  /* a script: 180 ms a key, give or take a few ms */
  assert.deepEqual(flagsOf(withHistory("even", history([181, 179, 183, 180, 178, 182, 180, 181, 179, 184, 180, 177, 182, 181, 180, 179, 183, 180, 181]))), ["bot.even_typing"]);
  /* a person: the same average, gaps from 90 to 420 ms */
  assert.deepEqual(flagsOf(withHistory("person", history([120, 240, 95, 310, 150, 180, 420, 110, 205, 160, 90, 260, 175, 140, 330, 100, 190, 230, 125]))), []);
  /* even gaps but a correction in the window: someone went back and fixed a letter */
  const fixed = history([180, 181, 179, 182, 180, 181, 179, 180, 182, 181, 180, 179, 181, 180, 182, 180, 181, 179]);
  fixed.splice(9, 0, [fixed[8]![0] + 90, { len: (fixed[8]![1] as { len: number }).len - 1 }]);
  assert.deepEqual(flagsOf(withHistory("fixed", fixed)), []);
});

test("typing faster than a person can sustain is flagged as that, not as even typing", () => {
  assert.deepEqual(flagsOf(withHistory("fast", history(Array.from({ length: 19 }, (_, i) => 45 + (i % 3))))), ["bot.superhuman_typing"]);
  /* a fast typist: 95 ms a key on average (about 10 characters a second), uneven */
  assert.deepEqual(flagsOf(withHistory("typist", history([70, 120, 85, 140, 60, 110, 95, 130, 75, 100, 65, 150, 90, 80, 125, 70, 105, 85, 115]))), []);
});

test("too few keystrokes, or no history at all, is not judged", () => {
  assert.deepEqual(flagsOf(withHistory("short", history([180, 180, 180, 180, 180, 180, 180, 180]))), []);
  const none = withHistory("none", []);
  delete none.telemetry!.questions.oe!.history;
  assert.deepEqual(flagsOf(none), []);
  /* a pasted answer arrives as one change of many characters: not a run of keystrokes */
  assert.deepEqual(flagsOf(withHistory("pasted", [[40_000, { len: 0 }], [40_500, { len: 140 }]])), []);
});
