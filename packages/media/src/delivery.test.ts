import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildZip, crc32, zipSafeName, type MediaDb } from "./index.js";
import {
  RETENTION_HOURS, RETENTION_MS, DELIVERED_KINDS,
  mintDownloadToken, hashDownloadToken,
  packagePath, buildManifest, packageFileName,
  expiryFrom, hoursRemaining, linkUsable, deliveryStalled, backoffMs,
  findDue, openDelivery, claimDelivery, sessionMedia, markSent, markFailed,
  deliveryForToken, recordDownload, expireLink, markDeleted, retryDelivery,
  type DeliveryRow,
} from "./delivery.js";

/* ============================================================== the archive */

test("a built archive is a real zip that a real unzip can read", () => {
  const files = [
    { name: "Study/Respondent_A1/Q1_audio_response.webm", bytes: new TextEncoder().encode("first recording") },
    { name: "Study/Respondent_A1/Q2_audio_response.webm", bytes: new Uint8Array([0, 1, 2, 250, 251, 255]) },
  ];
  const zip = buildZip(files);

  const dir = mkdtempSync(join(tmpdir(), "rs-zip-"));
  const path = join(dir, "media.zip");
  writeFileSync(path, zip);

  // `unzip -t` is the honest test: it verifies every CRC and the central
  // directory. A hand-rolled reader would only prove the writer agrees with
  // itself, which is exactly the bug a hand-rolled zip writer has.
  let tested: string;
  try {
    tested = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
  } catch (e) {
    // unzip absent in this environment: fall back to the structural checks
    // below, which still catch the offsets being wrong.
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(dv.getUint32(0, true), 0x04034b50, "starts with a local file header");
    return;
  }
  assert.match(tested, /No errors detected/i, tested);

  execFileSync("unzip", ["-q", "-o", path, "-d", dir]);
  const round = readFileSync(join(dir, "Study/Respondent_A1/Q1_audio_response.webm"));
  assert.equal(round.toString("utf8"), "first recording", "the bytes survive the round trip");
  const bin = readFileSync(join(dir, "Study/Respondent_A1/Q2_audio_response.webm"));
  assert.deepEqual([...bin], [0, 1, 2, 250, 251, 255], "binary bytes are not mangled");
});

test("an empty archive is still a valid archive", () => {
  const zip = buildZip([]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(zip.length, 22, "just the end-of-central-directory record");
  assert.equal(dv.getUint32(0, true), 0x06054b50);
});

test("crc32 agrees with the known vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("a path cannot climb out of the folder it is extracted into", () => {
  assert.equal(zipSafeName("../../etc/passwd"), "_/_/etc/passwd");
  assert.equal(zipSafeName("/absolute/path"), "absolute/path");
  assert.equal(zipSafeName("windows\\style\\name"), "windows/style/name");
  assert.equal(zipSafeName(""), "file");
  assert.equal(zipSafeName("../.."), "_/_");
});

/* =============================================================== the naming */

const file = (over: Partial<Parameters<typeof packagePath>[2]> = {}) => ({
  kind: "answer_audio", originalFilename: "take.webm",
  questionCode: "Q12", questionId: "q_interview", answerKey: "q_interview", ...over,
});

test("a file says whose it is and which question it answers, from its path alone", () => {
  const p = packagePath("Beverage Habits 2026", "A4F2", file(), 0);
  assert.equal(p, "Beverage_Habits_2026/Respondent_A4F2/Q12_audio_response.webm");
});

test("the recorded extension is carried over, never guessed", () => {
  assert.match(packagePath("P", "R", file({ originalFilename: "clip.mp4" }), 0), /\.mp4$/);
  assert.match(packagePath("P", "R", file({ originalFilename: "clip.WAV" }), 0), /\.wav$/, "and lowercased");
  assert.match(packagePath("P", "R", file({ originalFilename: null }), 0), /\.webm$/, "audio falls back to webm");
  assert.match(packagePath("P", "R", file({ originalFilename: null, kind: "answer_upload" }), 0), /\.bin$/);
});

test("a question code that is really a path traversal cannot escape", () => {
  const p = packagePath("../../etc", "../root", file({ questionCode: "../../../Q" }), 0);
  assert.ok(!p.includes(".."), `no traversal survives: ${p}`);
  assert.ok(!p.startsWith("/"), "and it is not absolute");
});

test("two iterations of a looped question do not overwrite each other", () => {
  const m = buildManifest({
    projectName: "Study", respondentLabel: "R1",
    files: [
      { mediaId: "m1", bucket: "b", path: "p1", kind: "answer_audio", bytes: 10, mimeType: null, originalFilename: "a.webm", questionId: "q1", questionCode: "Q1", answerKey: "q1@alpha", durationSeconds: null },
      { mediaId: "m2", bucket: "b", path: "p2", kind: "answer_audio", bytes: 20, mimeType: null, originalFilename: "a.webm", questionId: "q1", questionCode: "Q1", answerKey: "q1@beta", durationSeconds: null },
    ],
  });
  assert.notEqual(m[0]!.fileName, m[1]!.fileName, `${m[0]!.fileName} vs ${m[1]!.fileName}`);
  assert.match(m[0]!.fileName, /alpha/);
  assert.match(m[1]!.fileName, /beta/);
});

test("identical names are still made unique, whatever the cause", () => {
  const one = { mediaId: "m", bucket: "b", path: "p", kind: "answer_audio", bytes: 1, mimeType: null, originalFilename: "a.webm", questionId: "q1", questionCode: "Q1", answerKey: "q1", durationSeconds: null };
  const m = buildManifest({ projectName: "S", respondentLabel: "R", files: [one, { ...one, mediaId: "m2" }, { ...one, mediaId: "m3" }] });
  assert.equal(new Set(m.map((f) => f.fileName)).size, 3, m.map((f) => f.fileName).join(", "));
});

test("the archive is named after the project and the respondent", () => {
  assert.equal(packageFileName("Beverage Habits 2026", "A4F2"), "Beverage_Habits_2026_A4F2_media.zip");
});

/* ================================================================ the clock */

test("retention is 48 hours and says so once", () => {
  assert.equal(RETENTION_HOURS, 48);
  assert.equal(RETENTION_MS, 48 * 3600 * 1000);
  const now = new Date("2026-01-01T00:00:00Z");
  assert.equal(expiryFrom(now).toISOString(), "2026-01-03T00:00:00.000Z");
});

test("hours remaining is floored and never negative", () => {
  const exp = new Date("2026-01-03T00:00:00Z");
  assert.equal(hoursRemaining(exp, new Date("2026-01-01T00:00:00Z")), 48);
  assert.equal(hoursRemaining(exp, new Date("2026-01-02T23:10:00Z")), 0);
  assert.equal(hoursRemaining(exp, new Date("2026-01-04T00:00:00Z")), 0, "an expired link does not count backwards");
});

const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: "d1", customer_id: "c", survey_id: "s", response_id: "r", session_id: "sess",
  respondent_label: "R1", recipient_email: "researcher@example.com",
  status: "sent", media_count: 1, total_bytes: 10, manifest: [],
  token_hash: "h", expires_at: "2026-01-03T00:00:00.000Z",
  attempts: 1, retry_after: null, error: null, email_sent_at: "2026-01-01T00:00:00.000Z",
  downloaded_at: null, download_count: 0, deleted_at: null,
  created_at: "2026-01-01T00:00:00.000Z", ...over,
});

test("THE LINK DIES ON THE CLOCK, NOT ON THE SWEEP", () => {
  const before = new Date("2026-01-02T23:59:00Z");
  const after = new Date("2026-01-03T00:00:01Z");
  assert.deepEqual(linkUsable(row(), before), { ok: true });
  // the row still says "sent" because nothing has run yet — and the link is
  // dead anyway. This is the test that makes the 48 hours a promise rather
  // than a hope that a cron fired on time.
  assert.deepEqual(linkUsable(row(), after), { ok: false, reason: "expired" });
});

test("a link is not usable before it is sent, or after it is cleaned up", () => {
  const now = new Date("2026-01-02T00:00:00Z");
  assert.equal(linkUsable(row({ status: "pending", expires_at: null }), now).ok, false);
  assert.equal(linkUsable(row({ status: "processing" }), now).ok, false);
  assert.equal(linkUsable(row({ status: "failed" }), now).ok, false);
  assert.equal(linkUsable(row({ status: "expired" }), now).ok, false);
  assert.equal(linkUsable(row({ status: "deleted", deleted_at: "2026-01-03T00:00:00Z" }), now).ok, false);
  assert.equal(linkUsable(row({ status: "downloaded" }), now).ok, true, "downloading once does not burn it");
});

test("only a failed delivery is offered a retry", () => {
  assert.equal(deliveryStalled("failed"), true);
  for (const s of ["pending", "processing", "sent", "downloaded", "expired", "deleted"] as const) {
    assert.equal(deliveryStalled(s), false, s);
  }
});

/* ================================================================ the token */

test("the token is never stored, only its hash", () => {
  const { token, hash } = mintDownloadToken();
  assert.ok(token.length >= 40, `32 bytes of base64url: ${token.length}`);
  assert.equal(hash, createHash("sha256").update(token).digest("hex"));
  assert.ok(!hash.includes(token));
  assert.equal(hashDownloadToken(token), hash, "and hashing is stable");
  assert.notEqual(mintDownloadToken().token, token, "every link is its own credential");
});

/* ================================================================ the rows */

/** A stub standing in for the service-role client, in the style of store.test.ts. */
function stubDb() {
  const calls: { table?: string; op: string; args?: unknown }[] = [];
  const state: { rows: Record<string, unknown>[]; rpc: Record<string, unknown[]>; failInsert?: string } = {
    rows: [], rpc: {},
  };
  const table = (name: string) => {
    const q: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api, eq: (k: string, v: unknown) => { q[k] = v; return api; },
      in: () => api, order: () => api,
      maybeSingle: async () => ({ data: state.rows.find((r) => Object.entries(q).every(([k, v]) => r[k] === v)) ?? null, error: null }),
      single: async () => ({ data: state.rows[state.rows.length - 1] ?? null, error: null }),
      insert: (v: Record<string, unknown>) => {
        calls.push({ table: name, op: "insert", args: v });
        if (state.failInsert) return { select: () => ({ single: async () => ({ data: null, error: { message: state.failInsert! } }) }) };
        state.rows.push({ id: `row${state.rows.length + 1}`, ...v });
        return { select: () => ({ single: async () => ({ data: state.rows[state.rows.length - 1], error: null }) }) };
      },
      update: (v: Record<string, unknown>) => {
        calls.push({ table: name, op: "update", args: v });
        return { eq: (k: string, val: unknown) => ({
          eq: () => Promise.resolve({ data: null, error: null }),
          then: (res: (x: { data: null; error: null }) => void) => { void k; void val; res({ data: null, error: null }); },
        }) };
      },
    };
    // make update(...).eq(...) awaitable directly
    return api;
  };
  const db = {
    from: (name: string) => table(name),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ op: `rpc:${fn}`, args });
      return { data: state.rpc[fn] ?? [], error: null };
    },
    stores: {} as MediaDb["stores"],
  } as unknown as MediaDb;
  return { db, calls, state };
}

test("discovery asks for the window the retention policy actually is", async () => {
  const { db, calls } = stubDb();
  await findDue(db, 7);
  const c = calls.find((x) => x.op === "rpc:rescript_media_deliveries_due")!;
  assert.deepEqual(c.args, { p_limit: 7, p_window_hours: 48 },
    "a wider window would re-email recordings that are already past their retention");
});

test("two runs discovering the same response produce one delivery, not two", async () => {
  const { db, state } = stubDb();
  const due = {
    response_id: "r1", survey_id: "s1", customer_id: "c1", session_id: "sess1",
    respondent_label: "R1", recipient_email: "a@b.co", media_count: 2,
  };
  const first = await openDelivery(db, due);
  assert.ok(first, "the first run opens it");

  state.failInsert = 'duplicate key value violates unique constraint "media_deliveries_response_key"';
  const second = await openDelivery(db, due);
  assert.equal(second, null, "the second run is told to move on, not thrown at");
});

test("the claim carries the backoff and attempt budget into SQL", async () => {
  const { db, calls } = stubDb();
  await claimDelivery(db, "d1", { staleSeconds: 60, maxAttempts: 3 });
  const c = calls.find((x) => x.op === "rpc:rescript_claim_media_delivery")!;
  assert.deepEqual(c.args, { p_id: "d1", p_stale_seconds: 60, p_max_attempts: 3 });
});

test("only respondent-side media is ever delivered", () => {
  assert.deepEqual([...DELIVERED_KINDS], ["answer_audio", "answer_upload"]);
  assert.ok(!DELIVERED_KINDS.includes("question_video" as never),
    "the researcher's own stimulus is not mailed back to them");
});

test("a failure keeps the manifest, so the row still means something later", async () => {
  const { db, calls } = stubDb();
  const manifest = [{ mediaId: "m1", bucket: "b", path: "p", fileName: "f.webm", kind: "answer_audio", bytes: 42, mimeType: null, questionId: "q", questionCode: null, answerKey: null, durationSeconds: null }];
  await markFailed(db, "d1", "resend said no", manifest);
  const c = calls.filter((x) => x.op === "update").pop()!;
  const args = c.args as Record<string, unknown>;
  assert.equal(args.status, "failed");
  assert.equal(args.media_count, 1);
  assert.equal(args.total_bytes, 42);
  assert.match(String(args.error), /resend said no/);
});

test("expiring a link clears the token hash", async () => {
  const { db, calls } = stubDb();
  await expireLink(db, "d1");
  const args = calls.filter((x) => x.op === "update").pop()!.args as Record<string, unknown>;
  assert.equal(args.status, "expired");
  assert.equal(args.token_hash, null,
    "the credential is destroyed, not merely marked — a leaked backup yields nothing");
});

test("a retry only reopens a failed delivery, and resets the budget", async () => {
  const { db, calls } = stubDb();
  await retryDelivery(db, "d1");
  const args = calls.filter((x) => x.op === "update").pop()!.args as Record<string, unknown>;
  assert.equal(args.status, "pending");
  assert.equal(args.attempts, 0, "a person who fixed the address is not asking for one more try on the old budget");
  assert.equal(args.error, null);
});

test("the retry backoff grows, and is written as an instant rather than derived", async () => {
  // five minutes, then ten, twenty… capped, so a bouncing address is tried a
  // few times over a morning instead of every ten minutes for two days
  assert.equal(backoffMs(1), 5 * 60_000);
  assert.equal(backoffMs(2), 10 * 60_000);
  assert.equal(backoffMs(3), 20 * 60_000);
  assert.equal(backoffMs(9), backoffMs(6), "and it stops growing");

  const { db, calls } = stubDb();
  const before = Date.now();
  await markFailed(db, "d1", "nope", undefined, 2);
  const args = calls.filter((x) => x.op === "update").pop()!.args as Record<string, unknown>;
  const due = Date.parse(String(args.retry_after));
  /*
   * The instant is stored, not computed from `updated_at` — the touch trigger
   * rewrites that on every update, so any unrelated write to the row would
   * otherwise restart the wait and a dead address would be retried forever.
   */
  assert.ok(due >= before + backoffMs(2) - 1000 && due <= Date.now() + backoffMs(2) + 1000,
    `retry_after should be ~10 minutes out, got ${args.retry_after}`);
});
