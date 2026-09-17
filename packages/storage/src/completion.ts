
import type { CompletedPart } from "./provider.js";

/**
 * MAY THIS RECORDING BE CALLED SAVED?
 *
 * The decision, with no HTTP and no database in it, so it can be exercised
 * against a real object store in Node and shared by both upload paths — the
 * candidate answering alone and the interviewer recording a moderated session.
 *
 * ## Why this is a separate thing at all
 *
 * A real bug lived in the version that did not exist. The completion assembled
 * whatever parts happened to be in the store and marked the recording stored.
 * A truncated video plays perfectly well, so the candidate saw "Saved", the
 * researcher saw a recording, and the missing four minutes were discovered by
 * nobody. The fix is the `short` verdict below, and the reason it is here
 * rather than in a route is that two copies of it are two chances to lose it.
 *
 * ## The order is the point
 *
 * `short` is decided BEFORE anything is assembled, because assembling first
 * and checking afterwards leaves a truncated object in the bucket that some
 * later retry will find and trust. `absent` is decided after, from a HEAD
 * against the real store, because the store's own word is the only evidence
 * that the bytes exist — the client's is a claim about a network it cannot
 * see the end of.
 */

export type CompletionVerdict =
  | { ok: true; parts: CompletedPart[] | null }
  /** the store holds fewer parts than the declared size implies */
  | { ok: false; code: "short"; have: number; expected: number; resumable: true }
  /** nothing arrived at all */
  | { ok: false; code: "empty"; resumable: true }
  /** the object is not there, or is zero bytes, after the store said it completed */
  | { ok: false; code: "absent"; resumable: true };

export interface CompletionCheck {
  /** null for a single PUT, which has no parts and nothing to assemble */
  multipartUploadId: string | null;
  /** what the store says it holds; null when the store has forgotten the upload */
  knownParts: readonly CompletedPart[] | null;
  /** what the browser says it sent — used only when the store cannot say */
  claimedParts: readonly CompletedPart[];
  /**
   * The size declared at `begin`.
   *
   * CAPACITY, NOT A TARGET. It is `expectedBytes(maxSeconds)` — what a
   * recording of the maximum permitted length would occupy, plus a margin —
   * so it sizes the plan and the storage-cap check and says nothing whatever
   * about how long the answer actually was. It used to be divided into a part
   * count and compared with what arrived, which meant every recording that
   * ran anywhere near its limit was declared `short` and refused: the margin
   * alone guaranteed the comparison could never pass.
   */
  declaredBytes: number | null;
  /**
   * How many parts the recording actually produced, as counted by the
   * browser that produced them.
   *
   * This is the only honest completeness target, and it is a claim about the
   * client's own output rather than about the network — the thing the client
   * is the authority on. It cannot be used to wave an upload through: a
   * client that under-reports simply assembles fewer parts, and the HEAD
   * afterwards still has to find a non-empty object.
   */
  partsReleased?: number | null;
}

/**
 * Decide whether the parts in hand are enough to assemble.
 *
 * `knownParts: null` means the store could not be asked — an upload old enough
 * that it has been forgotten. That is not evidence of a short recording, so it
 * falls through to the browser's list rather than refusing: refusing here would
 * fail a legitimate late completion, and the HEAD afterwards still has to pass.
 */
export function checkBeforeAssembly(check: CompletionCheck): CompletionVerdict {
  if (!check.multipartUploadId) return { ok: true, parts: null };

  const known = check.knownParts;

  /*
   * Short against WHAT THE RECORDING PRODUCED — never against the allowance.
   *
   * The target is `partsReleased` — a STATED count of what the recorder
   * produced — or there is no count check. Nothing is inferred, and the two
   * things this used to infer from are both wrong in their own way:
   *
   *   · the declared size is the bytes a recording of the MAXIMUM permitted
   *     length would occupy plus a 15% margin, so measuring a real answer
   *     against it refused every real answer;
   *   · the claimed part list is tolerant of junk — a client presenting a
   *     part number the store never issued would inflate the target and be
   *     refused for it.
   *
   * A stated count cannot wave an upload through: under-report and fewer
   * parts assemble, and the HEAD afterwards still has to find a non-empty
   * object. Over-report — the case this check was written for, where a part
   * returned 200 and then was not there — and the upload is correctly refused
   * and resumed.
   */
  const stated = Number(check.partsReleased);
  const target = Number.isFinite(stated) ? stated : 0;
  if (known && known.length && target > 0 && known.length < target) {
    return { ok: false, code: "short", have: known.length, expected: target, resumable: true };
  }

  const use = known && known.length ? [...known] : [...check.claimedParts];
  if (!use.length) return { ok: false, code: "empty", resumable: true };

  return { ok: true, parts: use };
}

/**
 * The store's own answer about the finished object.
 *
 * Zero bytes is absence wearing a different hat: S3 will happily hold an empty
 * object, and an empty recording is not a recording.
 */
export function checkAfterAssembly(
  meta: { size: number; contentType: string | null } | null,
): { ok: true; size: number; contentType: string | null } | { ok: false; code: "absent"; resumable: true } {
  if (!meta || !Number.isFinite(meta.size) || meta.size <= 0) {
    return { ok: false, code: "absent", resumable: true };
  }
  return { ok: true, size: meta.size, contentType: meta.contentType };
}

/**
 * What the person on the other end is told.
 *
 * Deliberately not the internal reason. "only 3 of 5 parts reached storage" is
 * for the row and the log; a candidate gets a sentence that says what happened
 * and what to do, and every one of these is resumable, so none of them says
 * anything was lost.
 */
export const COMPLETION_SAY: Record<"short" | "empty" | "absent", string> = {
  short: "Part of your recording did not reach us. Please try again.",
  empty: "None of your recording reached us. Please try again.",
  absent: "Your recording did not reach us. Please try again.",
};

/** What the row records, so a support question has an answer months later. */
export function completionReason(v: Extract<CompletionVerdict, { ok: false }>): string {
  switch (v.code) {
    case "short": return `only ${v.have} of ${v.expected} parts reached storage`;
    case "empty": return "no parts reached storage";
    case "absent": return "the object is not in the store after upload";
  }
}
