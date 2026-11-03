import test from "node:test";
import assert from "node:assert/strict";
import { AudienceSpecification } from "@rescript/schema";
import { createProlificAdapter, PROLIFIC_WEBHOOK } from "./prolific.js";
import { resetBreakers } from "../http.js";
import { AdapterError, type AdapterContext } from "../adapter.js";

const ctx: AdapterContext = {
  integrationId: "int-1", vendorName: "Prolific", mode: "api", customerId: "c1",
  currency: "GBP", markupBps: 0, credentials: { token: "tok_secret_do_not_log" },
};

const audience = (over: Record<string, unknown> = {}) => AudienceSpecification.parse(over);

/** A scripted fetch that records the requests it was given. */
function scripted(responses: Array<{ status: number; body?: unknown } | "throw">) {
  const sent: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    sent.push({
      url, method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r === "throw") throw Object.assign(new Error("socket hang up"), { name: "FetchError" });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const adapter = (responses: Parameters<typeof scripted>[0]) => {
  const { impl, sent } = scripted(responses);
  return { a: createProlificAdapter({ fetchImpl: impl, random: () => 0 }), sent };
};

test.beforeEach(() => resetBreakers());

test("a zero count means 'fewer than five', never 'none' — a privacy floor is not a measurement", async () => {
  const { a } = adapter([{ status: 200, body: { count: 0 } }]);
  const est = await a.feasibility!(ctx, { audience: audience(), requiredCompletes: 500, loiMinutes: 10 });
  assert.equal(est.available, null, "zero must not be written into `available`");
  assert.match(est.unavailableReason!, /Fewer than five/);
});

test("a real count is reported as a POOL, not as a forecast of completes", async () => {
  const { a } = adapter([{ status: 200, body: { count: 12400 } }]);
  const est = await a.feasibility!(ctx, { audience: audience(), requiredCompletes: 500, loiMinutes: 10 });
  assert.equal(est.available, 12400);
  assert.match(est.unavailableReason!, /not a forecast of how many will complete/);
});

test("age is mapped for real; everything else is NAMED rather than guessed", async () => {
  const { a, sent } = adapter([{ status: 200, body: { count: 900 } }]);
  const est = await a.feasibility!(ctx, {
    audience: audience({
      demographics: { ageMin: 25, ageMax: 54, countries: ["GB"], incomeBands: ["50k-75k"] },
      advanced: { jobTitles: ["CTO"] },
    }),
    requiredCompletes: 300, loiMinutes: 12,
  });
  assert.deepEqual(sent[0].body, { filters: [{ filter_id: "age", selected_range: { lower: 25, upper: 54 } }] });
  assert.deepEqual(est.unmapped.sort(), ["country", "income", "job title"]);
});

test("screeners are NOT reported as unmapped — they are asked in the survey, not dropped", async () => {
  const { a } = adapter([{ status: 200, body: { count: 900 } }]);
  const est = await a.feasibility!(ctx, {
    audience: audience({ screeners: [{ id: "s1", text: "Do you own a car?", qualifyingAnswers: ["Yes"] }] }),
    requiredCompletes: 100, loiMinutes: 8,
  });
  assert.deepEqual(est.unmapped, [], "telling a researcher their screening was dropped would be false");
});

test("the source can never be `live` — Prolific does not quote a CPI", async () => {
  const { a } = adapter([{ status: 200, body: { count: 10 } }]);
  assert.equal(a.maxSource, "vendor_reported");
  const est = await a.feasibility!(ctx, { audience: audience(), requiredCompletes: 10, loiMinutes: 5 });
  assert.notEqual(est.source, "live");
  assert.ok(!a.capabilities.includes("quote"), "a capability it has not got must not be declared");
});

test("ordering without an audience is REFUSED, not quietly sent untargeted", async () => {
  const { a, sent } = adapter([{ status: 201, body: { id: "stu_1" } }]);
  await assert.rejects(
    () => a.createOrder!(ctx, {
      recruitmentProjectId: "p1", orderId: "o1", completes: 100, cpi: 2.5, currency: "GBP",
      entryUrl: "https://s.example.test/r", returnUrls: {},
    }),
    (e: unknown) => e instanceof AdapterError && /recruit the general population and bill for it/.test((e as Error).message),
  );
  assert.equal(sent.length, 0, "nothing reached Prolific");
});

test("the reward is converted to MINOR units — a 100x error if it is not", async () => {
  const { a, sent } = adapter([{ status: 201, body: { id: "stu_1" } }, { status: 200, body: { status: "ACTIVE" } }]);
  await a.createOrder!(ctx, {
    recruitmentProjectId: "p1", orderId: "o1", completes: 100, cpi: 2.5, currency: "GBP",
    entryUrl: "https://s.example.test/r", returnUrls: {}, audience: audience(),
  });
  assert.equal((sent[0].body as { reward: number }).reward, 250, "£2.50 is 250 pence");
  assert.equal((sent[0].body as { total_available_places: number }).total_available_places, 100);
});

test("the draft is created, then published — two calls, in that order", async () => {
  const { a, sent } = adapter([{ status: 201, body: { id: "stu_9" } }, { status: 200, body: { status: "ACTIVE" } }]);
  const ack = await a.createOrder!(ctx, {
    recruitmentProjectId: "p1", orderId: "o1", completes: 50, cpi: 1, currency: "GBP",
    entryUrl: "https://s.example.test/r", returnUrls: {}, audience: audience(),
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].url, /\/studies\/$/);
  assert.match(sent[1].url, /\/studies\/stu_9\/transition\/$/);
  assert.deepEqual(sent[1].body, { action: "PUBLISH" });
  assert.equal(ack.vendorOrderRef, "stu_9");
  assert.equal(ack.status, "live");
});

test("a draft that times out is NOT retried — a second study would pay strangers twice", async () => {
  const { a, sent } = adapter(["throw", { status: 201, body: { id: "stu_dup" } }]);
  await assert.rejects(() => a.createOrder!(ctx, {
    recruitmentProjectId: "p1", orderId: "o1", completes: 50, cpi: 1, currency: "GBP",
    entryUrl: "https://s.example.test/r", returnUrls: {}, audience: audience(),
  }));
  assert.equal(sent.length, 1);
});

test("a publish failure says the draft exists and NOTHING was spent", async () => {
  const { a } = adapter([{ status: 201, body: { id: "stu_x" } }, { status: 500 }]);
  const ack = await a.createOrder!(ctx, {
    recruitmentProjectId: "p1", orderId: "o1", completes: 50, cpi: 1, currency: "GBP",
    entryUrl: "https://s.example.test/r", returnUrls: {}, audience: audience(),
  });
  assert.equal(ack.status, "failed");
  assert.equal(ack.vendorOrderRef, "stu_x", "the id is returned so the draft can be found");
  assert.match(ack.message!, /nobody has been recruited and nothing has been spent/);
  assert.match(ack.message!, /Publish or delete it in Prolific/);
});

test("unmapped criteria are repeated on the order acknowledgement, not only at feasibility", async () => {
  const { a } = adapter([{ status: 201, body: { id: "stu_2" } }, { status: 200, body: { status: "ACTIVE" } }]);
  const ack = await a.createOrder!(ctx, {
    recruitmentProjectId: "p1", orderId: "o1", completes: 50, cpi: 1, currency: "GBP",
    entryUrl: "https://s.example.test/r", returnUrls: {},
    audience: audience({ demographics: { incomeBands: ["100k+"] } }),
  });
  assert.match(ack.message!, /income could not be expressed as a Prolific filter/);
});

test("status maps Prolific's vocabulary onto ours, and duplicates are 0 by construction", async () => {
  const { a } = adapter([
    { status: 200, body: { status: "ACTIVE" } },
    { status: 200, body: { APPROVED: 40, REJECTED: 3, AWAITING_REVIEW: 7 } },
  ]);
  const p = await a.orderStatus!(ctx, "stu_1");
  assert.equal(p.status, "live");
  assert.equal(p.accepted, 40);
  assert.equal(p.rejected, 3);
  assert.equal(p.delivered, 50);
  assert.equal(p.duplicates, 0, "Prolific's pool is already de-duplicated; 0 means not applicable");
});

test("only an APPROVED submission is billable", async () => {
  const { a } = adapter([{ status: 200, body: { results: [
    { participant_id: "p1", status: "APPROVED", reward: 250, completed_at: "2026-11-03T10:00:00Z" },
    { participant_id: "p2", status: "REJECTED", reward: 250 },
    { participant_id: "p3", status: "RETURNED" },
  ] } }]);
  const lines = await a.reconcile!(ctx, "stu_1");
  assert.deepEqual(lines.map((l) => l.billable), [true, false, false]);
  assert.equal(lines[0].amount, 2.5, "minor units come back as major");
  assert.equal(lines[2].amount, null);
});

test("a missing token is refused with a useful message, and the token is never echoed", async () => {
  const { a } = adapter([{ status: 200, body: { count: 1 } }]);
  await assert.rejects(
    () => a.feasibility!({ ...ctx, credentials: undefined }, { audience: audience(), requiredCompletes: 1, loiMinutes: 1 }),
    (e: unknown) => /has no API token/.test((e as Error).message) && !/tok_secret/.test((e as Error).message),
  );
});

test("the token is sent as `Token <...>`, the form Prolific documents", async () => {
  const { a, sent } = adapter([{ status: 200, body: { count: 5 } }]);
  await a.feasibility!(ctx, { audience: audience(), requiredCompletes: 1, loiMinutes: 1 });
  assert.equal(sent[0].headers.authorization, "Token tok_secret_do_not_log");
});

test("the webhook contract matches what Prolific documents", () => {
  assert.equal(PROLIFIC_WEBHOOK.signatureHeader, "x-prolific-request-signature");
  assert.equal(PROLIFIC_WEBHOOK.timestampHeader, "x-prolific-request-timestamp");
  assert.equal(PROLIFIC_WEBHOOK.eventIdHeader, "x-event-id");
  assert.equal(PROLIFIC_WEBHOOK.encoding, "base64");
  assert.equal(PROLIFIC_WEBHOOK.payload("1700000000", '{"a":1}'), '1700000000{"a":1}');
});
