/**
 * WHO IS IN A RECORDING — the rules, with no database in them.
 *
 * `0033_interview_participants.sql` holds the shape: people once per project,
 * presences once per recording. This file holds the judgements that have to be
 * made before a row is written and after one is read, and it holds them once
 * so the API route, the recorder UI and the transcript view cannot disagree
 * about who somebody is.
 *
 * Two of those judgements are worth naming.
 *
 * **Is this the same person?** §9 of the brief asks that adding an interviewer
 * who already exists selects them rather than creating a duplicate. The answer
 * is not "same name": two people share a name, one person spells theirs three
 * ways, and a study that ran for six months will have both. So identity is an
 * account first and an email second, and a person with neither is not
 * deduplicable — which is a fact about the situation, not a gap to paper over
 * with fuzzy matching that will one day merge two real people.
 *
 * **Which voice is this?** A diarizing provider returns anonymous labels. The
 * mapping from "Speaker 1" to a person is a judgement somebody makes, and §12
 * requires that an uncertain one is preserved as uncertain rather than guessed.
 * So an unmapped label stays unmapped and is rendered as itself; nothing here
 * infers a person from a position, a count, or who usually talks first.
 */

/* --------------------------------------------------------------- roles */

/**
 * The roles a person can hold IN a recording.
 *
 * `interviewer` and `respondent` are what the product needs. The other three
 * are listed because qualitative fieldwork has all of them and finding that
 * out later should be a UI change rather than a migration — an interpreter in
 * the room is a speaker in the transcript whether or not the schema expected
 * one.
 */
export const PARTICIPANT_ROLES = [
  "interviewer",
  "respondent",
  "observer",
  "interpreter",
  "note_taker",
] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export function isParticipantRole(v: unknown): v is ParticipantRole {
  return typeof v === "string" && (PARTICIPANT_ROLES as readonly string[]).includes(v);
}

/** What a researcher is shown. Sentence case, because these appear inline. */
export const ROLE_SAY: Record<ParticipantRole, string> = {
  interviewer: "Interviewer",
  respondent: "Respondent",
  observer: "Observer",
  interpreter: "Interpreter",
  note_taker: "Note taker",
};

/** Interviewers first, then the respondent, then everyone else — reading order. */
const ROLE_ORDER: Record<ParticipantRole, number> = {
  interviewer: 0,
  respondent: 1,
  interpreter: 2,
  observer: 3,
  note_taker: 4,
};

/* -------------------------------------------------------------- people */

export interface Person {
  id: string;
  displayName: string;
  email?: string | null;
  /** the Rescript account, when this person has one */
  userId?: string | null;
  kind?: ParticipantRole;
  /** true for the respondent row the database mirrors from the interview */
  derived?: boolean;
  archivedAt?: string | null;
}

export interface Participant extends Person {
  role: ParticipantRole;
  /** the provider's anonymous label, once somebody has said which voice this is */
  speakerLabel?: string | null;
}

/**
 * The key two records must share to be the same person.
 *
 * An account beats an email, because an email can be reassigned and an account
 * cannot. Returning null means "not deduplicable" — a name alone is not
 * identity, and treating it as one is how two Amits become one.
 */
export function identityKey(p: {
  userId?: string | null;
  email?: string | null;
}): string | null {
  if (p.userId) return `user:${p.userId}`;
  const email = (p.email ?? "").trim().toLowerCase();
  return email ? `email:${email}` : null;
}

/**
 * EVERY key a person answers to, not just their strongest.
 *
 * `identityKey` picks one so a roster can be deduplicated deterministically.
 * Matching needs the other one too: somebody added by account also has an
 * email, and looking them up by that email must find them. Comparing single
 * canonical keys misses exactly that case — and the duplicate it creates is
 * the one §9 is about, an interviewer appearing twice because a colleague
 * typed their address instead of picking them from the list.
 */
export function identityKeys(p: {
  userId?: string | null;
  email?: string | null;
}): string[] {
  const keys: string[] = [];
  if (p.userId) keys.push(`user:${p.userId}`);
  const email = (p.email ?? "").trim().toLowerCase();
  if (email) keys.push(`email:${email}`);
  return keys;
}

/**
 * The person on this roster who is already the one being added, or null.
 *
 * Used before creating: §9 asks that an existing Rescript user is SELECTED
 * rather than duplicated. Archived people are skipped — somebody removed them
 * on purpose, and silently resurrecting them would undo that decision without
 * saying so.
 */
export function findExistingPerson(
  candidate: { userId?: string | null; email?: string | null },
  roster: readonly Person[],
): Person | null {
  const wanted = identityKeys(candidate);
  if (wanted.length === 0) return null;
  return roster.find(
    (p) => !p.archivedAt && identityKeys(p).some((k) => wanted.includes(k)),
  ) ?? null;
}

/**
 * Collapse a roster that already contains duplicates.
 *
 * The first occurrence wins, because a roster arrives in creation order and
 * the earliest row is the one other tables already point at. People with no
 * identity key are all kept: they are not known to be duplicates, and
 * discarding them on a name match would delete a real second Amit.
 */
export function dedupePeople(people: readonly Person[]): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of people) {
    const key = identityKey(p);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(p);
  }
  return out;
}

/* -------------------------------------------------- a recording's list */

export interface ParticipantProblem {
  code: "unknown_role" | "duplicate_person" | "no_participants" | "no_respondent" | "many_respondents";
  message: string;
  personId?: string;
}

/**
 * What is wrong with a proposed participant list — advisory and blocking
 * problems kept apart, because they are answered by different people.
 *
 * A list with no respondent is ODD, not invalid: a recording of two
 * researchers discussing a study is a legitimate thing to keep. So that is a
 * warning the UI can show and the researcher can ignore, while a duplicate
 * person or an unknown role is a refusal — those are bugs in the caller, and
 * accepting them writes a list nobody can render.
 */
export function checkParticipants(list: readonly { personId: string; role: string }[]): {
  errors: ParticipantProblem[];
  warnings: ParticipantProblem[];
} {
  const errors: ParticipantProblem[] = [];
  const warnings: ParticipantProblem[] = [];

  const seen = new Set<string>();
  for (const p of list) {
    if (!isParticipantRole(p.role)) {
      errors.push({
        code: "unknown_role",
        message: `"${p.role}" is not a participant role.`,
        personId: p.personId,
      });
    }
    if (seen.has(p.personId)) {
      errors.push({
        code: "duplicate_person",
        message: "The same person is listed twice in this recording.",
        personId: p.personId,
      });
    }
    seen.add(p.personId);
  }

  if (list.length === 0) {
    warnings.push({
      code: "no_participants",
      message: "Nobody is listed in this recording. Transcripts will have no one to attribute.",
    });
  }

  const respondents = list.filter((p) => p.role === "respondent");
  if (list.length > 0 && respondents.length === 0) {
    warnings.push({
      code: "no_respondent",
      message: "No respondent is listed. That is fine for a briefing or a debrief.",
    });
  }
  if (respondents.length > 1) {
    warnings.push({
      code: "many_respondents",
      message: "More than one respondent is listed. Check this is a group session.",
    });
  }

  return { errors, warnings };
}

/** Reading order: interviewers, respondent, then the rest; alphabetical inside each. */
export function sortParticipants(list: readonly Participant[]): Participant[] {
  return [...list].sort((a, b) => {
    const d = (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9);
    return d !== 0 ? d : a.displayName.localeCompare(b.displayName);
  });
}

/**
 * One line naming who is in a recording.
 *
 * For a card, a list row, an export header. Deliberately not "3 participants":
 * the names are the useful part, and a count is what a UI shows when nobody
 * thought about what the researcher is looking for.
 */
export function describeParticipants(list: readonly Participant[]): string {
  if (list.length === 0) return "Nobody listed";
  const sorted = sortParticipants(list);
  const names = sorted.map((p) => p.displayName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* ------------------------------------------------------ speaker labels */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** the provider's own anonymous label, e.g. "Speaker 1" */
  speaker?: string | null;
}

/**
 * Which anonymous labels this transcript actually contains.
 *
 * The provider decides how many voices it heard, and that number routinely
 * disagrees with how many people the researcher listed — a door slamming
 * becomes Speaker 3, two interviewers with similar voices become one. So the
 * labels come from the transcript rather than from the participant list.
 */
export function speakersInTranscript(segments: readonly TranscriptSegment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    const label = (s.speaker ?? "").trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out.sort();
}

/** label → the participant somebody has mapped it to. Unmapped labels are absent. */
export function speakerMap(list: readonly Participant[]): Map<string, Participant> {
  const m = new Map<string, Participant>();
  for (const p of list) {
    const label = (p.speakerLabel ?? "").trim();
    if (label) m.set(label, p);
  }
  return m;
}

/**
 * The labels nobody has attributed yet.
 *
 * This is the number a review screen should show, because it is the work
 * remaining. An empty result means every voice in the transcript has a name.
 */
export function unmappedSpeakers(
  segments: readonly TranscriptSegment[],
  list: readonly Participant[],
): string[] {
  const mapped = speakerMap(list);
  return speakersInTranscript(segments).filter((l) => !mapped.has(l));
}

/**
 * What to show above a line of transcript.
 *
 * An unmapped label is rendered AS THE LABEL — "Speaker 2" — never as a guess
 * and never as an empty string. §12: where identification is uncertain, do not
 * silently assign an identity. A reader seeing "Speaker 2" knows the machine
 * heard someone and nobody has said who; a reader seeing a name is being told
 * something nobody checked.
 */
export function attributeSegment(
  segment: TranscriptSegment,
  list: readonly Participant[],
): { label: string; person: Participant | null; certain: boolean } {
  const raw = (segment.speaker ?? "").trim();
  if (!raw) {
    /*
     * No diarization at all. With exactly one participant there is only one
     * person it can be, and saying so is not a guess — it is the only reading.
     * With more, it is unknown, and unknown is what gets shown.
     */
    if (list.length === 1) return { label: list[0].displayName, person: list[0], certain: true };
    return { label: "Unattributed", person: null, certain: false };
  }
  const person = speakerMap(list).get(raw) ?? null;
  return person
    ? { label: person.displayName, person, certain: true }
    : { label: raw, person: null, certain: false };
}

/**
 * How far the attribution work has got, for a progress line.
 *
 * `total` is voices in the transcript, not people in the room: the researcher's
 * job is to account for what was heard.
 */
export function attributionProgress(
  segments: readonly TranscriptSegment[],
  list: readonly Participant[],
): { mapped: number; total: number; done: boolean } {
  const total = speakersInTranscript(segments).length;
  const mapped = total - unmappedSpeakers(segments, list).length;
  return { mapped, total, done: total > 0 && mapped === total };
}
