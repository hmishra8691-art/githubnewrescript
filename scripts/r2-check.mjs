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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* --------------------------------------------------- the package it needs */

/**
 * BUILD `@rescript/storage` IF IT IS NOT BUILT.
 *
 * `dist/` is gitignored, so a fresh clone has none — and the first thing
 * somebody setting up R2 does is clone and run this. `ERR_MODULE_NOT_FOUND`
 * on a path they have never heard of is a bad first impression of a script
 * whose whole job is to make a confusing thing clear.
 *
 * It deliberately imports the REAL provider rather than reimplementing a few
 * S3 calls inline. A verifier that does not use the code under test proves
 * nothing about the code under test — it would pass happily while the
 * application failed.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = new URL("../packages/storage/dist/index.js", import.meta.url);

function build() {
  const hasModules = existsSync(new URL("../node_modules", import.meta.url));
  const steps = hasModules ? [] : [["pnpm", ["install"]]];
  steps.push(["pnpm", ["--filter", "@rescript/storage", "build"]]);
  for (const [cmd, args] of steps) {
    process.stdout.write(`  ${cmd} ${args.join(" ")} … `);
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0) {
      console.log("failed");
      const detail = String(r.stderr ?? r.error?.message ?? "").trim().split("\n").slice(-4).join("\n");
      if (detail) console.log(`\n${detail}\n`);
      return false;
    }
    console.log("done");
  }
  return existsSync(DIST);
}

if (!existsSync(DIST)) {
  console.log("\nThe storage package is not built yet — doing that first (once).\n");
  if (!build()) {
    console.error("\nCould not build it. Run these from the repository root, then try again:\n");
    console.error("  pnpm install");
    console.error("  pnpm --filter @rescript/storage build\n");
    console.error("If `pnpm` is not installed:  npm install -g pnpm\n");
    process.exit(2);
  }
  console.log("");
}

const { R2StorageProvider, planUpload } = await import(DIST.href);

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

/**
 * EVERY ORIGIN THAT WILL UPLOAD TO THIS BUCKET, NOT JUST ONE.
 *
 * A CORS policy is a property of the bucket, and more than one application
 * writes to it: the interviews app records candidates, and the Studio uploads
 * question videos and library assets from a DIFFERENT Vercel project on a
 * different hostname. A policy listing only the first is a bucket the second
 * cannot upload to at all — and the browser-side failure that produces is
 * indistinguishable, from the researcher's side, from a permissions error.
 *
 * So the check takes as many origins as you give it and holds the bucket to
 * all of them:
 *
 *   node scripts/r2-check.mjs https://rescriptstudio.vercel.app https://rescript-interviews.vercel.app
 */
const ORIGINS = [
  ...process.argv.slice(2),
  env.STUDIO_PUBLIC_URL ?? "",
  env.NEXT_PUBLIC_STUDIO_URL ?? "",
  env.INTERVIEWS_PUBLIC_URL ?? "",
]
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean)
  .filter((o, i, all) => all.indexOf(o) === i);
const ORIGIN = ORIGINS[0] ?? "";

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
console.log(`  origins    ${ORIGINS.join("\n             ") || "(none given — CORS checks will be skipped)"}`);
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

/*
 * THE STUDIO'S OWN KEY LAYOUT.
 *
 * The interviews app writes under `organizations/<id>/interviews/…`. The
 * Studio does not: `packages/media` keeps four LOGICAL buckets —
 * `rescript-video`, `rescript-audio`, `rescript-assets`, `rescript-uploads` —
 * and folds each into a key prefix inside the one real bucket
 * (`providerKey` in `objectStore.ts`). So a Studio question video lands at
 * `video/<survey>/<question>/<ts>-question.webm` and a library asset at
 * `assets/<survey>/…`.
 *
 * Those prefixes were never exercised here, and a check that passes on one
 * prefix while the product writes to another is a check that proves the
 * wrong thing. It also matters for lifecycle rules, which are written per
 * prefix and can silently delete one family and not another.
 */
const STUDIO_PREFIXES = ["video", "audio", "assets", "uploads"];

await step("the Studio's four key prefixes accept a write", async () => {
  const written = [];
  for (const prefix of STUDIO_PREFIXES) {
    const key = `${prefix}/_rescript-check/${stamp}/probe.bin`;
    await storage.upload(key, bytes(64, 5), { contentType: "application/octet-stream" });
    cleanup.push(key);
    const meta = await storage.getMetadata(key);
    if (!meta) throw fail(`wrote ${key} and could not read it back`,
      `The Studio stores its ${prefix} under this prefix. A token or lifecycle rule that treats prefixes differently would fail exactly here.`);
    written.push(prefix);
  }
  return `${written.join(", ")}`;
});

await step("a presigned PUT with the recorder's real content type", async () => {
  /*
   * What the Studio's video recorder actually sends: a Blob whose type is
   * `video/webm;codecs=vp9,opus`, PUT straight at a presigned URL with no
   * Authorization header. The semicolon and the comma in that value are the
   * two characters most likely to be canonicalised differently by a signer
   * and a store — and `createSignedUploadUrl` deliberately leaves
   * content-type OUT of the signature for that reason, which is a decision
   * worth proving rather than trusting.
   */
  const key = `video/_rescript-check/${stamp}/as-the-browser-sends-it.webm`;
  const url = await storage.createSignedUploadUrl(key, { expiresIn: 600 });
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "video/webm;codecs=vp9,opus" },
    body: bytes(2048, 9),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw fail(`the store refused the presigned PUT (${res.status}) ${body.slice(0, 200)}`,
      res.status === 403
        ? "This is the failure the Studio is hitting. A 403 here is the token, the bucket name or the account id — not CORS, because this request is not coming from a browser."
        : undefined);
  }
  cleanup.push(key);
  const meta = await storage.getMetadata(key);
  if (!meta || meta.size !== 2048) throw fail(`the object is ${meta ? `${meta.size} bytes` : "absent"} after a 200`);
  return "2048 bytes, verified";
});

for (const origin of ORIGINS.length ? ORIGINS : [""]) {
  await step(`CORS preflight from ${origin || "(no origin given)"}`, async () => {
    if (!origin) {
      skipped++;
      throw fail("skipped — no origin given",
        "Pass every app URL that uploads to this bucket: node scripts/r2-check.mjs https://your-studio.vercel.app https://your-interviews.vercel.app");
    }
    const res = await fetch(uploadUrl, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type",
      },
    });
    const allow = res.headers.get("access-control-allow-origin");
    if (!allow) {
      throw fail(`the bucket returned no Access-Control-Allow-Origin (HTTP ${res.status})`,
        `Add a CORS policy to the bucket allowing ${origin}. Without it a browser on that origin cannot upload at all — and the request never reaches R2, so nothing is logged anywhere.`);
    }
    if (allow !== "*" && allow !== origin) {
      throw fail(`the bucket allows "${allow}", not "${origin}"`,
        "A CORS policy is per bucket and lists origins exactly. Two applications sharing a bucket need both of their URLs in AllowedOrigins.");
    }
    const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    if (!expose.includes("etag")) {
      throw fail(`ExposeHeaders does not include ETag (it has: "${expose || "nothing"}")`,
        "A browser cannot read the part ETag without this, so multipart uploads complete with no parts. Short answers would work and long ones would not.");
    }
    return "origin allowed, ETag exposed";
  });
}

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
  /*
   * Every prefix this run wrote to, not just the first. The Studio-layout
   * steps above put probes under `video/`, `audio/`, `assets/` and
   * `uploads/`, and a cleanup that only looked at the root prefix would
   * report "bucket is clean" while leaving four objects behind — in a
   * verifier whose whole job is to not be taken on trust.
   */
  const roots = ["", ...STUDIO_PREFIXES.map((p) => `${p}/`)];
  let left = 0;
  for (const root of roots) {
    const still = await storage.list(`${root}_rescript-check/${stamp}/`, { limit: 10 });
    left += still.objects.length;
  }
  if (left) throw fail(`${left} object(s) survived the delete`);
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
console.log(`  Anything left behind is under _rescript-check/${stamp}/ — at the root and`);
console.log(`  under ${STUDIO_PREFIXES.join("/, ")}/ — and is safe to delete from the dashboard.\n`);
process.exit(1);
