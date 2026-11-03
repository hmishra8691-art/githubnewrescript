/**
 * THE PARTICIPATION LEDGER'S STATE MACHINE, and what a resolution is allowed to justify.
 *
 * The database owns atomicity (migration 0083's partial unique index). This owns the rules about which moves
 * are legal and what evidence licenses a refusal — the part that has to be readable by a person defending a
 * decision to a panel provider whose respondent was turned away.
 */

export const PARTICIPATION_STATES = [
  "invited", "verification_pending", "eligible", "reserved", "in_survey",
  "completed", "rejected", "duplicate", "quarantined", "expired",
] as const;
export type ParticipationState = (typeof PARTICIPATION_STATES)[number];

/** Once here, a participation does not move again. Settling one is a no-op rather than an error. */
export const TERMINAL_STATES: readonly ParticipationState[] = ["completed", "rejected", "duplicate", "expired"];

/**
 * States that hold a person's place in a project. A participation in any of these means the person is in, and
 * a second arrival contends with it; the others are free.
 *
 * `quarantined` is deliberately here: somebody held for fraud review has not been cleared, and letting them
 * back in through a second vendor while the review is open would make the review pointless.
 */
export const LIVE_STATES: readonly ParticipationState[] = [
  "invited", "verification_pending", "eligible", "reserved", "in_survey", "completed", "quarantined",
];

const TRANSITIONS: Readonly<Record<ParticipationState, readonly ParticipationState[]>> = Object.freeze({
  invited:              ["verification_pending", "eligible", "reserved", "expired", "rejected"],
  verification_pending: ["eligible", "reserved", "rejected", "quarantined", "expired"],
  eligible:             ["reserved", "rejected", "quarantined", "expired"],
  reserved:             ["in_survey", "completed", "rejected", "duplicate", "quarantined", "expired"],
  in_survey:            ["completed", "rejected", "quarantined", "expired"],
  // terminal
  completed:            [],
  rejected:             [],
  duplicate:            [],
  expired:              [],
  // a quarantine is resolved by a human, either way
  quarantined:          ["eligible", "rejected"],
});

export function isTerminal(state: ParticipationState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isLive(state: ParticipationState): boolean {
  return LIVE_STATES.includes(state);
}

export function canTransition(from: ParticipationState, to: ParticipationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The legal next states, for a UI that must not offer an impossible one. */
export function nextStates(from: ParticipationState): readonly ParticipationState[] {
  return TRANSITIONS[from];
}

/* ------------------------------------------------------------ what evidence licenses */

export type Resolution = "deterministic" | "probabilistic" | "vendor_scoped";
export type DedupeMode = "off" | "shadow" | "enforce";

export interface AdmissionInput {
  mode: DedupeMode;
  /** how THIS ARRIVAL was matched — not how well the identity is known overall */
  resolution: Resolution;
  confidence: number;
  /** true when somebody already holds this person's place in this project */
  wouldBlock: boolean;
  heldState?: ParticipationState | null;
  /**
   * The confidence a probabilistic match must reach before it may refuse anybody. Deliberately high and
   * deliberately configurable: the cost of being wrong is a real person losing a paid piece of work.
   */
  probabilisticThreshold?: number;
}

export interface AdmissionDecision {
  /** let them in */
  admit: boolean;
  /** this arrival would have been refused if enforcement were on */
  wouldBlock: boolean;
  /** why, in words a person can repeat to a vendor */
  reason: string;
  /** a machine-readable code for the vendor redirect and the dashboards */
  code: "admitted" | "duplicate" | "already_completed" | "under_review" | "observed_only" | "not_checked";
}

export const DEFAULT_PROBABILISTIC_THRESHOLD = 85;

/**
 * Whether to admit this arrival.
 *
 * Three rules, in order, and each exists because the alternative is a real harm:
 *
 *   1. SHADOW MODE NEVER REFUSES. It records. Until a false-positive rate has been measured on real traffic,
 *      refusing people is a guess with somebody else's earnings.
 *   2. A PROBABILISTIC MATCH BELOW THE THRESHOLD NEVER REFUSES, even under enforcement. A household behind one
 *      router sharing one tablet produces a very confident-looking match and is two people.
 *   3. EVERYTHING ELSE IS EXPLAINED. "Already completed" and "duplicate" are different facts to a vendor
 *      reconciling its invoice, so they are different codes.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const threshold = input.probabilisticThreshold ?? DEFAULT_PROBABILISTIC_THRESHOLD;

  if (input.mode === "off") {
    return { admit: true, wouldBlock: false, reason: "Deduplication is off for this project.", code: "not_checked" };
  }
  if (!input.wouldBlock) {
    return { admit: true, wouldBlock: false, reason: "No earlier participation by this person in this project.", code: "admitted" };
  }

  const weak = input.resolution === "probabilistic" && input.confidence < threshold;
  const held = input.heldState ?? null;

  if (input.mode === "shadow") {
    return {
      admit: true,
      wouldBlock: !weak,
      reason: weak
        ? `Observed only: a ${input.confidence}% circumstantial match to an existing participation, below the ${threshold}% needed to refuse anyone.`
        : `Observed only: this would have been refused as a duplicate of a ${held ?? "live"} participation. Shadow mode refuses nobody.`,
      code: "observed_only",
    };
  }

  if (weak) {
    return {
      admit: true,
      wouldBlock: false,
      reason: `A ${input.confidence}% circumstantial match is not enough to refuse a respondent; admitted and flagged for review.`,
      code: "admitted",
    };
  }

  if (held === "completed") {
    return { admit: false, wouldBlock: true, reason: "This person has already completed this study.", code: "already_completed" };
  }
  if (held === "quarantined") {
    return { admit: false, wouldBlock: true, reason: "This person's participation in this study is under review.", code: "under_review" };
  }
  return { admit: false, wouldBlock: true, reason: "This person is already taking part in this study.", code: "duplicate" };
}

/**
 * The honest headline for a project's final report.
 *
 * The brief's acceptance criterion asks for "zero accepted duplicate completes". What can truthfully be said is
 * narrower, and this is the sentence that says it — deterministic prevention where identity was available,
 * circumstantial detection elsewhere, and the number of arrivals nothing could be said about at all.
 */
export function deduplicationStatement(counts: {
  accepted: number; deterministicBlocks: number; probabilisticBlocks: number; observedOnly: number; unresolved: number;
}): string {
  const parts = [
    `${counts.accepted.toLocaleString()} accepted completes`,
    `${counts.deterministicBlocks.toLocaleString()} duplicate attempts refused on a certain match`,
  ];
  if (counts.probabilisticBlocks > 0) parts.push(`${counts.probabilisticBlocks.toLocaleString()} on a circumstantial one`);
  if (counts.observedOnly > 0) parts.push(`${counts.observedOnly.toLocaleString()} further suspected duplicates observed but admitted`);
  if (counts.unresolved > 0) {
    parts.push(
      `${counts.unresolved.toLocaleString()} arrivals could not be linked to any identity beyond the vendor that ` +
      "sent them, so cross-vendor duplication among those cannot be ruled out",
    );
  }
  return parts.join("; ") + ".";
}
