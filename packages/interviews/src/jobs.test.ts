import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure, decideAfterFailure, emptyReport, isJobKind, jobKey,
  noteDecision, shouldClaimAnother,
} from "./jobs.js";

/*
 * Two failures this file exists to make hard.
 *
 *   Retrying for ever — an unreadable recording sent to a paid provider again
 *   and again until somebody reads the bill.
 *
 *   Giving up on a blip — a 503 turned into a transcript a human has to rescue
 *   by hand.
 *
 * Every assertion below is one or the other. The classification tests are the
 * important ones: they are what decides which failure you get.
 */

/* ------------------------------------------------- classification */

test("a 4xx is the provider saying the request is wrong — retrying cannot fix it", () => {
  assert.equal(classifyFailure("bad request", 400).kind, "permanent");
  assert.equal(classifyFailure("nope", 401).kind, "permanent");
  assert.equal(classifyFailure("nope", 403).kind, "permanent");
  assert.equal(classifyFailure("gone", 404).kind, "permanent");
  assert.equal(classifyFailure("unsupported", 415).kind, "permanent");
});

test("BUT the 4xx codes that are about timing are transient", () => {
  /*
   * 429 is the one that matters. Treating a rate limit as permanent abandons
   * work the provider was perfectly willing to do a minute later.
   */
  for (const s of [408, 409, 425, 429]) {
    assert.equal(classifyFailure("slow down", s).kind, "transient", `status ${s}`);
  }
});

test("a 5xx is the provider having a bad moment, not a bad file", () => {
  for (const s of [500, 502, 503, 504]) {
    assert.equal(classifyFailure("server error", s).kind, "transient", `status ${s}`);
  }
});

test("a missing object is permanent, whatever words the store used", () => {
  for (const r of [
    "NoSuchKey: the specified key does not exist",
    "object not found",
    "this recording was deleted",
    "no such file",
  ]) {
    assert.equal(classifyFailure(r).kind, "permanent", r);
  }
});

test("a file the provider has looked at and refused is permanent", () => {
  for (const r of [
    "unsupported format: audio/x-weird",
    "invalid audio file",
    "file is empty",
    "the file is corrupt",
    "the file is too large",
    "audio exceeds the maximum duration",
  ]) {
    assert.equal(classifyFailure(r).kind, "permanent", r);
  }
});

test("EVERYTHING UNRECOGNISED IS TRANSIENT", () => {
  /*
   * The default has to fall this way. Retrying a doomed job three times costs
   * three requests; abandoning a recoverable one costs a researcher an
   * afternoon and a support ticket.
   */
  for (const r of [
    "socket hang up",
    "ETIMEDOUT",
    "connection reset by peer",
    "fetch failed",
    "something went wrong",
    "",
  ]) {
    assert.equal(classifyFailure(r).kind, "transient", JSON.stringify(r));
  }
});

test("a failure with no words at all still says something", () => {
  assert.match(classifyFailure("").reason, /without saying why/);
});

/* --------------------------------------------------- the decision */

test("a transient failure with attempts left retries, after a wait", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const d = decideAfterFailure(
    { attempts: 1, maxAttempts: 3 }, { kind: "transient", reason: "503" }, now, () => 0.5);
  assert.equal(d.status, "failed");
  assert.equal(d.status === "failed" && d.retrying, true);
  assert.equal(d.status === "failed" && d.retrying && d.attemptsLeft, 2);
  assert.ok(d.status === "failed" && d.retrying && d.runAfter.getTime() > now.getTime(),
    "the retry is scheduled into the future, not immediately");
});

test("the wait GROWS, so a struggling provider is not hammered", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const wait = (attempts: number) => {
    const d = decideAfterFailure(
      { attempts, maxAttempts: 9 }, { kind: "transient", reason: "503" }, now, () => 0.5);
    return d.status === "failed" && d.retrying ? d.runAfter.getTime() - now.getTime() : 0;
  };
  assert.ok(wait(2) > wait(1), "the second wait is longer than the first");
  assert.ok(wait(3) > wait(2), "and the third longer than the second");
});

test("the last attempt does not schedule a retry it will never get", () => {
  const d = decideAfterFailure(
    { attempts: 3, maxAttempts: 3 }, { kind: "transient", reason: "503" });
  assert.equal(d.status === "failed" && d.retrying, false);
  assert.equal(d.status === "failed" && !d.retrying && d.permanent, false,
    "out of attempts is not the same as never going to work");
});

test("A PERMANENT FAILURE STOPS AT ONCE, WITH ATTEMPTS TO SPARE", () => {
  /*
   * The assertion that stops three charges for the same "no". A provider that
   * has already refused this file will refuse it twice more.
   */
  const d = decideAfterFailure(
    { attempts: 1, maxAttempts: 5 }, { kind: "permanent", reason: "unsupported format" });
  assert.equal(d.status === "failed" && d.retrying, false);
  assert.equal(d.status === "failed" && !d.retrying && d.permanent, true);
});

/* ------------------------------------------------- idempotency */

test("the key is about the work, not about when it was asked for", () => {
  assert.equal(jobKey("transcription", "m1"), jobKey("transcription", "m1"),
    "enqueueing the same work twice must collide");
  assert.notEqual(jobKey("transcription", "m1"), jobKey("transcription", "m2"));
  assert.notEqual(jobKey("transcription", "m1"), jobKey("analysis", "m1"));
});

test("a human asking for a redo can get past the constraint", () => {
  assert.notEqual(jobKey("transcription", "m1"), jobKey("transcription", "m1", 1));
  assert.notEqual(jobKey("transcription", "m1", 1), jobKey("transcription", "m1", 2));
});

test("job kinds are checked, not trusted", () => {
  assert.equal(isJobKind("transcription"), true);
  assert.equal(isJobKind("retention"), true);
  assert.equal(isJobKind("transcribe"), false);
  assert.equal(isJobKind(null), false);
});

/* ------------------------------------------------- the drain pass */

test("the runner stops while it still has room for a WHOLE job", () => {
  /*
   * Starting a job it cannot finish leaves a `running` row for the stale-claim
   * timeout to reclaim — a wasted attempt and minutes of delay.
   */
  const budget = { msAvailable: 60_000, maxJobs: 20 };
  assert.equal(shouldClaimAnother(budget, 0, 0, 20_000), true);
  assert.equal(shouldClaimAnother(budget, 0, 45_000, 20_000), false,
    "15s left and jobs take 20s — do not start one");
});

test("and stops at the job cap however much time is left", () => {
  const budget = { msAvailable: 300_000, maxJobs: 5 };
  assert.equal(shouldClaimAnother(budget, 5, 0, 1_000), false);
  assert.equal(shouldClaimAnother(budget, 4, 0, 1_000), true);
});

test("the report distinguishes retrying from giving up, and says why", () => {
  const r = emptyReport();
  noteDecision(r, { status: "complete" });
  noteDecision(r, {
    status: "failed", retrying: true, attemptsLeft: 2,
    reason: "503", runAfter: new Date(),
  });
  noteDecision(r, { status: "failed", retrying: false, reason: "unsupported format", permanent: true });
  noteDecision(r, { status: "failed", retrying: false, reason: "503", permanent: false });

  assert.equal(r.completed, 1);
  assert.equal(r.retrying, 1);
  assert.equal(r.abandoned, 2);
  assert.match(r.warnings[0], /will not retry/);
  assert.match(r.warnings[1], /out of attempts/);
});
