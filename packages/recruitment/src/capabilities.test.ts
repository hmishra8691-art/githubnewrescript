import test from "node:test";
import assert from "node:assert/strict";
import type { VendorCapabilityState } from "@rescript/schema";
import { CapabilityError, capabilityMatrix, capabilityState, integrationSummary, modeAllows, requireCapability } from "./capabilities.js";

const declared = (c: string): VendorCapabilityState => ({ capability: c as never, supported: true, verifiedAt: null });
const verified = (c: string): VendorCapabilityState => ({ capability: c as never, supported: true, verifiedAt: "2026-11-01T00:00:00.000Z" });

const ALL = ["feasibility", "quote", "order", "status", "reconcile", "cancel", "refund", "identity_token", "webhook"] as const;

test("a mode is a ceiling no adapter can raise", () => {
  assert.equal(modeAllows("redirect_only", "feasibility"), false);
  assert.equal(modeAllows("redirect_only", "webhook"), true);
  assert.equal(modeAllows("awaiting", "order"), false);
  assert.equal(modeAllows("manual", "order"), true);
  // the manual relationship has no machine channel for a token exchange
  assert.equal(modeAllows("manual", "identity_token"), false);
  assert.equal(modeAllows("api", "identity_token"), true);
});

test("a redirect-only vendor cannot be made to answer a feasibility request", () => {
  // the adapter implements it and the database says supported — the mode still refuses
  assert.equal(capabilityState("redirect_only", "feasibility", ALL, [declared("feasibility")]), "unsupported");
  assert.throws(
    () => requireCapability("Toluna", "redirect_only", "feasibility", ALL, [declared("feasibility")]),
    (e: unknown) => e instanceof CapabilityError && /does not support it/.test((e as Error).message),
  );
});

test("declared is not verified — the distinction the brief's §5 turns on", () => {
  assert.equal(capabilityState("api", "quote", ALL, [declared("quote")]), "declared");
  assert.equal(capabilityState("api", "quote", ALL, [verified("quote")]), "verified");
  // recorded but switched off, and recorded for nothing at all
  assert.equal(capabilityState("api", "quote", ALL, [{ capability: "quote", supported: false, verifiedAt: null }]), "unsupported");
  assert.equal(capabilityState("api", "quote", ALL, []), "unsupported");
});

test("an adapter that does not implement an operation never has it, whatever the database says", () => {
  assert.equal(capabilityState("api", "refund", ["feasibility", "quote"], [verified("refund")]), "unsupported");
});

test("the matrix covers every capability, so a screen cannot read one as absent-and-therefore-fine", () => {
  const m = capabilityMatrix("manual", ALL, [declared("feasibility"), verified("order")]);
  assert.equal(Object.keys(m).length, ALL.length);
  assert.equal(m.feasibility, "declared");
  assert.equal(m.order, "verified");
  assert.equal(m.quote, "unsupported");
  assert.equal(m.identity_token, "unsupported");
});

test("the summary sentence says what is true, and never implies a vendor is live", () => {
  assert.match(integrationSummary("awaiting", capabilityMatrix("awaiting", ALL, [])), /Awaiting integration/);
  assert.match(integrationSummary("redirect_only", capabilityMatrix("redirect_only", ALL, [])), /Recruitment links only/);
  // with no pricing count given, the sentence makes NO claim about pricing — it cannot know
  assert.match(integrationSummary("manual", capabilityMatrix("manual", ALL, [])), /enters feasibility and orders by hand/);
  assert.doesNotMatch(integrationSummary("manual", capabilityMatrix("manual", ALL, [])), /pricing|priced|rate card/i);
  assert.match(integrationSummary("manual", capabilityMatrix("manual", ALL, [declared("feasibility")])), /entered by an operator/);
  const fresh = integrationSummary("api", capabilityMatrix("api", ALL, [declared("quote"), declared("order")]));
  assert.match(fresh, /none yet verified/);
  assert.doesNotMatch(fresh, /\bverified,/);
});

test("the manual summary does not contradict the rate card beside it", () => {
  const matrix = capabilityMatrix("manual", ALL, []);

  /*
   * The bug this pins: the sentence described PRICING while reading only the capability matrix, which knows
   * nothing about rate cards. An integration with two priced markets and no recorded capabilities announced
   * "no pricing configured yet" directly above a line reading "Rate card: 2 rows".
   */
  const withRates = integrationSummary("manual", matrix, 2);
  assert.doesNotMatch(withRates, /no pricing|no rate card/i, "it must not deny pricing that exists");
  assert.match(withRates, /priced in 2 markets/);

  const without = integrationSummary("manual", matrix, 0);
  assert.match(without, /no rate card yet/, "and must say so plainly when there genuinely is none");

  assert.match(integrationSummary("manual", matrix, 1), /priced in 1 market(?!s)/, "singular reads correctly");
});

test("recorded operations and priced markets are reported together, not instead of each other", () => {
  const matrix = capabilityMatrix("manual", ALL, [declared("feasibility"), declared("order")]);
  const s = integrationSummary("manual", matrix, 3);
  assert.match(s, /priced in 3 markets/);
  assert.match(s, /2 operations configured/);
});
