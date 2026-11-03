import test from "node:test";
import assert from "node:assert/strict";
import type { QualityConfig } from "@rescript/schema";
import { admissionFlags, admissionRisk, riskBand, type AdmissionSignals } from "./admission.js";

const cfg = (over: Partial<QualityConfig> = {}): QualityConfig => ({
  enabled: true, strictness: "standard", rules: {}, ...over,
} as QualityConfig);

const risk = (s: AdmissionSignals, c = cfg()) => admissionRisk(s, c, "2026-11-03T00:00:00.000Z");
const ids = (s: AdmissionSignals, c = cfg()) => admissionFlags(s, c).map((f) => f.ruleId);

test("a clean arrival scores zero and is not held", () => {
  const r = risk({ network: { identities: 1 }, device: { identities: 1 }, history: { participations: 3 } });
  assert.equal(r.score, 0);
  assert.equal(r.band, "low");
  assert.equal(r.quarantine, false);
  assert.deepEqual(r.flags, []);
});

test("an arrival with no signals at all is not suspicious — absence of evidence is not evidence", () => {
  const r = risk({});
  assert.equal(r.score, 0);
  assert.equal(r.quarantine, false);
});

test("the bands are the brief's §20 thresholds, on the same 0–100 scale as a finished response", () => {
  assert.equal(riskBand(0), "low");
  assert.equal(riskBand(24), "low");
  assert.equal(riskBand(25), "moderate");
  assert.equal(riskBand(49), "moderate");
  assert.equal(riskBand(50), "high");
  assert.equal(riskBand(74), "high");
  assert.equal(riskBand(75), "critical");
  assert.equal(riskBand(100), "critical");
});

test("Tor scores above a datacenter, which scores above a VPN — and a VPN is ignored by default", () => {
  const tor = risk({ network: { tor: true } }).score;
  const dc = risk({ network: { datacenter: true } }).score;
  assert.ok(tor > dc, `tor ${tor} should outscore datacenter ${dc}`);
  // a commercial VPN is not counted at standard strictness: plenty of ordinary people use one for everything
  assert.deepEqual(ids({ network: { vpn: true } }), []);
  const strict = ids({ network: { vpn: true } }, cfg({ strictness: "strict" }));
  assert.deepEqual(strict, ["network.datacenter"]);
});

test("a shared network is evidence with a caveat, never a verdict — the brief's §17", () => {
  // standard threshold is 12 distinct identities; a household or an office is nowhere near it
  assert.deepEqual(ids({ network: { identities: 4 } }), []);
  assert.deepEqual(ids({ network: { identities: 12 } }), [], "at the threshold, not above it");
  const flags = admissionFlags({ network: { identities: 40 } }, cfg());
  assert.deepEqual(flags.map((f) => f.ruleId), ["network.identity_density"]);
  assert.match(flags[0]!.caveat!, /household, an office or a mobile carrier/);
  // and on its own it cannot reach a band that holds anybody
  assert.equal(risk({ network: { identities: 40 } }).quarantine, false);
});

test("density is graded and capped, so 40 identities is worse than 13 but not four times worse", () => {
  const thirteen = risk({ network: { identities: 13 } }).score;
  const forty = risk({ network: { identities: 40 } }).score;
  const hundred = risk({ network: { identities: 100 } }).score;
  assert.ok(forty > thirteen);
  assert.equal(forty, hundred, "capped: beyond a point, more identities add nothing");
});

test("an automation flag is the one signal strong enough to hold somebody on its own", () => {
  const r = risk({ device: { automation: true } });
  assert.deepEqual(r.reasons, ["device.webdriver"]);
  assert.ok(r.score >= 50, `score ${r.score}`);
  assert.equal(r.quarantine, true);
  assert.equal(r.band === "high" || r.band === "critical", true);
});

test("network and device are one fact, not two, so they do not double-count", () => {
  const both = risk({ network: { datacenter: true, identities: 40 }, device: { identities: 30 } }).score;
  const sum = risk({ network: { datacenter: true } }).score
    + risk({ network: { identities: 40 } }).score
    + risk({ device: { identities: 30 } }).score;
  assert.ok(both < sum, `combined ${both} must be less than the naive sum ${sum}`);
});

test("a poor history needs enough history to mean anything", () => {
  // three rejections out of four participations is a pattern…
  const thin = admissionFlags({ history: { participations: 4, rejections: 3 } }, cfg());
  assert.deepEqual(thin.map((f) => f.ruleId), ["history.refused_elsewhere"]);
  assert.ok(thin[0]!.confidence! < 1, "but it is scored with less confidence");
  assert.match(thin[0]!.caveat!, /only a few prior participations/);

  // …and the same three out of two hundred is a person having a bad run
  const thick = admissionFlags({ history: { participations: 200, rejections: 3 } }, cfg());
  assert.equal(thick[0]!.confidence, 1);
  assert.equal(thick[0]!.caveat, undefined);
  assert.ok(risk({ history: { participations: 200, rejections: 3 } }).score
    > risk({ history: { participations: 4, rejections: 3 } }).score);
});

test("a clean history never fires, however many participations", () => {
  assert.deepEqual(ids({ history: { participations: 500, rejections: 0, duplicates: 0 } }), []);
  assert.deepEqual(ids({ history: { participations: 500, rejections: 2, duplicates: 4 } }), [], "at the thresholds");
});

test("the provider risk rule only fires when a provider actually reported something", () => {
  assert.deepEqual(ids({ network: {} }), [], "no provider configured, no flag");
  assert.deepEqual(ids({ network: { providerRisk: 50 } }), [], "below the standard minimum of 75");
  assert.deepEqual(ids({ network: { providerRisk: 90 } }), ["network.risk_provider"]);
});

test("every flag says what it SAW, in words a reviewer can repeat to a vendor", () => {
  const flags = admissionFlags({ network: { tor: true, identities: 40 }, device: { identities: 30, automation: true } }, cfg());
  for (const f of flags) {
    assert.ok(f.observed && f.observed.length > 0, `${f.ruleId} has no observation`);
    assert.ok(f.explanation.length > 20, `${f.ruleId} has no explanation`);
    assert.doesNotMatch(f.explanation, /suspicious|fraud|fraudulent/i, `${f.ruleId} states a verdict rather than a fact`);
  }
});

test("a researcher can switch a rule off, and then it does not fire", () => {
  const off = cfg({ rules: { "network.identity_density": { enabled: false } } } as Partial<QualityConfig>);
  assert.deepEqual(ids({ network: { identities: 100 } }, off), []);
});

test("scoring is pure: the same signals always give the same score", () => {
  const s: AdmissionSignals = { network: { datacenter: true, identities: 20 }, device: { identities: 9 }, history: { participations: 30, rejections: 5 } };
  const a = risk(s);
  for (let i = 0; i < 5; i++) assert.equal(risk(s).score, a.score);
  assert.deepEqual(risk(s).reasons, a.reasons);
});

test("the ceiling: pre-entry evidence cannot reach the critical band", () => {
  // every rule firing at once, at maximum intensity
  const worst = risk({
    network: { tor: true, datacenter: true, identities: 500, providerRisk: 100 },
    device: { identities: 500, automation: true },
    history: { participations: 500, rejections: 400, duplicates: 400 },
  });
  assert.equal(worst.reasons.length, 6, "all six admission rules fired");
  /*
   * 74 — one below `critical`. The critical band is reserved for evidence this layer does not have: the
   * respondent's answers, timings and peers. Circumstantial evidence about a network and a device, however
   * much of it there is, is not certainty about a person. If a weight change ever pushes this past 75, this
   * assertion fails rather than letting the strongest pre-entry outcome quietly become indistinguishable
   * from proven fraud.
   */
  assert.ok(worst.score < 75, `the pre-entry ceiling is ${worst.score}; it must stay below the critical band`);
  assert.equal(worst.band, "high");
  assert.equal(worst.quarantine, true);
});

test("nothing here can refuse anybody — the strongest outcome is a hold for review", () => {
  const worst = risk({ network: { tor: true }, device: { automation: true } });
  assert.equal(worst.quarantine, true);
  // the shape has no field that could mean "refuse", by design
  assert.equal("refuse" in worst, false);
  assert.equal("block" in worst, false);
  assert.equal("admit" in worst, false);
});
