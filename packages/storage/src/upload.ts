/**
 * THE ARITHMETIC OF A LARGE UPLOAD THAT SURVIVES A BAD NETWORK.
 *
 * Pure, browser-safe, dependency-free — no `node:crypto`, no `fetch`, nothing
 * that cannot run in a respondent's tab. It is here rather than in the
 * recorder component because it is the part that has to be RIGHT, and a
 * function you can drive ten thousand times in a unit test is right long
 * before a component you can click through is.
 *
 * ## The rules the store imposes, which are not negotiable
 *
 *  · A part is at least 5 MiB — except the last, which may be anything.
 *    Get this wrong and the store rejects the COMPLETION, after every byte
 *    has been paid for and sent.
 *  · At most 10,000 parts.
 *  · Parts are numbered from 1, and the completion must name them in
 *    ascending order with the etag the store issued for each.
 *
 * ## Why parts are uploaded WHILE the candidate is still speaking
 *
 * `MediaRecorder` with a timeslice hands over a chunk every few seconds. The
 * obvious design — collect them all, assemble one blob, upload at the end —
 * has the respondent staring at a progress bar for the length of their own
 * answer, on the worst possible connection, at the exact moment they are most
 * likely to close the tab. And an interruption there loses everything.
 *
 * So chunks accumulate into a buffer, and the moment the buffer passes the
 * part size it becomes a part and goes. By the time somebody stops talking,
 * all but the last few megabytes are already in the store. `PartAccumulator`
 * is that buffer, and it is the reason this file exists.
 *
 * ## Resume, precisely
 *
 * The store knows which parts it accepted; `listUploadedParts` asks it. A
 * resumed upload sends the parts that are missing and no others. That is the
 * whole mechanism — there is no client-side bookkeeping to get out of step,
 * because the only opinion that counts is the store's.
 */

/** S3's floor for every part but the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

/**
 * What we actually use. Comfortably above the floor, so an accumulator that
 * overshoots slightly cannot produce an illegal part; small enough that a
 * dropped connection costs at most this much re-sending.
 */
export const PART_BYTES = 8 * 1024 * 1024;

export const MAX_PARTS = 10_000;

/**
 * Below this, one PUT. A single request is simpler, has no completion step to
 * fail, and cannot leave orphaned parts to be billed for — and anything this
 * small re-sends in a second or two, so resumability buys nothing.
 */
export const MULTIPART_THRESHOLD = PART_BYTES;

export interface UploadPlan {
  kind: "single" | "multipart";
  totalBytes: number;
  partBytes: number;
  partCount: number;
}

export class UploadPlanError extends Error {}

/** How an object of a known size will be sent. */
export function planUpload(totalBytes: number, partBytes = PART_BYTES): UploadPlan {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new UploadPlanError("An upload needs a real byte count.");
  }
  if (totalBytes < MULTIPART_THRESHOLD) {
    return { kind: "single", totalBytes, partBytes: totalBytes, partCount: 1 };
  }
  let size = Math.max(MIN_PART_BYTES, Math.floor(partBytes));
  // A recording long enough to exceed 10,000 parts at this size grows the
  // part instead of failing: 10,000 x 8 MiB is 80 GB, so this is theoretical
  // for an interview answer and free to be correct about anyway.
  if (Math.ceil(totalBytes / size) > MAX_PARTS) size = Math.ceil(totalBytes / MAX_PARTS);
  return {
    kind: "multipart",
    totalBytes,
    partBytes: size,
    partCount: Math.max(1, Math.ceil(totalBytes / size)),
  };
}

export interface PartRange {
  partNumber: number;
  start: number;
  /** Exclusive. */
  end: number;
  bytes: number;
}

export function partRange(plan: UploadPlan, partNumber: number): PartRange {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) {
    throw new UploadPlanError(`Part ${partNumber} is not in this upload.`);
  }
  const start = (partNumber - 1) * plan.partBytes;
  const end = Math.min(plan.totalBytes, start + plan.partBytes);
  return { partNumber, start, end, bytes: end - start };
}

export function allParts(plan: UploadPlan): PartRange[] {
  return Array.from({ length: plan.partCount }, (_, i) => partRange(plan, i + 1));
}

/**
 * The parts still to send, given what the store says it already has.
 *
 * Note it trusts the store's list and nothing else. A part the browser
 * believes it sent but the store has no record of is a part that was not
 * sent — that asymmetry is the same one `confirmUpload` already applies to
 * whole objects, and for the same reason.
 */
export function remainingParts(plan: UploadPlan, uploaded: Iterable<{ partNumber: number }>): PartRange[] {
  const have = new Set<number>();
  for (const p of uploaded) have.add(p.partNumber);
  return allParts(plan).filter((p) => !have.has(p.partNumber));
}

export function uploadedBytes(plan: UploadPlan, uploaded: Iterable<{ partNumber: number }>): number {
  let total = 0;
  for (const p of uploaded) {
    if (p.partNumber >= 1 && p.partNumber <= plan.partCount) total += partRange(plan, p.partNumber).bytes;
  }
  return Math.min(total, plan.totalBytes);
}

/** 0–1, for a progress bar that does not lie about what is safely stored. */
export function uploadProgress(plan: UploadPlan, uploaded: Iterable<{ partNumber: number }>): number {
  if (plan.totalBytes <= 0) return 1;
  return Math.min(1, uploadedBytes(plan, uploaded) / plan.totalBytes);
}

/* ------------------------------------------------- uploading while recording */

export interface AccumulatedPart {
  partNumber: number;
  blobs: unknown[];
  bytes: number;
}

/**
 * Chunks in, whole parts out.
 *
 * `MediaRecorder` hands over a chunk every `timesliceMs`; this collects them
 * until there are enough bytes to be a legal part, then releases one. It
 * holds references to the chunks rather than concatenating, so nothing is
 * copied until the part is actually assembled for sending — a five-minute
 * recording is never resident twice.
 *
 * `finish()` releases whatever is left as the final part, which is the only
 * one allowed to be under the floor. Calling it twice is safe and yields
 * nothing the second time: a stop handler that fires on both `onstop` and a
 * timeout must not produce two final parts.
 */
export class PartAccumulator {
  private pending: unknown[] = [];
  private pendingBytes = 0;
  private next = 1;
  private done = false;
  private total = 0;

  constructor(private readonly partBytes: number = PART_BYTES) {}

  /** Bytes seen so far, across every part released and the one in hand. */
  get totalBytes(): number { return this.total; }
  get nextPartNumber(): number { return this.next; }
  get buffered(): number { return this.pendingBytes; }

  /** Add one recorder chunk. Returns a part when there is enough for one. */
  push(chunk: { size: number } & object): AccumulatedPart | null {
    if (this.done) throw new UploadPlanError("This upload has already been finished.");
    if (!chunk || chunk.size <= 0) return null;
    this.pending.push(chunk);
    this.pendingBytes += chunk.size;
    this.total += chunk.size;
    if (this.pendingBytes < this.partBytes) return null;
    return this.release();
  }

  /** The remainder, as the last part. Null when there is nothing left. */
  finish(): AccumulatedPart | null {
    if (this.done) return null;
    this.done = true;
    return this.pendingBytes > 0 ? this.release() : null;
  }

  private release(): AccumulatedPart {
    const part: AccumulatedPart = {
      partNumber: this.next++,
      blobs: this.pending,
      bytes: this.pendingBytes,
    };
    // Released, not copied — the caller owns these now and we must not keep
    // a second reference to several megabytes we are done with.
    this.pending = [];
    this.pendingBytes = 0;
    return part;
  }
}

/* --------------------------------------------------------------- retrying */

/**
 * How long to wait before attempt `n`, with jitter.
 *
 * Jitter is not decoration. A venue where thirty candidates interview at once
 * behind one wifi router produces thirty simultaneous failures and, without
 * it, thirty simultaneous retries — which is the same outage again, on
 * schedule, until they all give up together.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Worth trying again, or worth telling the person about? */
export function retryable(status: number | null | undefined): boolean {
  if (status == null) return true;               // a network throw: no answer at all
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

export const MAX_UPLOAD_ATTEMPTS = 6;
