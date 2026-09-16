#!/usr/bin/env node
/**
 * DOES THIS R2 CONFIGURATION ACTUALLY WORK?
 *
 *   node scripts/r2-check.mjs
 *
 * Reads the same environment variables the application reads, and does the
 * same things to the same bucket — a real signed PUT, a real HEAD, a real
 * presigned GET fetched over the network, a real multipart upload assembled
 * from two parts, a real prefix listing, a real delete, and a CORS preflight
 * shaped exactly like the one a candidate's browser sends.
 *
 * ## Why this exists rather than "try it and see"
 *
 * Every one of these can fail on its own, and the error S3 returns for most
 * of them is `AccessDenied` or `SignatureDoesNotMatch` — which are the same
 * two words for a wrong key, an expired clock, a token scoped to the wrong
 * bucket, a missing permission, and a bucket that is not there. Finding out
 * which, in production, from a candidate who could not upload, is an
 * afternoon. Finding out here is ninety seconds.
 *
 * The CORS check is the one people skip and the one that bites. A browser
 * cannot read the `ETag` header unless the bucket exposes it, and without
 * the ETag a multipart upload cannot be completed — so an interview works
 * perfectly for short answers and fails for long ones, which is the worst
 * kind of bug to discover late.
 *
 * ## Secrets
 *
 * Nothing here prints a secret. The access key id is shown masked so you can
 * tell WHICH credential is in use; the secret is never read into a string
 * that reaches the output at all.
 */

import { readFileSync, existsSync } from "node:fs";
import { R2StorageProvider, planUpload } from "../packages/storage/dist/index.js";

/* ------------------------------------------------------------------ setup */

/**
 * Read `.env.r2` if it is there, without overriding anything already set.
 *
 * Exporting four variables by hand is four chances for a paste to wrap and
 * for a shell to answer `export: not an identifier:` — which says nothing
 * about which line was wrong. A file has no quoting rules to get wrong, and
 * it keeps a 64-character secret out of your shell history, where it would
 * otherwise sit in plain text for as long as the history file lives.
 *
 * `export` prefixes, `quotes`, blank lines and # comments are all tolerated,
 * because every one of them appears in a file somebody has pasted into.
 */
function loadEnvFile(path) {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    /* a value already in the environment wins, so one-off overrides still work */
    if (process.env[m[1]] === undefined) { process.env[m[1]] = value; n++; }
  }
  return n;
}

const ENV_FILE = process.env.R2_ENV_FILE ?? new URL("../.env.r2", import.meta.url).pathname;
const loaded = loadEnvFile(ENV_FILE);

const env = process.env;
const ORIGIN = env.INTERVIEWS_PUBLIC_URL ?? process.argv[2] ?? "";

const endpoint = env.R2_ENDPOINT
  ?? (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
const bucket = env.R2_BUCKET ?? "";
const accessKeyId = env.R2_ACCESS_KEY_ID ?? "";
const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
const region = env.R2_REGION || "auto";

const missing = [];
if (!endpoint) missing.push("R2_ACCOUNT_ID (or R2_ENDPOINT)");
if (!bucket) missing.push("R2_BUCKET");
if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
if (missing.length) {
  console.error(`\nNot configured. Missing: ${missing.join(", ")}\n`);
  console.error("Easiest: put them in a file called .env.r2 at the top of the repo,");
  console.error("one per line, then run this again. No quoting, no shell history.\n");
  console.error("  R2_ACCOUNT_ID=your-32-character-account-id");
  console.error("  R2_BUCKET=rescript-interviews-dev");
  console.error("  R2_ACCESS_KEY_ID=your-access-key-id");
  console.error("  R2_SECRET_ACCESS_KEY=your-secret-access-key\n");
  console.error("Then:  node scripts/r2-check.mjs http://localhost:3002\n");
  console.error(`(Looked for: ${ENV_FILE})\n`);
  process.exit(2);
}

const mask = (s) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`);

console.log(`\nR2 CHECK`);
console.log(`  endpoint   ${endpoint}`);
console.log(`  bucket     ${bucket}`);
console.log(`  region     ${region}`);
console.log(`  key id     ${mask(accessKeyId)}`);
console.log(`  origin     ${ORIGIN || "(none given — CORS check will be skipped)"}`);
if (loaded) console.log(`  read ${loaded} setting(s) from ${ENV_FILE}`);
console.log("");

const storage = new R2StorageProvider({
  endpoint, bucket, accessKeyId, secretAccessKey, region,
});

/* A key under a prefix nothing else uses, so a failed run leaves no litter
   anywhere near real recordings. */
const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const KEY = `_rescript-check/${stamp}/probe.bin`;
const BIG = `_rescript-check/${stamp}/multipart.bin`;

let failed = 0;
let skipped = 0;
const cleanup = [];

async function step(name, fn) {
  process.stdout.write(`  ${name.padEnd(46, " ")}`);
  try {
    const note = await fn();
    console.log(`ok${note ? `   ${note}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL`);
    console.log(`      ${String(e?.message ?? e).slice(0, 400)}`);
    if (e?.hint) console.log(`      → ${e.hint}`);
  }
}

const fail = (message, hint) => {
  const e = new Error(message);
  e.hint = hint;
  return e;
};

/* ------------------------------------------------------------- the checks */

const bytes = (n, fill) => new Uint8Array(n).fill(fill);

await step("credentials reach the bucket", async () => {
  /* a listing of a prefix that does not exist: the cheapest authenticated
     call there is, and it distinguishes every interesting failure */
  try {
    await storage.list("_rescript-check/does-not-exist/", { limit: 1 });
  } catch (e) {
    const m = String(e.message);
    if (/NoSuchBucket/i.test(m)) {
      throw fail(m, `The bucket "${bucket}" does not exist in this account. Check the name, exactly.`);
    }
    if (/AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(m)) {
      throw fail(m, "The token is wrong, or is not scoped to this bucket. In Cloudflare, an R2 API token must list the bucket explicitly (or be account-wide) and have Object Read & Write.");
    }
    throw e;
  }
  return "authenticated";
});

await step("upload an object", async () => {
  const meta = await storage.upload(KEY, bytes(1024, 7), { contentType: "application/octet-stream" });
  cleanup.push(KEY);
  if (meta.size !== 1024) throw fail(`the store recorded ${meta.size} bytes, not 1024`);
  return `${meta.size} bytes`;
});

await step("read it back with HEAD", async () => {
  const meta = await storage.getMetadata(KEY);
  if (!meta) throw fail("HEAD found nothing where an object was just written", "Object Read permission is missing from the token.");
  if (meta.size !== 1024) throw fail(`HEAD says ${meta.size} bytes`);
  return `etag ${String(meta.etag).slice(0, 10)}…`;
});

let downloadUrl = "";
await step("presign a download URL", async () => {
  downloadUrl = await storage.createSignedDownloadUrl(KEY, { expiresIn: 300 });
  if (!downloadUrl.includes("X-Amz-Signature")) throw fail("the URL carries no signature");
  return "5 minutes";
});

await step("fetch that URL over the network", async () => {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw fail(`the signed URL answered ${res.status}`,
      "The signature is right but the object was refused — usually a clock more than 15 minutes out on this machine.");
  }
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.length !== 1024 || body[0] !== 7) throw fail("the bytes that came back are not the bytes that went up");
  return "bytes match";
});

let uploadUrl = "";
await step("presign an upload URL and PUT to it", async () => {
  const key = `${KEY}.put`;
  uploadUrl = await storage.createSignedUploadUrl(key, { expiresIn: 300 });
  const res = await fetch(uploadUrl, { method: "PUT", body: bytes(2048, 3) });
  if (!res.ok) throw fail(`the signed PUT answered ${res.status}`, "Object Write permission is missing from the token.");
  cleanup.push(key);
  const meta = await storage.getMetadata(key);
  if (!meta || meta.size !== 2048) throw fail("the object is not there after a 200 from the PUT");
  return "2048 bytes, verified";
});

await step("multipart: create, two parts, complete", async () => {
  /* 5 MiB + a short tail — the smallest legal multipart, and the shape every
     real interview answer takes */
  const plan = planUpload(6 * 1024 * 1024, 5 * 1024 * 1024);
  if (plan.kind !== "multipart") throw fail("the planner did not choose multipart for 6 MiB");

  const mp = await storage.createMultipartUpload(BIG, { contentType: "video/webm" });
  const parts = [];
  for (let n = 1; n <= plan.partCount; n++) {
    const start = (n - 1) * plan.partBytes;
    const size = Math.min(plan.totalBytes, start + plan.partBytes) - start;
    const url = await storage.signUploadPart(BIG, mp.uploadId, n, { expiresIn: 600 });
    const res = await fetch(url, { method: "PUT", body: bytes(size, n) });
    if (!res.ok) throw fail(`part ${n} answered ${res.status}`);
    const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
    if (!etag) {
      throw fail(`part ${n} returned no ETag header`,
        "Without an ETag a multipart upload cannot be completed. This is normally a CORS ExposeHeaders problem in a browser; from Node it means something stripped the header.");
    }
    parts.push({ partNumber: n, etag });
  }

  const listed = await storage.listUploadedParts(BIG, mp.uploadId);
  if (listed.length !== parts.length) {
    throw fail(`the store lists ${listed.length} parts, we sent ${parts.length}`,
      "This is the check that catches a part which returned 200 and was not kept.");
  }

  const meta = await storage.completeMultipartUpload(BIG, mp.uploadId, parts);
  cleanup.push(BIG);
  if (meta.size !== plan.totalBytes) {
    throw fail(`assembled ${meta.size} bytes, expected ${plan.totalBytes}`,
      "A short assembly is a truncated recording that plays perfectly well. This must never pass.");
  }
  return `${parts.length} parts, ${(meta.size / 1024 / 1024).toFixed(0)} MiB assembled`;
});

await step("multipart: abandon one cleanly", async () => {
  const key = `_rescript-check/${stamp}/abandoned.bin`;
  const mp = await storage.createMultipartUpload(key);
  const url = await storage.signUploadPart(key, mp.uploadId, 1, { expiresIn: 300 });
  await fetch(url, { method: "PUT", body: bytes(5 * 1024 * 1024, 1) });
  await storage.abortMultipartUpload(key, mp.uploadId);
  const left = await storage.listUploadedParts(key, mp.uploadId);
  if (left.length) throw fail(`${left.length} part(s) survived the abort — you will be billed for them`);
  return "parts released";
});

await step("list objects under a prefix", async () => {
  const out = await storage.list(`_rescript-check/${stamp}/`, { limit: 100 });
  if (out.objects.length < 3) throw fail(`only ${out.objects.length} objects listed, expected at least 3`);
  return `${out.objects.length} objects`;
});

await step("CORS preflight, as a browser sends it", async () => {
  if (!ORIGIN) { skipped++; throw fail("skipped — no origin given", "Pass your app's URL: node scripts/r2-check.mjs https://your-app.vercel.app"); }
  const res = await fetch(uploadUrl, {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type",
    },
  });
  const allow = res.headers.get("access-control-allow-origin");
  if (!allow) {
    throw fail(`the bucket returned no Access-Control-Allow-Origin (HTTP ${res.status})`,
      `Add a CORS policy to the bucket allowing ${ORIGIN}. Without it a candidate's browser cannot upload at all.`);
  }
  if (allow !== "*" && allow !== ORIGIN) {
    throw fail(`the bucket allows "${allow}", not "${ORIGIN}"`);
  }
  const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  if (!expose.includes("etag")) {
    throw fail(`ExposeHeaders does not include ETag (it has: "${expose || "nothing"}")`,
      "A browser cannot read the part ETag without this, so multipart uploads complete with no parts. Short answers would work and long ones would not.");
  }
  return "origin allowed, ETag exposed";
});

await step("public access is OFF", async () => {
  /* the same key, unsigned. It must be refused. */
  const bare = `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}/${KEY.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(bare).catch(() => null);
  if (res && res.ok) {
    throw fail("an UNSIGNED request read the object",
      "This bucket is publicly readable. Every candidate recording in it is one guessed URL away from anybody. Turn public access off in the bucket's settings.");
  }
  return `unsigned request refused (${res ? res.status : "no response"})`;
});

await step("delete everything this check created", async () => {
  await storage.delete(cleanup);
  const still = await storage.list(`_rescript-check/${stamp}/`, { limit: 10 });
  if (still.objects.length) throw fail(`${still.objects.length} object(s) survived the delete`);
  return "bucket is clean";
});

/* ------------------------------------------------------------------ report */

console.log("");
if (failed === 0) {
  console.log(`  This bucket is ready. Every operation the product performs works.\n`);
  process.exit(0);
}
if (failed === skipped) {
  console.log(`  Everything that ran passed; ${skipped} check was skipped.\n`);
  process.exit(0);
}
console.log(`  ${failed} check(s) failed. The product will not work until they pass.\n`);
console.log(`  Anything left behind is under the prefix _rescript-check/${stamp}/ and`);
console.log(`  is safe to delete from the Cloudflare dashboard.\n`);
process.exit(1);
