import { planUpload } from "@rescript/storage/upload";

/** The shape the store agrees a part has. Mirrored rather than imported so this
 *  module stays free of the Node-only storage barrel. */
export interface CompletedPart { partNumber: number; etag: string }

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
  /** the size declared at `begin`; how many parts are owed */
  declaredBytes: number | null;
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

  if (known && known.length && check.declaredBytes) {
    const expected = planUpload(Number(check.declaredBytes)).partCount;
    if (known.length < expected) {
      return { ok: false, code: "short", have: known.length, expected, resumable: true };
    }
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
