import { createHash, createHmac } from "node:crypto";

/**
 * AWS SIGNATURE VERSION 4, BY HAND.
 *
 * ## Why not the SDK
 *
 * `@aws-sdk/client-s3` plus `@aws-sdk/s3-request-presigner` is roughly ten
 * megabytes of JavaScript and a measurable cold start, to do arithmetic that
 * fits on two screens. This repository has no HTTP client at all — every
 * provider call in `packages/ai` is bare `fetch` — and `packages/media` has
 * zero runtime dependencies on purpose. A signing routine is exactly the kind
 * of thing that should be small, read once, and never thought about again.
 *
 * It is also the kind of thing that is either right or catastrophically
 * wrong, with nothing in between — so the tests run AWS's own published test
 * vectors, which is the only reason writing this is defensible.
 *
 * ## The two shapes
 *
 * `signRequest` puts the signature in the `Authorization` header: for calls
 * OUR server makes, where we can set headers.
 *
 * `presign` puts it in the query string: for URLs we hand to a BROWSER, which
 * cannot be trusted to set headers and, for a cross-origin PUT, would trip
 * CORS preflight on every one it did set. A presigned URL carries its own
 * authority and needs nothing but the bytes.
 *
 * ## The one thing that always goes wrong
 *
 * Canonicalisation. The signature covers a normalised rendering of the
 * request, and a single disagreement about encoding — a `+` in a key, a `/`
 * that should not have been escaped, a query parameter out of sort order —
 * produces `SignatureDoesNotMatch` with no indication of which. So:
 *
 *  · `uriEncode` is RFC 3986, not `encodeURIComponent`, which leaves `!'()*`
 *    alone and would break any key containing them;
 *  · the object key is encoded per SEGMENT, so `/` survives as a separator;
 *  · query parameters are sorted by encoded name, then encoded value;
 *  · headers are lower-cased, whitespace-collapsed, and sorted.
 *
 * R2 note: Cloudflare R2 ignores the region but requires one to be present
 * and to match the signature. `auto` is the documented value.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 uses "auto"; S3 uses a real region. Either way it is signed. */
  region: string;
  service?: string;
  /** Only for temporary credentials (STS). */
  sessionToken?: string;
}

const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/**
 * RFC 3986 percent-encoding — NOT `encodeURIComponent`.
 *
 * `encodeURIComponent` leaves `! ' ( ) *` unescaped, and AWS escapes them. A
 * key containing an apostrophe would sign one way and be sent another.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const ch of Buffer.from(value, "utf8")) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === "/") out += encodeSlash ? "%2F" : "/";
    else out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** An object key as a canonical path: encoded per segment, slashes intact. */
export function encodeKey(key: string): string {
  return key.split("/").map((s) => uriEncode(s, true)).join("/");
}

/** `20260916T084912Z` and `20260916`. */
export function amzDate(now: Date): { long: string; short: string } {
  const long = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { long, short: long.slice(0, 8) };
}

function canonicalQuery(params: Iterable<[string, string]>): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of params) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(""),
    signed: entries.map(([k]) => k).join(";"),
  };
}

/**
 * The hex signature itself, given a canonical request.
 *
 * Exported because it is the last step of the algorithm and the only way to
 * check the published AWS vectors end to end: those vectors sign a generic
 * service with no `x-amz-content-sha256`, while `signRequest` below always
 * adds one because S3 requires it. Testing the vectors THROUGH `signRequest`
 * would therefore be testing a different request, and papering over that by
 * loosening the assertion is how a signer ends up unverified.
 */
export function signatureHex(args: {
  creds: SigningCredentials;
  canonical: string;
  long: string;
  short: string;
}): string {
  const service = args.creds.service ?? "s3";
  const scope = `${args.short}/${args.creds.region}/${service}/aws4_request`;
  return hmac(
    signingKey(args.creds.secretAccessKey, args.short, args.creds.region, service),
    stringToSign(args.long, scope, args.canonical),
  ).toString("hex");
}

function signingKey(secret: string, short: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, short);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface CanonicalParts {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  payloadHash: string;
}

/** Exported for the test vectors — the string AWS actually hashes. */
export function canonicalRequest(p: CanonicalParts): { text: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(p.headers);
  return {
    text: [p.method.toUpperCase(), p.path, p.query, canonical, signed, p.payloadHash].join("\n"),
    signedHeaders: signed,
  };
}

/** Exported for the test vectors — what the signing key is applied to. */
export function stringToSign(long: string, scope: string, canonical: string): string {
  return [ALGORITHM, long, scope, sha256Hex(canonical)].join("\n");
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Sign a request our own server will make. The signature goes in
 * `Authorization` and the payload is hashed, so the store verifies the body
 * as well as the envelope.
 */
export function signRequest(args: {
  creds: SigningCredentials;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  now?: Date;
}): SignedRequest {
  const { creds } = args;
  const service = creds.service ?? "s3";
  const now = args.now ?? new Date();
  const { long, short } = amzDate(now);
  const url = new URL(args.url);

  const payloadHash = sha256Hex(args.body ?? new Uint8Array());
  const headers: Record<string, string> = {
    ...(args.headers ?? {}),
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": long,
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const { text, signedHeaders } = canonicalRequest({
    method: args.method,
    path: encodeKey(decodeURIComponent(url.pathname)),
    query: canonicalQuery(url.searchParams),
    headers,
    payloadHash,
  });
  const scope = `${short}/${creds.region}/${service}/aws4_request`;
  const signature = hmac(
    signingKey(creds.secretAccessKey, short, creds.region, service),
    stringToSign(long, scope, text),
  ).toString("hex");

  headers.authorization =
    `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: url.toString(), headers };
}

/**
 * Presign a URL for a browser.
 *
 * The payload is `UNSIGNED-PAYLOAD` because the browser holds the bytes and
 * we do not — signing a hash we cannot compute is not an option. The key, the
 * method, the expiry and any signed headers are all still covered, which is
 * what confines the URL to one operation on one object.
 *
 * `signedHeaders` should stay as close to `{host}` as possible: every header
 * named here is a header the browser MUST send byte-identically, and each one
 * is a way for a cross-origin upload to fail with a signature error that
 * looks like a permissions error.
 */
export function presign(args: {
  creds: SigningCredentials;
  method: string;
  url: string;
  expiresIn: number;
  signedHeaders?: Record<string, string>;
  query?: Record<string, string>;
  now?: Date;
}): string {
  const { creds } = args;
  const service = creds.service ?? "s3";
  const now = args.now ?? new Date();
  const { long, short } = amzDate(now);
  const url = new URL(args.url);
  const scope = `${short}/${creds.region}/${service}/aws4_request`;

  const headers: Record<string, string> = { ...(args.signedHeaders ?? {}), host: url.host };
  const { canonical, signed } = canonicalHeaders(headers);

  const params = new URLSearchParams(url.searchParams);
  for (const [k, v] of Object.entries(args.query ?? {})) params.set(k, v);
  params.set("X-Amz-Algorithm", ALGORITHM);
  params.set("X-Amz-Credential", `${creds.accessKeyId}/${scope}`);
  params.set("X-Amz-Date", long);
  params.set("X-Amz-Expires", String(Math.max(1, Math.floor(args.expiresIn))));
  params.set("X-Amz-SignedHeaders", signed);
  if (creds.sessionToken) params.set("X-Amz-Security-Token", creds.sessionToken);

  const query = canonicalQuery(params);
  const text = [
    args.method.toUpperCase(),
    encodeKey(decodeURIComponent(url.pathname)),
    query,
    canonical,
    signed,
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const signature = hmac(
    signingKey(creds.secretAccessKey, short, creds.region, service),
    stringToSign(long, scope, text),
  ).toString("hex");

  return `${url.origin}${encodeKey(decodeURIComponent(url.pathname))}?${query}&X-Amz-Signature=${signature}`;
}
