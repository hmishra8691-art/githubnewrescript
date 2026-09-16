import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amzDate, canonicalRequest, encodeKey, presign, signRequest, signatureHex, stringToSign, uriEncode,
} from "./sigv4.js";

/**
 * SIGV4, AGAINST AWS'S OWN TEST VECTORS.
 *
 * Hand-rolling a signature algorithm is only defensible if it is checked
 * against the definition rather than against itself. These are the documented
 * vectors from the AWS Signature Version 4 test suite, with the canonical
 * request, string-to-sign and signature all asserted — because a bug in
 * canonicalisation produces a wrong signature, and a test that only checks
 * the signature against our own canonicalisation would agree with the bug.
 *
 * The credentials below are AWS's published example values. They authorise
 * nothing and never have.
 */

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
};
const WHEN = new Date("2015-08-30T12:36:00Z");

test("sigv4: the date is rendered as AWS renders it", () => {
  assert.deepEqual(amzDate(WHEN), { long: "20150830T123600Z", short: "20150830" });
});

/**
 * One vector, end to end: canonical request, string to sign, signature.
 * `signRequest` is NOT used here — it adds `x-amz-content-sha256` because S3
 * requires it, and these vectors sign a generic service that does not. Going
 * through it would be checking a different request against AWS's answer.
 */
function vector(name: string, req: {
  method: string; path: string; query?: string; headers: Record<string, string>;
}, expected: { canonical?: string; signature: string }) {
  test(`sigv4: ${name}`, () => {
    const { text } = canonicalRequest({
      method: req.method,
      path: req.path,
      query: req.query ?? "",
      headers: req.headers,
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    if (expected.canonical) assert.equal(text, expected.canonical);
    assert.equal(
      signatureHex({ creds: CREDS, canonical: text, long: "20150830T123600Z", short: "20150830" }),
      expected.signature,
    );
  });
}

const HOST_DATE = { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" };

vector("get-vanilla", { method: "GET", path: "/", headers: HOST_DATE }, {
  canonical: [
    "GET", "/", "",
    "host:example.amazonaws.com", "x-amz-date:20150830T123600Z", "",
    "host;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n"),
  signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
});

vector("get-vanilla-query-order-key-case", {
  method: "GET", path: "/", query: "Param1=value1&Param2=value2", headers: HOST_DATE,
}, { signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500" });

vector("get-utf8", { method: "GET", path: "/%E1%88%B4", headers: HOST_DATE }, {
  signature: "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
});

vector("post-vanilla", { method: "POST", path: "/", headers: HOST_DATE }, {
  signature: "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
});

test("sigv4: the string to sign is the documented four lines", () => {
  const { text } = canonicalRequest({
    method: "GET", path: "/", query: "", headers: HOST_DATE,
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
  const scope = "20150830/us-east-1/service/aws4_request";
  assert.equal(stringToSign("20150830T123600Z", scope, text), [
    "AWS4-HMAC-SHA256",
    "20150830T123600Z",
    scope,
    "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
  ].join("\n"));
});

test("sigv4: a server-side request carries the payload hash S3 demands", () => {
  const body = new TextEncoder().encode("<Delete/>");
  const signed = signRequest({
    creds: { ...CREDS, service: "s3" }, method: "POST",
    url: "https://acct.r2.cloudflarestorage.com/b?delete=", body, now: WHEN,
  });
  assert.match(signed.headers["x-amz-content-sha256"]!, /^[0-9a-f]{64}$/);
  assert.match(signed.headers.authorization!, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.equal(signed.headers["x-amz-date"], "20150830T123600Z");
});

test("sigv4: the body is covered — a changed body is a changed signature", () => {
  const one = signRequest({
    creds: CREDS, method: "PUT", url: "https://h/b/k",
    body: new TextEncoder().encode("a"), now: WHEN,
  });
  const two = signRequest({
    creds: CREDS, method: "PUT", url: "https://h/b/k",
    body: new TextEncoder().encode("b"), now: WHEN,
  });
  assert.notEqual(one.headers.authorization, two.headers.authorization);
});

/* ------------------------------------------------------------- encoding */

test("encoding: RFC 3986, not encodeURIComponent", () => {
  // The five characters encodeURIComponent leaves alone and AWS does not.
  assert.equal(uriEncode("!'()*"), "%21%27%28%29%2A");
  assert.equal(uriEncode("a b"), "a%20b");
  assert.equal(uriEncode("a/b"), "a%2Fb");
  assert.equal(uriEncode("a/b", false), "a/b");
  assert.equal(uriEncode("-._~aZ9"), "-._~aZ9", "unreserved characters are never touched");
  assert.equal(uriEncode("é"), "%C3%A9", "UTF-8 bytes, not code points");
});

test("encoding: a key keeps its slashes and escapes everything else", () => {
  assert.equal(
    encodeKey("organizations/org-1/interviews/iv 2/recording (final).webm"),
    "organizations/org-1/interviews/iv%202/recording%20%28final%29.webm",
  );
});

/* ------------------------------------------------------------- presign */

test("presign: the URL carries the signature and covers method, key and expiry", () => {
  const url = presign({
    creds: CREDS, method: "PUT",
    url: "https://acct.r2.cloudflarestorage.com/bucket/organizations/o/key.webm",
    expiresIn: 900, now: WHEN,
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(u.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(u.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(u.searchParams.get("X-Amz-Credential"), "AKIDEXAMPLE/20150830/us-east-1/service/aws4_request");
  assert.match(u.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.equal(u.pathname, "/bucket/organizations/o/key.webm");
});

test("presign: one URL is one method on one key", () => {
  const base = { creds: CREDS, url: "https://h/b/k", expiresIn: 900, now: WHEN };
  const put = new URL(presign({ ...base, method: "PUT" })).searchParams.get("X-Amz-Signature");
  const get = new URL(presign({ ...base, method: "GET" })).searchParams.get("X-Amz-Signature");
  const other = new URL(presign({ ...base, method: "PUT", url: "https://h/b/k2" })).searchParams.get("X-Amz-Signature");
  assert.notEqual(put, get, "a PUT ticket must not also authorise a GET");
  assert.notEqual(put, other, "a ticket for one key must not authorise another");
});

test("presign: a part number and upload id are inside the signature", () => {
  const base = {
    creds: CREDS, method: "PUT", url: "https://h/b/k", expiresIn: 900, now: WHEN,
  };
  const p1 = new URL(presign({ ...base, query: { partNumber: "1", uploadId: "u" } }));
  const p2 = new URL(presign({ ...base, query: { partNumber: "2", uploadId: "u" } }));
  assert.notEqual(
    p1.searchParams.get("X-Amz-Signature"),
    p2.searchParams.get("X-Amz-Signature"),
    "a ticket for part 1 must not upload part 2",
  );
  // and the parameters survive into the URL the browser will use
  assert.equal(p2.searchParams.get("partNumber"), "2");
  assert.equal(p2.searchParams.get("uploadId"), "u");
});

test("presign: the expiry is part of the signature, so it cannot be edited", () => {
  const url = presign({
    creds: CREDS, method: "GET", url: "https://h/b/k", expiresIn: 60, now: WHEN,
  });
  const tampered = url.replace("X-Amz-Expires=60", "X-Amz-Expires=604800");
  const fresh = presign({
    creds: CREDS, method: "GET", url: "https://h/b/k", expiresIn: 604800, now: WHEN,
  });
  assert.notEqual(
    new URL(tampered).searchParams.get("X-Amz-Signature"),
    new URL(fresh).searchParams.get("X-Amz-Signature"),
    "editing the expiry must invalidate the signature",
  );
});
