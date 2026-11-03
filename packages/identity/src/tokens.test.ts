import test from "node:test";
import assert from "node:assert/strict";
import {
  IdentityKeyError, keyRing, matchToken, matchTokensForLookup, normaliseEmail, normalisePhone,
  tokensForArrival, tokensEqual, TOKEN_STRENGTH,
} from "./tokens.js";

const K1 = "a".repeat(64);
const K2 = "b".repeat(64);
const ring = (env: Record<string, string | undefined> = { RTID_MATCH_KEY: K1 }) => keyRing(env);

test("the key is required and has no default — a guessable key would be worse than refusing to run", () => {
  assert.throws(() => keyRing({}), (e: unknown) => e instanceof IdentityKeyError && /RTID_MATCH_KEY is not set/.test((e as Error).message));
  assert.throws(() => keyRing({ RTID_MATCH_KEY: "short" }), IdentityKeyError);
  assert.throws(() => keyRing({ RTID_MATCH_KEY: "   " }), IdentityKeyError);
  assert.ok(ring().current.key.length >= 32);
});

test("a token is not the value, and the key decides it", () => {
  const t = matchToken(ring(), "email", "Person@Example.COM")!;
  assert.equal(t.token.length, 32);
  assert.doesNotMatch(t.token, /person|example/i, "no part of the address survives");
  const other = matchToken(keyRing({ RTID_MATCH_KEY: K2 }), "email", "person@example.com")!;
  assert.notEqual(t.token, other.token, "a different key gives a different token");
});

test("the kind is inside the hash, so a vendor id that looks like an e-mail is not one", () => {
  const asEmail = matchToken(ring(), "email", "x@y.zz")!;
  const asVendor = matchToken(ring(), "vendor_pid", "x@y.zz")!;
  assert.notEqual(asEmail.token, asVendor.token);
});

test("e-mail normalisation trims and lower-cases, and deliberately does NOTHING else", () => {
  assert.equal(normaliseEmail("  Person@Example.COM "), "person@example.com");
  /*
   * Over-normalising merges two people, and in this system that means refusing one of them a day's work.
   * Plenty of providers deliver a.b@ and ab@ to different people, and `+` is a legal, meaningful character.
   */
  assert.notEqual(normaliseEmail("a.b@gmail.com"), normaliseEmail("ab@gmail.com"));
  assert.notEqual(normaliseEmail("a+tag@gmail.com"), normaliseEmail("a@gmail.com"));
  assert.equal(normaliseEmail("not-an-email"), null);
  assert.equal(normaliseEmail("no@tld"), null);
  assert.equal(normaliseEmail("@example.com"), null);
  assert.equal(normaliseEmail(""), null);
});

test("phone normalisation keeps the international prefix and never guesses a country", () => {
  assert.equal(normalisePhone("+44 7700 900123"), "+447700900123");
  assert.equal(normalisePhone("+44-7700-900123"), "+447700900123");
  // a bare national number is NOT promoted to a guessed country code: that would merge strangers
  assert.equal(normalisePhone("07700 900123"), "07700900123");
  assert.notEqual(normalisePhone("07700900123"), normalisePhone("+447700900123"));
  assert.equal(normalisePhone("12345"), null);
  assert.equal(normalisePhone("x".repeat(40)), null);
});

test("a value that does not normalise produces no token at all", () => {
  assert.equal(matchToken(ring(), "email", "nonsense"), null);
  assert.equal(matchToken(ring(), "phone", "123"), null);
  assert.equal(matchToken(ring(), "vendor_pid", "   "), null);
});

test("strength is a property of the kind, not of the caller", () => {
  assert.equal(TOKEN_STRENGTH.email, "deterministic");
  assert.equal(TOKEN_STRENGTH.vendor_pid, "deterministic");
  assert.equal(TOKEN_STRENGTH.device, "probabilistic");
  assert.equal(TOKEN_STRENGTH.network, "probabilistic");
  assert.equal(matchToken(ring(), "device", "fp-123")!.strength, "probabilistic");
});

test("circumstantial tokens expire and identifying ones do not", () => {
  const now = new Date("2026-11-03T00:00:00.000Z");
  assert.equal(matchToken(ring(), "email", "a@b.cc", now)!.expires_at, undefined);
  assert.equal(matchToken(ring(), "vendor_pid", "PID-1", now)!.expires_at, undefined);
  // a network changes constantly; a device less so
  assert.equal(matchToken(ring(), "network", "net-1", now)!.expires_at, "2026-12-03T00:00:00.000Z");
  assert.equal(matchToken(ring(), "device", "dev-1", now)!.expires_at, "2027-05-02T00:00:00.000Z");
});

test("rotation: look up under every key, write under the current one", () => {
  const rotated = keyRing({ RTID_MATCH_KEY: K2, RTID_MATCH_KEY_PREVIOUS: K1 });
  const lookup = matchTokensForLookup(rotated, "email", "person@example.com");
  assert.equal(lookup.length, 2, "the retired key still finds what it wrote");
  assert.equal(lookup[0]!.token, matchToken(rotated, "email", "person@example.com")!.token);
  assert.equal(lookup[1]!.token, matchToken(ring(), "email", "person@example.com")!.token, "the old key's token");
  assert.notEqual(lookup[0]!.key_id, lookup[1]!.key_id);
  // and with no previous keys there is exactly one
  assert.equal(matchTokensForLookup(ring(), "email", "person@example.com").length, 1);
});

test("an arrival's tokens skip what is missing or unusable", () => {
  const out = tokensForArrival(ring(), {
    vendor_pid: "CINT-1", device: "fp-abc", email: "not an address", phone: undefined, network: "",
  });
  assert.deepEqual(out.map((t) => t.kind), ["vendor_pid", "device"]);
  assert.deepEqual(out.map((t) => t.strength), ["deterministic", "probabilistic"]);
});

test("the same value always gives the same token, which is the whole point", () => {
  const a = matchToken(ring(), "email", "person@example.com")!;
  const b = matchToken(ring(), "email", "  PERSON@EXAMPLE.COM  ")!;
  assert.ok(tokensEqual(a.token, b.token));
  assert.equal(tokensEqual(a.token, "x"), false, "different lengths compare false rather than throwing");
});
