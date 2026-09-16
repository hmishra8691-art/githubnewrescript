import { test } from "node:test";
import assert from "node:assert/strict";
import { interviewsBaseUrl, interviewsHandoffHref } from "./interviews-url.ts";

/**
 * Same arrangement as `surveyUploads.test.ts`: run directly against the source
 * with Node's type stripping (`node --experimental-strip-types
 * interviews-url.test.ts`), because apps/studio has no tsc-to-dist build. This
 * file imports nothing from Next and nothing aliased.
 */

function withEnv(value: string | undefined, fn: () => void) {
  const before = process.env.NEXT_PUBLIC_INTERVIEWS_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_INTERVIEWS_URL;
  else process.env.NEXT_PUBLIC_INTERVIEWS_URL = value;
  try { fn(); } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_INTERVIEWS_URL;
    else process.env.NEXT_PUBLIC_INTERVIEWS_URL = before;
  }
}

test("unset means no Interviews app, not localhost", () => {
  /*
   * The difference from `runtimeBaseUrl`, and the reason this test exists: a
   * localhost fallback here would put a dead link in the header of every
   * deployment that has not enabled the second product.
   */
  withEnv(undefined, () => {
    assert.equal(interviewsBaseUrl(), null);
    assert.equal(interviewsHandoffHref(), null);
  });
  withEnv("   ", () => assert.equal(interviewsBaseUrl(), null));
});

test("a bare host is made absolute", () => {
  /* without a scheme the browser resolves it as a RELATIVE path */
  withEnv("interviews.example.com", () =>
    assert.equal(interviewsBaseUrl(), "https://interviews.example.com"));
});

test("trailing slashes are removed", () => {
  withEnv("https://interviews.example.com///", () =>
    assert.equal(interviewsBaseUrl(), "https://interviews.example.com"));
});

test("http is kept, so a laptop can use it", () => {
  withEnv("http://localhost:3002", () =>
    assert.equal(interviewsBaseUrl(), "http://localhost:3002"));
});

test("the link goes through this origin's handoff route, never to the other host", () => {
  /*
   * The whole point. The session cookie is host-only, so a bare href arrives
   * signed out. If this ever starts returning an absolute URL to the Interviews
   * host, cross-app sign-in is silently broken again.
   */
  withEnv("https://interviews.example.com", () => {
    const href = interviewsHandoffHref("/");
    assert.ok(href!.startsWith("/api/auth/handoff?"), href!);
    const params = new URLSearchParams(href!.split("?")[1]);
    assert.equal(params.get("origin"), "https://interviews.example.com");
    /* "/" is the callback's own default — sending it is noise */
    assert.equal(params.get("next"), null);
  });
});

test("a next path is carried, and encoded", () => {
  withEnv("https://interviews.example.com", () => {
    const href = interviewsHandoffHref("/projects/a b");
    const params = new URLSearchParams(href!.split("?")[1]);
    assert.equal(params.get("next"), "/projects/a b");
    assert.ok(href!.includes("%2F"), "the path is encoded into the query string");
  });
});
