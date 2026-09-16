import test from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_CALLBACK_PATH,
  handoffCallbackUrl,
  handoffStartUrl,
  normaliseOrigin,
  originAllowed,
  parseAllowedOrigins,
  safeNextPath,
} from "./handoff.js";

/*
 * These are the checks standing between an endpoint that mints sessions and an
 * open redirect. Each one below is written as the attack it refuses rather
 * than as the shape it accepts, because "returns a string" would pass for all
 * of them.
 */

test("safeNextPath refuses a protocol-relative URL", () => {
  /* the whole reason a leading-slash check is not enough: this IS a URL */
  assert.equal(safeNextPath("//evil.example/steal"), "/");
  assert.equal(safeNextPath("//evil.example"), "/");
});

test("safeNextPath refuses an absolute URL", () => {
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("http://evil.example"), "/");
  assert.equal(safeNextPath("javascript:alert(1)"), "/");
});

test("safeNextPath refuses backslashes, which some parsers read as slashes", () => {
  assert.equal(safeNextPath("/\\evil.example"), "/");
  assert.equal(safeNextPath("\\\\evil.example"), "/");
});

test("safeNextPath refuses anything that is not a string", () => {
  assert.equal(safeNextPath(null), "/");
  assert.equal(safeNextPath(undefined), "/");
  assert.equal(safeNextPath(42 as unknown as string), "/");
});

test("safeNextPath keeps an ordinary path, query and fragment", () => {
  assert.equal(safeNextPath("/projects/abc"), "/projects/abc");
  assert.equal(safeNextPath("/projects?tab=questions"), "/projects?tab=questions");
  assert.equal(safeNextPath("/"), "/");
});

test("normaliseOrigin strips path, query and trailing slash", () => {
  assert.equal(normaliseOrigin("https://a.example/"), "https://a.example");
  assert.equal(normaliseOrigin("https://a.example/some/path?x=1"), "https://a.example");
  assert.equal(normaliseOrigin("  https://a.example  "), "https://a.example");
});

test("normaliseOrigin keeps a port, because a port is part of an origin", () => {
  assert.equal(normaliseOrigin("http://localhost:3002"), "http://localhost:3002");
  assert.notEqual(normaliseOrigin("http://localhost:3002"), normaliseOrigin("http://localhost:3000"));
});

test("normaliseOrigin refuses schemes that are not http(s)", () => {
  assert.equal(normaliseOrigin("javascript:alert(1)"), null);
  assert.equal(normaliseOrigin("file:///etc/passwd"), null);
  assert.equal(normaliseOrigin("data:text/html,x"), null);
});

test("normaliseOrigin refuses a bare hostname, which is not an origin", () => {
  assert.equal(normaliseOrigin("interviews.example"), null);
  assert.equal(normaliseOrigin(""), null);
  assert.equal(normaliseOrigin(null), null);
});

test("parseAllowedOrigins tolerates spacing and trailing slashes", () => {
  assert.deepEqual(
    parseAllowedOrigins("https://a.example/, https://b.example , https://c.example"),
    ["https://a.example", "https://b.example", "https://c.example"],
  );
});

test("parseAllowedOrigins drops entries it cannot read rather than failing open", () => {
  assert.deepEqual(parseAllowedOrigins("https://a.example,,not-a-url,"), ["https://a.example"]);
  assert.deepEqual(parseAllowedOrigins(""), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
});

test("parseAllowedOrigins does not repeat an origin listed twice", () => {
  assert.deepEqual(
    parseAllowedOrigins("https://a.example,https://a.example/"),
    ["https://a.example"],
  );
});

test("an unset allowlist permits nothing", () => {
  /*
   * The important default. An installation that has not configured this must
   * refuse every handoff, not accept every handoff.
   */
  const allowed = parseAllowedOrigins(undefined);
  assert.equal(originAllowed("https://anything.example", allowed), false);
});

test("originAllowed matches on origin, not on string equality", () => {
  const allowed = parseAllowedOrigins("https://a.example");
  assert.equal(originAllowed("https://a.example/", allowed), true);
  assert.equal(originAllowed("https://a.example/deep/path", allowed), true);
});

test("originAllowed refuses a lookalike host", () => {
  const allowed = parseAllowedOrigins("https://a.example");
  assert.equal(originAllowed("https://a.example.evil.test", allowed), false);
  assert.equal(originAllowed("https://evil.test/?x=https://a.example", allowed), false);
  /* a different scheme is a different origin */
  assert.equal(originAllowed("http://a.example", allowed), false);
});

test("originAllowed refuses a subdomain that was not listed", () => {
  const allowed = parseAllowedOrigins("https://a.example");
  assert.equal(originAllowed("https://sub.a.example", allowed), false);
});

test("handoffStartUrl points at the handoff, never at the login form", () => {
  const url = handoffStartUrl("https://studio.example", "https://interviews.example", "/projects/1");
  assert.ok(url);
  const u = new URL(url!);
  assert.equal(u.origin, "https://studio.example");
  assert.equal(u.pathname, "/api/auth/handoff");
  assert.equal(u.searchParams.get("origin"), "https://interviews.example");
  assert.equal(u.searchParams.get("next"), "/projects/1");
});

test("handoffStartUrl sanitises next before it is ever sent", () => {
  const url = handoffStartUrl("https://studio.example", "https://interviews.example", "//evil.example");
  assert.equal(new URL(url!).searchParams.get("next"), "/");
});

test("handoffStartUrl gives null rather than a broken link when unconfigured", () => {
  assert.equal(handoffStartUrl("https://studio.example", "", "/"), null);
  assert.equal(handoffStartUrl("", "https://interviews.example", "/"), null);
});

test("handoffCallbackUrl targets the agreed path on the agreed origin", () => {
  const url = handoffCallbackUrl("https://interviews.example/", "abc123", "/projects/1");
  const u = new URL(url!);
  assert.equal(u.origin, "https://interviews.example");
  assert.equal(u.pathname, HANDOFF_CALLBACK_PATH);
  assert.equal(u.searchParams.get("code"), "abc123");
  assert.equal(u.searchParams.get("next"), "/projects/1");
});

test("handoffCallbackUrl cannot be steered by the code or the next", () => {
  /*
   * Both are attacker-influenced in the worst case. Neither may change WHERE
   * the browser is sent — only the query string of the one allowed origin.
   */
  const url = handoffCallbackUrl("https://interviews.example", "x", "//evil.example");
  assert.equal(new URL(url!).origin, "https://interviews.example");
  assert.equal(new URL(url!).searchParams.get("next"), "/");
});

test("handoffCallbackUrl refuses to build a link with no code", () => {
  assert.equal(handoffCallbackUrl("https://interviews.example", "", "/"), null);
});
