import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_RETRY_MS, classifyFailure, decideAfterFailure, emptyReport, isTerminalFailure, noteDecision,
} from "./jobs.js";
import { analysisTimeoutMs } from "./prompt.js";
import { SESSION_MAX_SECONDS, expectedBytes, secondsThatFit } from "./limits.js";

/* ------------------------------------------------ the wallet is not a broken file */

test("A 402 IS MONEY, NOT A BAD FILE: blocked, never permanent", () => {
  const f = classifyFailure("Insufficient balance: this operation needs 12 credits", 402);
  assert.equal(f.kind, "blocked");
  /* the words alone are enough when nobody set the status */
  assert.equal(classifyFailure("insufficient balance", null).kind, "blocked");
  assert.equal(classifyFailure("no wallet for this organisation").kind, "blocked");
  assert.equal(classifyFailure("the wallet is suspended").kind, "blocked");
  /* and the other 4xx rules are untouched */
  assert.equal(classifyFailure("bad request", 400).kind, "permanent");
  assert.equal(classifyFailure("slow down", 429).kind, "transient");
});

test("a blocked job is handed back an hour out, and no attempt is counted against it", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const d = decideAfterFailure({ attempts: 3, maxAttempts: 3 }, { kind: "blocked", reason: "insufficient balance" }, now);
  assert.equal(d.status, "blocked");
  if (d.status !== "blocked") throw new Error("unreachable");
  assert.equal(d.runAfter.getTime() - now.getTime(), BLOCKED_RETRY_MS);
  /* out of attempts is irrelevant to a blocked job: it did not fail */
  assert.equal(isTerminalFailure(d), false);
});

test("the report counts blocked jobs apart from failures, and says what they wait on", () => {
  const r = emptyReport();
  noteDecision(r, { status: "blocked", reason: "insufficient balance", runAfter: new Date() });
  noteDecision(r, { status: "failed", retrying: false, reason: "too large", permanent: true });
  assert.equal(r.blocked, 1);
  assert.equal(r.abandoned, 1);
  assert.equal(r.completed, 0);
  assert.match(r.warnings[0]!, /waiting on the wallet/);
});

test("terminal is 'will not run again': permanent or out of attempts, never a retry or a hand-back", () => {
  assert.equal(isTerminalFailure({ status: "failed", retrying: false, reason: "x", permanent: true }), true);
  assert.equal(isTerminalFailure({ status: "failed", retrying: false, reason: "x", permanent: false }), true);
  assert.equal(isTerminalFailure({ status: "failed", retrying: true, reason: "x", runAfter: new Date(), attemptsLeft: 1 }), false);
  assert.equal(isTerminalFailure({ status: "complete" }), false);
});

/* ------------------------------------------------------- patience */

test("THE ANALYSIS WAITS AS LONG AS ITS PROMPT DESERVES — never eight seconds", () => {
  /* the survey product's default would have been 8 s */
  assert.ok(analysisTimeoutMs(200, 160) >= 45_000, "a tiny prompt still gets 45 s");
  const big = analysisTimeoutMs(24_000, 2_000);
  assert.ok(big > 150_000 && big <= 240_000, `a 24k prompt gets minutes, got ${big}`);
  /* a caller with less time left caps it, and the cap wins over the floor */
  assert.equal(analysisTimeoutMs(24_000, 2_000, 30_000), 30_000);
  assert.equal(analysisTimeoutMs(0, 0, 240_000), 45_000);
});

/* ---------------------------------------------- a session that can be transcribed */

test("a session stops where its audio companion would stop fitting the speech provider", () => {
  const STT_MAX_BYTES = 25 * 1024 * 1024;
  assert.ok(expectedBytes(SESSION_MAX_SECONDS, "audio") < STT_MAX_BYTES, "the companion of a full-length session fits");
  assert.ok(SESSION_MAX_SECONDS < secondsThatFit(STT_MAX_BYTES, "audio"), "with margin to spare");
  /* and the video of the same session does NOT — which is why the companion exists */
  assert.ok(expectedBytes(SESSION_MAX_SECONDS, "video") > STT_MAX_BYTES);
});
