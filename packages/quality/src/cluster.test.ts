import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterSignature, detectClusters, signalWeight, DEFAULT_CLUSTER_CONFIG,
  type ClusterIdentity, type SignalKind,
} from "./cluster.js";

const cfg = DEFAULT_CLUSTER_CONFIG;

/** n identities circulating through d devices on one network — the click-farm shape. */
function ring(n: number, d: number, prefix = "f", opts: { network?: boolean; start?: number; stepMin?: number } = {}): ClusterIdentity[] {
  const out: ClusterIdentity[] = [];
  const t0 = opts.start ?? Date.parse("2026-11-03T10:00:00.000Z");
  for (let i = 0; i < n; i++) {
    const signals: { kind: SignalKind; token: string }[] = [{ kind: "device", token: `${prefix}-dev-${i % d}` }];
    if (opts.network !== false) signals.push({ kind: "network", token: `${prefix}-net` });
    out.push({ id: `${prefix}-id-${i}`, signals, firstSeen: new Date(t0 + i * (opts.stepMin ?? 2) * 60_000).toISOString() });
  }
  return out;
}

test("a signal shared by too many identities is not an edge at all — it is infrastructure", () => {
  assert.equal(signalWeight("network", 2, cfg), 0.45, "two people on one address is real evidence");
  assert.ok(signalWeight("network", 8, cfg) < signalWeight("network", 2, cfg), "rarer links are worth more");
  assert.equal(signalWeight("network", 51, cfg), 0, "past the ceiling the edge is dropped, not merely weakened");
  assert.equal(signalWeight("network", 5000, cfg), 0, "a carrier NAT links nobody to anybody");
  assert.equal(signalWeight("device", 1, cfg), 0, "a signal only one identity holds links nothing");
  assert.ok(signalWeight("device", 4, cfg) > signalWeight("network", 4, cfg), "a device is a stronger link than an address");
});

test("a carrier NAT does not swallow the platform", () => {
  // 400 unrelated people behind one mobile carrier address, each with their own device
  const carrier: ClusterIdentity[] = Array.from({ length: 400 }, (_, i) => ({
    id: `nat-${i}`,
    signals: [{ kind: "network" as const, token: "carrier-nat" }, { kind: "device" as const, token: `nat-dev-${i}` }],
    firstSeen: new Date(Date.parse("2026-11-03T10:00:00.000Z") + i * 30_000).toISOString(),
  }));
  assert.deepEqual(detectClusters(carrier, cfg), [], "400 strangers on one carrier are not a ring");
});

test("a household is not a click farm, however often it is seen", () => {
  // four people, two tablets, one router — the archetypal false positive
  const household: ClusterIdentity[] = Array.from({ length: 4 }, (_, i) => ({
    id: `home-${i}`,
    signals: [{ kind: "device" as const, token: `home-dev-${i % 2}` }, { kind: "network" as const, token: "home-net" }],
    firstSeen: new Date(Date.parse("2026-11-03T10:00:00.000Z") + i * 3_600_000).toISOString(),
  }));
  assert.deepEqual(detectClusters(household, cfg), [], "ratio 2.0 is ordinary sharing");
});

test("a student house of eight on three devices is still not reported", () => {
  const house = ring(8, 3, "house", { stepMin: 240 });
  const found = detectClusters(house, cfg);
  // ratio 2.67, below the household threshold of 3 — must not clear the bar
  assert.deepEqual(found, [], "sharing is not circulation");
});

test("forty identities circulating through six devices is", () => {
  const found = detectClusters(ring(40, 6, "farm"), cfg);
  assert.equal(found.length, 1);
  const c = found[0]!;
  assert.equal(c.size, 40);
  assert.equal(c.devices, 6);
  assert.equal(c.identitiesPerDevice, 6.67);
  assert.ok(c.score >= cfg.minScore, `score ${c.score}`);
  assert.deepEqual(c.signals, ["device", "network"]);
  assert.match(String(c.evidence.note), /infrastructure rather than treated as links/);
});

test("the ratio dominates: more identities on proportionally more devices does not score higher", () => {
  const tight = detectClusters(ring(40, 5, "a"), cfg)[0]!;
  const loose = detectClusters(ring(60, 20, "b"), cfg);
  assert.ok(tight.score > 0);
  // 60 identities is a bigger group, but 3.0 per device is household-shaped, so it is not reported
  assert.deepEqual(loose, [], "size alone is not the signal");
});

test("unrelated rings are separate clusters, not one", () => {
  const found = detectClusters([...ring(20, 3, "x"), ...ring(20, 3, "y")], cfg);
  assert.equal(found.length, 2);
  assert.equal(found[0]!.size, 20);
  assert.equal(found[1]!.size, 20);
  const overlap = found[0]!.members.filter((m) => found[1]!.members.includes(m));
  assert.deepEqual(overlap, [], "two rings sharing nothing must not be merged");
});

test("a burst raises the score, and a ring trickling in over weeks still registers on its ratio", () => {
  const fast = detectClusters(ring(30, 4, "fast", { stepMin: 1 }), cfg)[0]!;
  const slow = detectClusters(ring(30, 4, "slow", { stepMin: 60 * 24 }), cfg)[0]!;
  assert.ok(fast.burst > slow.burst, "arrivals inside one window are a burst");
  assert.ok(fast.score >= slow.score);
  assert.ok(slow.score >= cfg.minScore, "patience does not make a ring legitimate");
});

test("the signature is stable, order-independent, and distinguishes different member sets", () => {
  const a = clusterSignature(["b", "a", "c"]);
  assert.equal(a, clusterSignature(["c", "b", "a"]), "the same members in any order are the same cluster");
  assert.notEqual(a, clusterSignature(["a", "b", "d"]));
  assert.notEqual(a, clusterSignature(["a", "b"]));
  assert.match(a, /^cl_[0-9a-f]{16}$/);
});

test("detection is deterministic and ordered strongest first", () => {
  const input = [...ring(40, 5, "big"), ...ring(12, 2, "small")];
  const once = detectClusters(input, cfg);
  for (let i = 0; i < 4; i++) assert.deepEqual(detectClusters(input, cfg), once);
  if (once.length > 1) assert.ok(once[0]!.score >= once[1]!.score);
  // members are sorted, so the same ring always produces the same signature
  assert.deepEqual(once[0]!.members, [...once[0]!.members].sort());
});

test("size and ratio must BOTH be substantial — neither alone reports a ring", () => {
  // below the size floor nothing is even considered, however extreme the ratio
  assert.deepEqual(detectClusters(ring(5, 1, "tiny"), cfg), [], "five identities is not a network");

  /*
   * At the floor with ratio 6 it scores 42 — under the reporting threshold. The size floor is NECESSARY, not
   * sufficient: six people round one tablet is a family gathering as easily as a fraud ring, and the system
   * does not have enough to tell them apart. Twelve on two devices is the same ratio with enough of it to say
   * something, and is reported.
   */
  assert.deepEqual(detectClusters(ring(6, 1, "six"), cfg), [], "six at ratio 6 is suspicious but not enough");
  assert.equal(detectClusters(ring(12, 2, "twelve"), cfg).length, 1, "the same ratio, with enough of it");

  // and a very high ratio can clear the bar at a smaller size, because circulation is the signal
  assert.equal(detectClusters(ring(8, 1, "eight"), cfg).length, 1, "eight identities on one device is ratio 8");

  // while a large group at household ratio is never reported, however large
  assert.deepEqual(detectClusters(ring(12, 4, "wide"), cfg), [], "ratio 3.0 is sharing, at any size");
});

test("identities with no shared signals at all produce nothing", () => {
  const strangers: ClusterIdentity[] = Array.from({ length: 50 }, (_, i) => ({
    id: `s-${i}`, signals: [{ kind: "device" as const, token: `s-dev-${i}` }],
  }));
  assert.deepEqual(detectClusters(strangers, cfg), []);
  assert.deepEqual(detectClusters([], cfg), []);
});

test("the thresholds are configurable, because the right answer differs by study", () => {
  const house = ring(8, 3, "cfghouse", { stepMin: 240 });
  assert.deepEqual(detectClusters(house, cfg), []);
  // a B2B study where every respondent is in one office needs a looser bar; a consumer study a tighter one
  const strict = detectClusters(house, { ...cfg, householdRatio: 1.5, farmRatio: 2.5, minSize: 4, minScore: 30 });
  assert.equal(strict.length, 1, "a tighter configuration reports what the default tolerates");
});
