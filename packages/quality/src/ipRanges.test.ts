import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_IP_SOURCES, parseIpRanges, operatorFeed, normaliseCidr, cidrContains, isIp } from "./ipRanges.js";
import { admissionRisk } from "./admission.js";

/*
 * F2, the free layer: each published format parsed from a sample in the shape its owner publishes (trimmed), bad
 * lines skipped and counted, blocks normalised, and the admission rule naming the provider. The download and the
 * database lookup are the cron job's and migration 0117's (tested on Postgres separately).
 */

test("addresses and blocks: IPv4, IPv6 (compressed, embedded IPv4), bare addresses as /32 and /128, junk refused", () => {
  assert.ok(isIp("203.0.113.7")); assert.ok(isIp("2001:db8::1")); assert.ok(isIp("::ffff:192.0.2.1"));
  assert.ok(!isIp("256.1.1.1")); assert.ok(!isIp("2001:db8:::1")); assert.ok(!isIp("example.com"));
  assert.equal(normaliseCidr("3.5.140.0/22"), "3.5.140.0/22");
  assert.equal(normaliseCidr(" 185.220.101.5 "), "185.220.101.5/32");
  assert.equal(normaliseCidr("2600:1F00::/24"), "2600:1f00::/24");
  assert.equal(normaliseCidr("2a06:98c0::1"), "2a06:98c0::1/128");
  for (const bad of ["10.0.0.0/33", "10.0.0.0/4", "1.2.3/24", "x/8", "1.2.3.4/24/1", "::/8", ""]) assert.equal(normaliseCidr(bad), null, bad);
  assert.ok(cidrContains("52.94.0.0/16", "52.94.12.7")); assert.ok(!cidrContains("52.94.0.0/16", "52.95.0.1"));
  assert.ok(cidrContains("2600:1f00::/24", "2600:1f18::1")); assert.ok(!cidrContains("2600:1f00::/24", "2600:2000::1"));
  assert.ok(cidrContains("185.220.101.5/32", "185.220.101.5")); assert.ok(!cidrContains("185.220.101.5/32", "185.220.101.6"));
});

test("AWS, Google Cloud and Oracle JSON; DigitalOcean / Linode CSV; Cloudflare and Tor line lists", () => {
  const aws = parseIpRanges("aws", JSON.stringify({ syncToken: "1", prefixes: [{ ip_prefix: "3.5.140.0/22", region: "ap-northeast-2", service: "AMAZON" }, { ip_prefix: "52.94.0.0/16" }, { ip_prefix: "bogus" }], ipv6_prefixes: [{ ipv6_prefix: "2600:1f00::/24" }] }));
  assert.deepEqual(aws.cidrs.sort(), ["2600:1f00::/24", "3.5.140.0/22", "52.94.0.0/16"]); assert.equal(aws.skipped, 1);
  const gcp = parseIpRanges("gcp", JSON.stringify({ prefixes: [{ ipv4Prefix: "34.1.208.0/20", service: "Google Cloud", scope: "africa-south1" }, { ipv6Prefix: "2600:1900:8000::/44" }] }));
  assert.deepEqual(gcp.cidrs, ["34.1.208.0/20", "2600:1900:8000::/44"]);
  const oracle = parseIpRanges("oracle", JSON.stringify({ regions: [{ region: "us-ashburn-1", cidrs: [{ cidr: "129.213.0.0/16", tags: ["OCI"] }, { cidr: "134.70.24.0/21" }] }] }));
  assert.deepEqual(oracle.cidrs, ["129.213.0.0/16", "134.70.24.0/21"]);
  const csv = parseIpRanges("csv_first", "# comment\n104.131.0.0/18,US,US-NJ,North Bergen,07047\n2604:a880::/32,US,US-NY,New York,10013\n\nnot-an-ip,XX\n");
  assert.deepEqual(csv.cidrs, ["104.131.0.0/18", "2604:a880::/32"]); assert.equal(csv.skipped, 1);
  const lines = parseIpRanges("lines", "173.245.48.0/20\n103.21.244.0/22\n");
  assert.deepEqual(lines.cidrs, ["173.245.48.0/20", "103.21.244.0/22"]);
  const tor = parseIpRanges("lines", "185.220.101.5\n185.220.101.5\n2a0b:f4c2::23\n");
  assert.deepEqual(tor.cidrs, ["185.220.101.5/32", "2a0b:f4c2::23/128"], "duplicates once");
  assert.deepEqual(parseIpRanges("aws", "<html>error</html>"), { cidrs: [], skipped: 0 }, "an error page parses to nothing (the job then keeps the old list)");
});

test("the catalogue: datacenter and Tor only (VPN and proxy come from a licensed feed), https, a sanity floor each", () => {
  assert.deepEqual([...new Set(FREE_IP_SOURCES.map((s) => s.kind))].sort(), ["datacenter", "tor"]);
  for (const s of FREE_IP_SOURCES) { assert.ok(s.urls.every((u) => u.startsWith("https://")), s.id); assert.ok(s.minRanges > 0, s.id); assert.match(s.id, /^[a-z0-9_-]{2,40}$/); }
});

test("a licensed or operator feed: cidr,kind lines into vpn / proxy / datacenter / tor; bad lines counted", () => {
  const f = operatorFeed("cidr,kind\n198.51.100.0/24,vpn\n203.0.113.0/24,proxy\n192.0.2.0/24,hosting\n10.0.0.0/33,vpn\n# note\n");
  assert.deepEqual(f.byKind.vpn, ["198.51.100.0/24"]); assert.deepEqual(f.byKind.proxy, ["203.0.113.0/24"]);
  assert.equal(f.skipped, 2);
});

test("the admission rule names the provider; a proxy from a licensed feed counts like a datacenter, a VPN only when asked", () => {
  const cfg = { enabled: true, strictness: "standard", rules: {} } as never;
  const dc = admissionRisk({ network: { datacenter: true, providers: ["Amazon Web Services"] } }, cfg);
  const f = dc.flags.find((x) => x.ruleId === "network.datacenter")!;
  assert.equal(f.observed, "a datacenter or hosting provider (Amazon Web Services)");
  const px = admissionRisk({ network: { proxy: true, providers: ["Licensed feed"] } }, cfg).flags.find((x) => x.ruleId === "network.datacenter")!;
  assert.match(px.observed!, /public or residential proxy/);
  assert.equal(admissionRisk({ network: { vpn: true } }, cfg).flags.some((x) => x.ruleId === "network.datacenter"), false, "a VPN alone is not counted at standard settings");
  assert.equal(admissionRisk({ network: {} }, cfg).flags.some((x) => x.ruleId === "network.datacenter"), false);
});
