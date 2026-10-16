/**
 * ARRIVAL ORDER (CLEAN-09). Every "this response matches somebody else"
 * rule used to be symmetric: the original and its copy each saw the other,
 * both were flagged, and both left the clean dataset. The convention now:
 * a response is a copy of the responses that ARRIVED BEFORE it, and only of
 * those. The earlier one is the original and is not penalised for the
 * later one existing.
 */

import type { FlagDraft, PeerRecord } from "./types.js";

/**
 * When a response arrived: completion time, else start time, as epoch ms.
 * Null when neither is a parseable date — order is then unknown.
 */
function arrivalMs(r: { completedAt?: string | null; startedAt?: string | null }): number | null {
  for (const v of [r.completedAt, r.startedAt]) {
    if (!v) continue;
    const t = new Date(v).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * True when `me` arrived strictly before `peer` (CLEAN-09). Equal timestamps
 * are broken by session id so that for any pair exactly ONE of them is the
 * earlier — a tie must not bring the symmetric both-dropped outcome back.
 * Unknown order (a missing or unparseable timestamp) is "not earlier": the
 * response keeps the flag, which is the conservative reading.
 */
export function arrivedBefore(me: { sessionId: string; completedAt?: string | null; startedAt?: string | null }, peer: { sessionId: string; completedAt?: string | null; startedAt?: string | null }): boolean {
  const a = arrivalMs(me), b = arrivalMs(peer);
  if (a === null || b === null) return false;
  if (a !== b) return a < b;
  return me.sessionId < peer.sessionId;
}


/** The flags that say "this response matches somebody else" — the ones that are symmetric by nature. */
export const PEER_MATCH_RULES: ReadonlySet<string> = new Set(["duplicate.answers", "duplicate.multi_signal", "openend.duplicate", "matrix.signature_match", "timing.pattern_match"]);

const ORIGINAL_NOTE = "this is the earlier of the matching responses — the later copy carries the exclusion flag and this one is kept by arrival order; review the pair if both could be genuine";

/**
 * Apply the arrival-order convention to one response's flag drafts.
 *
 * A peer-match flag whose related responses ALL arrived after this one marks
 * this response as the ORIGINAL: the flag stays on the record as evidence but
 * becomes informational, so it is shown and reviewable and does not exclude
 * the response from the clean dataset. The later copy still carries the
 * classifying flag — so exactly one of a duplicate pair is left out, not both.
 *
 * It does not apply when the response is part of a coordinated cluster
 * (`cluster.coordinated` fired): a ring is suspicious as a whole, and its
 * first member is not an "original". And a flag with no related ids, or one
 * naming a peer whose arrival cannot be compared, is left exactly as it was.
 */
export function applyArrivalOrder(drafts: FlagDraft[], me: { sessionId: string; completedAt?: string | null; startedAt?: string | null }, peers: PeerRecord[]): FlagDraft[] {
  if (drafts.some((d) => d.ruleId === "cluster.coordinated")) return drafts;
  const byId = new Map(peers.map((p) => [p.sessionId, p]));
  return drafts.map((d) => {
    if (!PEER_MATCH_RULES.has(d.ruleId)) return d;
    const related = d.relatedSessionIds ?? [];
    if (!related.length) return d;
    const allLater = related.every((id) => {
      const p = byId.get(id);
      return !!p && arrivedBefore(me, p);
    });
    if (!allLater) return d;
    return { ...d, original: true, role: "informational" as const, caveat: d.caveat ? `${d.caveat}; ${ORIGINAL_NOTE}` : ORIGINAL_NOTE };
  });
}
