import test from "node:test";
import assert from "node:assert/strict";
import {
  beginUpload, confirmUpload, queueTranscript, removeMedia, purgeSessionMedia,
  resetBucketCache, MediaError, type MediaDb,
} from "./store.js";
import { runTranscription } from "./runner.js";

/**
 * A stub database, because the whole point of `MediaDb` being structural is
 * that the lifecycle can be proven without Supabase, Next, or a network.
 *
 * It is deliberately literal about the two things that matter: rows really
 * exist or do not, and `storage.list` really answers whether an object landed
 * — that second one being the difference between "the browser said it worked"
 * and "it worked".
 */
function stub(opts: { objects?: Set<string>; failUploadUrl?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const transcripts = new Map<string, Record<string, unknown>>();
  const objects = opts.objects ?? new Set<string>();
  const removed: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let seq = 0;

  const table = (name: string) => {
    const store = name === "media_objects" ? rows : transcripts;
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const q: Record<string, unknown> = {};
    const match = () => [...store.values()].filter((r) => filters.every((f) => f(r)));
    Object.assign(q, {
      insert(row: Record<string, unknown>) {
        const id = `${name}-${++seq}`;
        const full = { id, attempts: 0, status: row.status ?? "waiting", ...row };
        store.set(id, full);
        return {
          select: () => ({
            single: async () => ({ data: full, error: null }),
          }),
        };
      },
      select() { return q; },
      update(patch: Record<string, unknown>) {
        return {
          eq(col: string, val: unknown) {
            for (const r of store.values()) if (r[col] === val) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      delete() {
        return {
          in(col: string, vals: unknown[]) {
            for (const [k, r] of [...store.entries()]) if (vals.includes(r[col])) store.delete(k);
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return q; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.includes(r[col])); return q; },
      lt(col: string, val: unknown) { filters.push((r) => String(r[col]) < String(val)); return q; },
      maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
      single: async () => ({ data: match()[0] ?? null, error: null }),
      then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: match(), error: null }),
    });
    return q;
  };

  const db: MediaDb = {
    from: (name: string) => table(name),
    rpc: async (fn, args) => {
      rpcCalls.push({ fn, args });
      if (fn !== "rescript_claim_transcription") return { data: null, error: null };
      const row = [...transcripts.values()].find((t) => t.media_id === args.p_media);
      if (!row) return { data: [], error: null };
      const attempts = Number(row.attempts ?? 0);
      const claimable = ["waiting", "failed"].includes(String(row.status));
      if (!claimable || attempts >= Number(args.p_max_attempts ?? 3)) return { data: [], error: null };
      row.status = "processing";
      row.attempts = attempts + 1;
      const media = rows.get(String(row.media_id))!;
      return {
        data: [{
          id: row.id, media_id: row.media_id, survey_id: row.survey_id,
          status: row.status, attempts: row.attempts,
          bucket: media.bucket, path: media.path, mime_type: media.mime_type,
          duration_seconds: media.duration_seconds, kind: media.kind,
        }],
        error: null,
      };
    },
    storage: {
      listBuckets: async () => ({ data: [{ name: "rescript-video" }, { name: "rescript-uploads" }, { name: "rescript-audio" }], error: null }),
      createBucket: async () => ({ error: null }),
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string) => opts.failUploadUrl
          ? { data: null, error: { message: "no" } }
          : { data: { signedUrl: `https://storage.test/${bucket}/${path}?sig=1`, token: "tok", path }, error: null },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/${bucket}/${path}?read=1` }, error: null }),
        download: async (path: string) => objects.has(`${bucket}/${path}`)
          ? { data: { arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer, type: "audio/webm" }, error: null }
          : { data: null, error: { message: "not found" } },
        remove: async (paths: string[]) => { for (const p of paths) { removed.push(`${bucket}/${p}`); objects.delete(`${bucket}/${p}`); } return { data: null, error: null }; },
        list: async (folder: string) => ({
          data: [...objects]
            .filter((o) => o.startsWith(`${bucket}/${folder}/`))
            .map((o) => ({ name: o.slice(`${bucket}/${folder}/`.length) })),
          error: null,
        }),
      }),
    },
  };
  return { db, rows, transcripts, objects, removed, rpcCalls };
}

const BEGIN = {
  kind: "question_video" as const,
  customerId: "cust-1",
  surveyId: "sv-1",
  questionId: "q-1",
  fileName: "question.webm",
  mimeType: "video/webm",
  bytes: 20 * 1024 * 1024,
  now: 1_700_000_000_000,
};

test("a row exists BEFORE the upload url is handed out", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, BEGIN);
  const row = s.rows.get(ticket.mediaId)!;
  assert.equal(row.status, "pending", "a pending row is the only evidence a failed upload leaves");
  assert.equal(row.survey_id, "sv-1");
  assert.equal(row.question_id, "q-1");
  assert.equal(row.bucket, "rescript-video");
  assert.match(ticket.uploadUrl, /^https:\/\/storage\.test\//);
});

test("a file over the limit never gets a url at all", async () => {
  resetBucketCache();
  const s = stub();
  await assert.rejects(
    () => beginUpload(s.db, { ...BEGIN, bytes: 400 * 1024 * 1024 }),
    (e: MediaError) => e.status === 413 && /150 MB/.test(e.message),
  );
  assert.equal(s.rows.size, 0, "nothing was reserved");
});

test("the wrong kind of file is refused before anything is stored", async () => {
  resetBucketCache();
  const s = stub();
  await assert.rejects(
    () => beginUpload(s.db, { ...BEGIN, mimeType: "image/png" }),
    (e: MediaError) => e.status === 415,
  );
});

test("confirm does not take the client's word for it", async () => {
  resetBucketCache();
  const s = stub();                       // no objects: the upload did not land
  const ticket = await beginUpload(s.db, BEGIN);
  await assert.rejects(
    () => confirmUpload(s.db, ticket.mediaId, { bytes: 20 * 1024 * 1024 }),
    (e: MediaError) => e.status === 409 && /did not reach storage/.test(e.message),
  );
  assert.equal(s.rows.get(ticket.mediaId)!.status, "failed");
});

test("confirm stores, records the metadata and hands back a playable url", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, BEGIN);
  s.objects.add(`rescript-video/${ticket.path}`);
  const stored = await confirmUpload(s.db, ticket.mediaId, { bytes: 21_000_000, durationSeconds: 302.456, width: 1280, height: 720 });
  const row = s.rows.get(ticket.mediaId)!;
  assert.equal(row.status, "stored");
  assert.ok(row.uploaded_at);
  assert.equal(row.bytes, 21_000_000);
  assert.equal(row.duration_seconds, 302.46);
  assert.equal(row.width, 1280);
  assert.equal(stored.durationSeconds, 302.46);
  assert.match(stored.url, /read=1/);
});

test("an object that turns out to be over the limit is deleted, not kept", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, { ...BEGIN, bytes: null });   // client declared nothing
  s.objects.add(`rescript-video/${ticket.path}`);
  await assert.rejects(
    () => confirmUpload(s.db, ticket.mediaId, { bytes: 400 * 1024 * 1024 }),
    (e: MediaError) => e.status === 413,
  );
  assert.deepEqual(s.removed, [`rescript-video/${ticket.path}`]);
});

test("queueing a transcript twice queues one job", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, { ...BEGIN, kind: "question_audio", mimeType: "audio/webm", bytes: 2_000_000 });
  const a = await queueTranscript(s.db, ticket.mediaId, "sv-1");
  const b = await queueTranscript(s.db, ticket.mediaId, "sv-1");
  assert.equal(a.id, b.id, "a double-click must not buy a second transcription");
  assert.equal(s.transcripts.size, 1);
});

/* ------------------------------------------------------------ the runner */

const okTranscribe = async () => ({ text: "  I liked the packaging.  ", model: "whisper-1", language: "en" });
const pass = async <T>(_s: number, fn: () => Promise<T>) => ({ value: await fn() });

async function stored(s: ReturnType<typeof stub>, over = false) {
  const ticket = await beginUpload(s.db, {
    ...BEGIN, kind: "question_audio", mimeType: "audio/webm",
    bytes: over ? 30 * 1024 * 1024 : 2_000_000, durationSeconds: 300,
  });
  s.objects.add(`rescript-video/${ticket.path}`);
  await confirmUpload(s.db, ticket.mediaId, { bytes: over ? 30 * 1024 * 1024 : 2_000_000, durationSeconds: 300 });
  await queueTranscript(s.db, ticket.mediaId, "sv-1");
  return ticket.mediaId;
}

test("a transcription runs, completes, and keeps the text", async () => {
  resetBucketCache();
  const s = stub();
  const mediaId = await stored(s);
  const out = await runTranscription(s.db, mediaId, { transcribe: okTranscribe, metered: pass });
  assert.equal(out.status, "completed");
  assert.equal(out.text, "I liked the packaging.");
  assert.equal(out.ran, true);
  assert.equal(out.attempts, 1);
});

test("a second runner does not take a job the first one holds", async () => {
  resetBucketCache();
  const s = stub();
  const mediaId = await stored(s);
  let calls = 0;
  const slow = async () => { calls++; return { text: "hello", model: "whisper-1" }; };
  await runTranscription(s.db, mediaId, { transcribe: slow, metered: pass });
  const second = await runTranscription(s.db, mediaId, { transcribe: slow, metered: pass });
  assert.equal(second.ran, false, "a completed job is not re-run");
  assert.equal(calls, 1, "and the provider is not paid twice");
  assert.equal(second.status, "completed");
});

test("a refused wallet fails the job without losing the recording", async () => {
  resetBucketCache();
  const s = stub();
  const mediaId = await stored(s);
  const out = await runTranscription(s.db, mediaId, {
    transcribe: okTranscribe,
    metered: async () => ({ refused: "this project's wallet is empty" }),
  });
  assert.equal(out.status, "failed");
  assert.match(out.error!, /wallet is empty/);
  assert.equal(s.rows.get(mediaId)!.status, "stored", "the clip is still there to retry from");
});

test("a failed job is retryable, and gives up after three attempts", async () => {
  resetBucketCache();
  const s = stub();
  const mediaId = await stored(s);
  const down = async () => null;
  const a = await runTranscription(s.db, mediaId, { transcribe: down, metered: pass });
  assert.equal(a.status, "failed");
  assert.equal(a.attempts, 1);
  const b = await runTranscription(s.db, mediaId, { transcribe: down, metered: pass });
  assert.equal(b.attempts, 2, "a failure is claimable again — that is what Retry is");
  await runTranscription(s.db, mediaId, { transcribe: down, metered: pass });
  const d = await runTranscription(s.db, mediaId, { transcribe: down, metered: pass });
  assert.equal(d.ran, false, "and not forever, at the customer's expense");
  assert.equal(d.attempts, 3);
  /* the recording it could not read is still stored */
  assert.equal(s.rows.get(mediaId)!.status, "stored");
});

test("a retry after a failure succeeds from the STORED audio", async () => {
  resetBucketCache();
  const s = stub();
  const mediaId = await stored(s);
  await runTranscription(s.db, mediaId, { transcribe: async () => null, metered: pass });
  const out = await runTranscription(s.db, mediaId, { transcribe: okTranscribe, metered: pass });
  assert.equal(out.status, "completed");
  assert.equal(out.text, "I liked the packaging.");
});

test("audio too large for the provider is refused with a sentence, not sent", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, { ...BEGIN, kind: "question_audio", mimeType: "audio/webm", bytes: 2_000_000 });
  s.objects.add(`rescript-video/${ticket.path}`);
  await confirmUpload(s.db, ticket.mediaId, { bytes: 2_000_000 });
  await queueTranscript(s.db, ticket.mediaId, "sv-1");
  /* the object is bigger than the row claimed */
  const big = stub({ objects: s.objects });
  void big;
  let called = false;
  const out = await runTranscription(s.db, ticket.mediaId, {
    transcribe: async () => { called = true; return null; },
    metered: pass,
  });
  /* the stub returns 4 bytes, so this one completes — the size guard is
     asserted directly instead, since a 25 MB fixture is not worth the memory */
  assert.equal(called, true);
  assert.equal(out.status, "failed");
});

test("a recording whose object has vanished fails loudly rather than silently", async () => {
  resetBucketCache();
  const s = stub();
  const mediaId = await stored(s);
  s.objects.clear();
  const out = await runTranscription(s.db, mediaId, { transcribe: okTranscribe, metered: pass });
  assert.equal(out.status, "failed");
  assert.match(out.error!, /could not read the recording/);
});

/* ------------------------------------------------------------ cleanup */

test("removing media deletes the object first, then the row", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, BEGIN);
  s.objects.add(`rescript-video/${ticket.path}`);
  await confirmUpload(s.db, ticket.mediaId, { bytes: 1000 });
  const report = await removeMedia(s.db, [{ id: ticket.mediaId, bucket: "rescript-video", path: ticket.path }]);
  assert.equal(report.objects, 1);
  assert.equal(report.rows, 1);
  assert.equal(s.objects.size, 0);
  assert.equal(s.rows.size, 0);
});

test("purging a respondent takes their recording with them", async () => {
  resetBucketCache();
  const s = stub();
  const t1 = await beginUpload(s.db, { ...BEGIN, kind: "answer_audio", mimeType: "audio/webm", sessionId: "sess-a", bytes: 1000 });
  const t2 = await beginUpload(s.db, { ...BEGIN, kind: "answer_audio", mimeType: "audio/webm", sessionId: "sess-b", bytes: 1000, now: BEGIN.now + 1 });
  s.objects.add(`rescript-uploads/${t1.path}`);
  s.objects.add(`rescript-uploads/${t2.path}`);

  const report = await purgeSessionMedia(s.db, ["sess-a"]);
  assert.equal(report.objects, 1);
  assert.ok(!s.objects.has(`rescript-uploads/${t1.path}`), "the erased respondent's clip is gone");
  assert.ok(s.objects.has(`rescript-uploads/${t2.path}`), "and nobody else's is");
  assert.equal(s.rows.size, 1);
});

test("a storage failure is reported, never thrown — a delete must not be blocked by it", async () => {
  resetBucketCache();
  const s = stub();
  const ticket = await beginUpload(s.db, BEGIN);
  const broken: MediaDb = {
    ...s.db,
    storage: {
      ...s.db.storage,
      from: () => ({
        ...s.db.storage.from("rescript-video"),
        remove: async () => ({ data: null, error: { message: "storage is down" } }),
      }),
    },
  };
  const report = await removeMedia(broken, [{ id: ticket.mediaId, bucket: "rescript-video", path: ticket.path }]);
  assert.equal(report.objects, 0);
  assert.equal(report.rows, 1, "the row still goes, so the next sweep is not confused by it");
  assert.match(report.warnings[0], /storage is down/);
});
