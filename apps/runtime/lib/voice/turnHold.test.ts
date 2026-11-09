import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnHold, type Verdict } from "./turnHold.ts";

/** a virtual clock: timers fire only when the test advances time */
function clock() {
  let t = 0; let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k; },
    clearTimer: (k: unknown) => { timers.delete(k as number); },
    advance(ms: number) { const end = t + ms; for (;;) { const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; t = next[1].at; timers.delete(next[0]); next[1].fn(); } t = end; },
  };
}

const setup = (o: { consult?: (s: string) => Promise<Verdict>; question?: string } = {}) => {
  const c = clock();
  const sent: { text: string; pieces: number; reason: string }[] = [];
  const h = new TurnHold({ question: () => o.question ?? "Why did you choose this bank?", commit: (text, i) => sent.push({ text, pieces: i.pieces, reason: i.reason }), ...(o.consult ? { consult: o.consult } : {}), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  return { c, h, sent };
};

test("a thinking pause is not the end of the answer: pieces are joined and sent once, after the participant has finished", () => {
  const { c, h, sent } = setup();
  h.piece("Hmm, let me think", 1200, c.now());
  c.advance(2500);
  assert.equal(sent.length, 0, "the AI does not cut in 2.5 s into a thinking pause");
  h.speechStart();
  c.advance(4000);
  h.piece("Mainly the fees, and the app crashed a lot when I tried to pay bills on Fridays.", 4000, c.now());
  c.advance(1000);
  assert.equal(sent.length, 0, "a short pause after a complete sentence is still a thinking window");
  c.advance(2000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pieces, 2);
  assert.match(sent[0].text, /^Hmm, let me think Mainly the fees/);
});

test("speech starting again cancels a pending send; an unfinished sentence waits longer", () => {
  const { c, h, sent } = setup();
  h.piece("I switched because", 1000, c.now());
  c.advance(4000);
  assert.equal(sent.length, 0);
  h.speechStart();
  c.advance(20_000);
  assert.equal(sent.length, 0, "while they speak, nothing is sent however long it takes");
  h.piece("the branch near me closed.", 1500, c.now());
  c.advance(3000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "I switched because the branch near me closed.");
});

test("'that's all' sends at once; 'I'm done' sends what was said; the cap stops any wait", () => {
  const a = setup();
  a.h.piece("The price, that's all", 900, a.c.now());
  assert.equal(a.sent.length, 1);
  const b = setup();
  b.h.piece("It was okay I guess", 900, b.c.now());
  b.h.commitNow();
  assert.equal(b.sent.length, 1);
  const c = setup();
  c.h.piece("um", 400, c.c.now());
  c.c.advance(15_001);
  assert.equal(c.sent.length, 1, "never left hanging past the cap");
});

test("the model can extend the wait (still talking) or shorten it (finished); a stale answer is ignored", async () => {
  let resolve!: (v: Verdict) => void;
  const x = setup({ consult: () => new Promise<Verdict>((r) => { resolve = r; }), question: "What matters most to you?" });
  x.h.piece("The price", 800, x.c.now());
  resolve("continuing"); await Promise.resolve(); await Promise.resolve();
  x.c.advance(4000);
  assert.equal(x.sent.length, 0, "the model said they are still forming the answer");
  x.c.advance(4000);
  assert.equal(x.sent.length, 1);

  const y = setup({ consult: () => new Promise<Verdict>((r) => { resolve = r; }), question: "What matters most to you?" });
  y.h.piece("The price", 800, y.c.now());
  resolve("complete"); await Promise.resolve(); await Promise.resolve();
  y.c.advance(1200);
  assert.equal(y.sent.length, 1, "finished: sent after a short grace");

  const z = setup({ consult: () => new Promise<Verdict>((r) => { resolve = r; }), question: "What matters most to you?" });
  z.h.piece("The price", 800, z.c.now());
  z.h.speechStart();
  resolve("complete"); await Promise.resolve(); await Promise.resolve();
  z.c.advance(5000);
  assert.equal(z.sent.length, 0, "they spoke again: the old verdict does not send the half answer");
});
