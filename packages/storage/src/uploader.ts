import {
  MAX_UPLOAD_ATTEMPTS, PartAccumulator, retryDelayMs, retryable,
} from "./upload.js";

/**
 * SENDING A RECORDING TO OBJECT STORAGE FROM A CANDIDATE'S BROWSER.
 *
 * The arithmetic lives in `@rescript/storage/upload` and is unit-tested. This
 * is the part that talks to the network, and everything in it exists because
 * of one sentence in §6: *a temporary network interruption must not cause a
 * completed interview answer to be permanently lost.*
 *
 * ## Parts go while the candidate is still speaking
 *
 * `MediaRecorder` hands over a chunk every few seconds. The obvious design —
 * collect everything, assemble one blob, upload at the end — leaves somebody
 * watching a progress bar for the length of their own answer, on whatever
 * connection they have, at the exact moment they are most likely to give up
 * and close the tab. And an interruption there loses the whole answer.
 *
 * So chunks accumulate into 8 MiB parts and each one is sent the moment it is
 * complete. By the time a five-minute answer stops, four of its five parts
 * are already in the store and the wait is a second or two.
 *
 * ## Resume asks the store, never itself
 *
 * On any failure that survives the retries, `resume()` asks the server which
 * parts the STORE has and sends only the others. There is deliberately no
 * client-side ledger of "parts I believe I sent": a second record of the same
 * fact is a second record to get out of step, and a part the browser thinks
 * it sent that never arrived is precisely the case that must not be skipped.
 *
 * ## Nothing here reports success it has not been told about
 *
 * `onStored` fires only after the server's completion route has asked the
 * store for the object's metadata. A 200 from a PUT is not a stored
 * recording — a buffering proxy, a multipart completion that returns 200 with
 * an error document inside it, an object that simply is not readable
 * afterwards — and a candidate told "saved" who then loses an answer has been
 * lied to by the product.
 */

export type UploadPhase =
  | "idle" | "preparing" | "uploading" | "finishing" | "stored" | "failed" | "waiting";

export interface UploadState {
  phase: UploadPhase;
  /** 0–1, counting only what the store has taken. */
  progress: number;
  /** Parts accepted by the store. */
  partsDone: number;
  partsTotal: number;
  attempt: number;
  message: string | null;
  mediaId: string | null;
}

/**
 * Where the uploader talks, and what it says when it starts.
 *
 * The candidate path and the moderated path differ in exactly two ways: the
 * URLs, and the identifiers in the `begin` body — a link token and a response
 * for a candidate, an interview and a question for a researcher. Everything
 * after that is the same protocol against the same store, including the
 * verify-before-believe completion, so they share one implementation rather
 * than two that will drift.
 *
 * Both default to the candidate's, so nothing that exists today changes.
 */
export interface UploaderEndpoints {
  begin: string;
  parts: string;
  complete: string;
}

export interface UploaderOptions {
  token?: string;
  responseId?: string;
  /** the product's begin/parts/complete routes — required; there is no default */
  endpoints: UploaderEndpoints;
  /** merged into the `begin` body — how a session names its interview and question */
  beginExtra?: Record<string, unknown>;
  /** merged into the `complete` body — how a session video says a companion is coming */
  completeExtra?: Record<string, unknown>;
  /**
   * The take's own name, when the caller has one to keep across a page
   * reload (a retry after a refresh finds the same upload). Generated when
   * absent.
   */
  clientToken?: string;
  mimeType: string;
  /** Told to the server so the plan and the caps can be computed up front. */
  estimatedBytes: number;
  onState(state: UploadState): void;
  onTelemetry?(kind: string, detail?: Record<string, unknown>): void;
  fetchImpl?: typeof fetch;
}

interface BeginReply {
  ok: boolean;
  mediaId: string;
  kind: "single" | "multipart";
  partBytes: number;
  partCount: number;
  uploadUrl: string | null;
  uploadId: string | null;
  parts: { partNumber: number; url: string }[];
  uploaded?: { partNumber: number; etag: string }[];
  alreadyStored?: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RecordingUploader {
  private readonly opts: UploaderOptions;
  private readonly doFetch: typeof fetch;
  private readonly accumulator: PartAccumulator;
  /**
   * The browser's own name for this take, sent with every request.
   * A double-click, or a retried request that actually succeeded the first
   * time, resolves to the SAME media row rather than a second upload of the
   * same recording that both get paid for.
   */
  private readonly clientToken: string;
  private readonly endpoints: UploaderEndpoints;

  private begun: BeginReply | null = null;
  private readonly accepted = new Map<number, string>();   // partNumber -> etag
  /**
   * EVERY PART THIS RECORDING ACTUALLY PRODUCED.
   *
   * Not how many the plan expected — how many the recorder released. These
   * are different numbers and conflating them is what broke every long
   * answer: `estimatedBytes` is `expectedBytes(maxSeconds)`, the bytes a
   * recording of the MAXIMUM permitted length would occupy, plus a 15%
   * margin. A recording that runs to the cap therefore produces about 87% of
   * the estimate, and one that stops early produces far less — so a
   * completeness test against a part count derived from the estimate can
   * never pass, and `finish()` refused every answer over the ~59 seconds
   * where the 8 MiB multipart threshold begins.
   *
   * The estimate's job is CAPACITY — sign enough URLs, refuse an upload that
   * would breach a storage cap. It was never evidence about what was
   * recorded. This set is.
   */
  private readonly released = new Set<number>();
  private readonly pending: { partNumber: number; blob: Blob }[] = [];
  private inFlight: Promise<void> = Promise.resolve();
  private state: UploadState;
  private finished = false;
  private abandoned = false;

  constructor(opts: UploaderOptions) {
    if (!opts.endpoints) throw new Error("RecordingUploader needs its endpoints — each product names its own begin/parts/complete routes");
    this.endpoints = opts.endpoints;
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch.bind(globalThis);
    this.accumulator = new PartAccumulator();
    this.clientToken = opts.clientToken
      ?? `${opts.responseId ?? "take"}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    this.state = {
      phase: "idle", progress: 0, partsDone: 0, partsTotal: 0,
      attempt: 0, message: null, mediaId: null,
    };
  }

  get snapshot(): UploadState { return { ...this.state }; }

  private set(patch: Partial<UploadState>) {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.snapshot);
  }

  private tell(kind: string, detail?: Record<string, unknown>) {
    this.opts.onTelemetry?.(kind, detail);
  }

  /** Ask the server for a plan and the first set of signed URLs. */
  async begin(): Promise<void> {
    this.set({ phase: "preparing", message: null });
    const res = await this.doFetch(this.endpoints.begin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: this.opts.token,
        responseId: this.opts.responseId,
        clientToken: this.clientToken,
        bytes: this.opts.estimatedBytes,
        mimeType: this.opts.mimeType,
        ...(this.opts.beginExtra ?? {}),
      }),
    });
    const reply = (await res.json().catch(() => ({}))) as BeginReply;
    if (!res.ok || !reply.ok) {
      this.set({ phase: "failed", message: reply.error ?? "We could not start saving your answer." });
      throw new Error(reply.error ?? `begin failed (${res.status})`);
    }
    this.begun = reply;
    for (const p of reply.uploaded ?? []) this.accepted.set(p.partNumber, p.etag);
    this.set({
      phase: "uploading",
      mediaId: reply.mediaId,
      partsTotal: reply.kind === "single" ? 1 : reply.partCount,
      partsDone: this.accepted.size,
    });
    this.tell("upload_started", { mediaId: reply.mediaId, parts: reply.partCount });
  }

  /** The media id the server assigned at `begin`, so a companion can name it. */
  get mediaId(): string | null {
    return this.begun?.mediaId ?? null;
  }

  /**
   * One recorder chunk. Releases a part when there is enough for one, and
   * starts sending it immediately — the whole point of the accumulator.
   */
  push(chunk: Blob): void {
    if (this.finished || this.abandoned) return;
    const part = this.accumulator.push(chunk);
    if (part) this.queue(part.partNumber, new Blob(part.blobs as BlobPart[], { type: this.opts.mimeType }));
  }

  /**
   * Recording has stopped. Send whatever is left, wait for everything, then
   * ask the server to assemble and VERIFY.
   */
  async finish(durationSeconds: number): Promise<{ ok: true; mediaId: string; reply: Record<string, unknown> } | { ok: false; error: string }> {
    if (this.abandoned) return { ok: false, error: "This upload was cancelled." };
    const last = this.accumulator.finish();
    if (last) this.queue(last.partNumber, new Blob(last.blobs as BlobPart[], { type: this.opts.mimeType }));
    this.finished = true;

    this.set({ phase: "uploading" });
    await this.inFlight;

    /*
     * ALWAYS ASK THE STORE BEFORE COMPLETING — even when we believe every
     * part went.
     *
     * This was `if (accepted.size < partsTotal)`, and that condition is the
     * bug: a part that returned 200 and then was not there is a part we
     * believe we sent, so the check never fired, the completion assembled
     * whatever the store actually had, and the candidate got a "Saved" for a
     * recording that was two thirds of their answer. Nobody would ever have
     * found out — a truncated video plays.
     *
     * Our belief is not evidence. One extra request per answer buys the
     * guarantee that what is assembled is what was recorded.
     */
    /*
     * The recorder has stopped, so the released set is now final and is the
     * target. Told to the UI as well, so the progress bar is denominated in
     * parts that exist rather than parts that were guessed at.
     */
    this.set({ partsTotal: this.released.size || this.state.partsTotal, progress: this.fraction() });

    if (this.begun && this.begun.kind === "multipart") {
      const recovered = await this.resume();
      if (!recovered) {
        this.set({ phase: "failed", message: "Part of your answer did not reach us." });
        return { ok: false, error: "Part of your answer did not reach us." };
      }
    }

    this.set({ phase: "finishing" });
    const res = await this.doFetch(this.endpoints.complete, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(this.opts.completeExtra ?? {}),
        token: this.opts.token,
        mediaId: this.begun?.mediaId,
        durationSeconds,
        /* what the recording produced, so the server can check completeness
           against a fact instead of against the opening estimate */
        partsReleased: this.released.size,
        bytesRecorded: this.accumulator.totalBytes,
        parts: [...this.accepted.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
      }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) {
      this.set({ phase: "failed", message: reply.error ?? "Your answer could not be saved." });
      this.tell("upload_failed", { reason: reply.error ?? res.status });
      return { ok: false, error: reply.error ?? "Your answer could not be saved." };
    }

    this.set({ phase: "stored", progress: 1, message: null });
    this.tell("upload_verified", { mediaId: reply.mediaId, bytes: reply.bytes });
    /* the whole reply travels back: a product's confirm route answers with the shape its answer stores */
    return { ok: true, mediaId: reply.mediaId, reply: reply as Record<string, unknown> };
  }

  /**
   * Ask the server which parts the store has, and re-send the rest.
   *
   * Called after a failure and after the tab comes back from being offline.
   * It is safe to call at any time: it never sends a part the store already
   * has, and re-sending a part that IS there would simply replace it with an
   * identical one.
   */
  async resume(): Promise<boolean> {
    if (!this.begun || this.abandoned) return false;
    this.set({ phase: "waiting", message: "Reconnecting…" });
    this.tell("upload_retried", { mediaId: this.begun.mediaId });

    const res = await this.doFetch(this.endpoints.parts, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: this.opts.token,
        mediaId: this.begun.mediaId,
        bytes: this.opts.estimatedBytes,
        partsReleased: this.finished ? this.released.size : undefined,
      }),
    });
    const reply = await res.json().catch(() => ({}));
    if (!res.ok || !reply.ok) {
      this.set({ phase: "failed", message: "We could not reach the server." });
      return false;
    }

    this.accepted.clear();
    for (const p of reply.uploaded ?? []) this.accepted.set(p.partNumber, p.etag);
    this.set({ partsDone: this.accepted.size, progress: this.fraction() });

    if (reply.complete) return true;

    /* re-send only what is genuinely missing, with the fresh signatures */
    const urls = new Map<number, string>((reply.parts ?? []).map((p: { partNumber: number; url: string }) => [p.partNumber, p.url]));
    const missing = this.pending.filter((p) => !this.accepted.has(p.partNumber));
    if (this.begun) {
      this.begun = { ...this.begun, parts: reply.parts ?? [] };
    }
    this.set({ phase: "uploading", message: null });
    for (const part of missing) {
      const url = urls.get(part.partNumber);
      if (!url) continue;
      const ok = await this.send(part.partNumber, part.blob, url);
      if (!ok) return false;
    }
    return this.complete();
  }

  /**
   * Has the store acknowledged every part this recording produced?
   *
   * By part NUMBER, not by count: two acknowledgements of part 3 and none of
   * part 4 is not a finished upload, and a count comparison cannot tell those
   * apart. Before the recorder stops the answer is always no — there is more
   * to come.
   */
  private complete(): boolean {
    if (!this.finished) return false;
    if (this.released.size === 0) return false;
    for (const n of this.released) if (!this.accepted.has(n)) return false;
    return true;
  }

  /** Give up on this take and stop paying for the parts already stored. */
  async abandon(): Promise<void> {
    this.abandoned = true;
    this.pending.length = 0;
    this.set({ phase: "idle", progress: 0, partsDone: 0, message: null });
  }

  /* ------------------------------------------------------------ internals */

  private fraction(): number {
    /*
     * Denominated in released parts once the recorder has stopped. Before
     * that the plan's count is the best guess available, but it is a ceiling
     * — which is why a full-length answer used to stall the bar at a
     * fraction of itself and look stuck while it was in fact finishing.
     */
    const total = this.finished
      ? (this.released.size || this.state.partsTotal || 1)
      : (Math.max(this.state.partsTotal, this.released.size) || 1);
    return Math.min(1, this.accepted.size / total);
  }

  private queue(partNumber: number, blob: Blob): void {
    this.pending.push({ partNumber, blob });
    this.released.add(partNumber);
    /* the plan's part count is a ceiling; once the recorder overtakes it the
       honest total is what was released */
    if (this.released.size > this.state.partsTotal) {
      this.set({ partsTotal: this.released.size });
    }
    /*
     * Serialised, not parallel. Two parts in flight on a poor mobile
     * connection compete for the same few hundred kilobits and BOTH time out,
     * which turns one slow upload into two failed ones. Sending in order also
     * means the progress bar only ever moves forward.
     */
    this.inFlight = this.inFlight.then(async () => {
      if (this.abandoned) return;
      if (!this.begun) await this.begin().catch(() => {});
      if (!this.begun || this.abandoned) return;
      const url = this.begun.kind === "single"
        ? this.begun.uploadUrl
        : this.begun.parts.find((p) => p.partNumber === partNumber)?.url ?? null;
      if (!url) return;
      await this.send(partNumber, blob, url);
    });
  }

  /** One part, with retries, backed off and jittered. */
  private async send(partNumber: number, blob: Blob, url: string): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      if (this.abandoned) return false;
      this.set({ attempt });
      let status: number | null = null;
      try {
        const res = await this.doFetch(url, { method: "PUT", body: blob });
        status = res.status;
        if (res.ok) {
          /*
           * The etag the STORE issued. A completion naming an etag we invented
           * is refused, which is how a corrupted part is caught rather than
           * assembled into a recording nobody can play.
           */
          const etag = (res.headers.get("etag") ?? "").replace(/"/g, "")
            || `part-${partNumber}`;
          this.accepted.set(partNumber, etag);
          this.set({
            partsDone: this.accepted.size,
            progress: this.fraction(),
            phase: this.complete() ? "finishing" : "uploading",
            message: null,
            attempt: 0,
          });
          return true;
        }
      } catch {
        status = null;   // a network throw: no answer at all
      }

      this.tell("upload_part_failed", { partNumber, status, attempt });
      if (!retryable(status)) {
        /*
         * A 403 is an expired or wrong signature, and trying the same URL
         * again will fail identically for ever. A fresh ticket is the only
         * thing that helps, so hand off to `resume`.
         */
        this.set({ phase: "waiting", message: "Reconnecting…" });
        return false;
      }
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        this.set({ phase: "waiting", message: `Connection trouble — trying again (${attempt})…` });
        await sleep(retryDelayMs(attempt));
      }
    }
    this.set({ phase: "failed", message: "Part of your answer would not send." });
    return false;
  }
}
