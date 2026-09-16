import test from "node:test";
import assert from "node:assert/strict";
import {
  attributeSegment, attributionProgress, checkParticipants, dedupePeople,
  describeParticipants, findExistingPerson, identityKey, isParticipantRole,
  sortParticipants, speakerMap, speakersInTranscript, unmappedSpeakers,
  type Participant, type Person,
} from "./participants.js";

const person = (id: string, displayName: string, extra: Partial<Person> = {}): Person =>
  ({ id, displayName, ...extra });
const part = (id: string, displayName: string, role: Participant["role"], extra: Partial<Participant> = {}): Participant =>
  ({ id, displayName, role, ...extra });

/* ================================================================ identity */

test("an account is identity; an email is a fallback", () => {
  assert.equal(identityKey({ userId: "u1", email: "a@b.test" }), "user:u1");
  assert.equal(identityKey({ email: "a@b.test" }), "email:a@b.test");
});

test("email identity is case- and space-insensitive, because people are", () => {
  assert.equal(identityKey({ email: "  Rahul@Study.Invalid " }), "email:rahul@study.invalid");
});

test("A NAME IS NOT IDENTITY", () => {
  /*
   * The assertion that stops two real people being merged. Fuzzy name matching
   * would pass a naive test suite and one day silently combine two Amits.
   */
  assert.equal(identityKey({}), null);
  assert.equal(identityKey({ email: "" }), null);
  assert.equal(identityKey({ email: "   " }), null);
});

test("adding a colleague who already exists finds them instead of duplicating", () => {
  const roster = [person("p1", "Rahul Sharma", { userId: "u1", email: "rahul@study.invalid" })];
  assert.equal(findExistingPerson({ userId: "u1" }, roster)?.id, "p1");
  assert.equal(findExistingPerson({ email: "RAHUL@STUDY.INVALID" }, roster)?.id, "p1");
});

test("somebody genuinely new is not matched to anybody", () => {
  const roster = [person("p1", "Rahul Sharma", { userId: "u1" })];
  assert.equal(findExistingPerson({ userId: "u2" }, roster), null);
  assert.equal(findExistingPerson({ email: "priya@study.invalid" }, roster), null);
  /* and a bare name matches nothing, however similar */
  assert.equal(findExistingPerson({}, roster), null);
});

test("an archived person is not resurrected by adding them again", () => {
  const roster = [person("p1", "Rahul", { userId: "u1", archivedAt: "2026-01-01" })];
  assert.equal(findExistingPerson({ userId: "u1" }, roster), null,
    "somebody removed them on purpose; reusing the row would undo that silently");
});

test("dedupe keeps the first of each identity and all the unidentifiable", () => {
  const out = dedupePeople([
    person("p1", "Rahul", { userId: "u1" }),
    person("p2", "R. Sharma", { userId: "u1" }),
    person("p3", "Freelance A"),
    person("p4", "Freelance B"),
  ]);
  assert.deepEqual(out.map((p) => p.id), ["p1", "p3", "p4"]);
});

/* ============================================================ the list */

test("roles are checked, not trusted", () => {
  assert.equal(isParticipantRole("interviewer"), true);
  assert.equal(isParticipantRole("respondent"), true);
  assert.equal(isParticipantRole("moderator"), false);
  assert.equal(isParticipantRole(null), false);
});

test("a duplicate person in one recording is an error", () => {
  const { errors } = checkParticipants([
    { personId: "p1", role: "interviewer" },
    { personId: "p1", role: "respondent" },
  ]);
  assert.equal(errors.some((e) => e.code === "duplicate_person"), true);
});

test("an unknown role is an error", () => {
  const { errors } = checkParticipants([{ personId: "p1", role: "moderator" }]);
  assert.equal(errors[0]?.code, "unknown_role");
});

test("a recording with no respondent is a WARNING, not a refusal", () => {
  /*
   * Two researchers debriefing is a real recording somebody wants to keep.
   * Refusing it would be the schema having an opinion about fieldwork.
   */
  const { errors, warnings } = checkParticipants([
    { personId: "p1", role: "interviewer" },
    { personId: "p2", role: "interviewer" },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(warnings.some((w) => w.code === "no_respondent"), true);
});

test("an empty list warns but does not block", () => {
  const { errors, warnings } = checkParticipants([]);
  assert.deepEqual(errors, []);
  assert.equal(warnings[0]?.code, "no_participants");
});

test("a valid multi-interviewer list is clean", () => {
  const { errors, warnings } = checkParticipants([
    { personId: "p1", role: "interviewer" },
    { personId: "p2", role: "interviewer" },
    { personId: "p3", role: "respondent" },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("interviewers read first, then the respondent, alphabetical inside", () => {
  const sorted = sortParticipants([
    part("p3", "Respondent 001", "respondent"),
    part("p2", "Priya Patel", "interviewer"),
    part("p4", "An Observer", "observer"),
    part("p1", "Amit Kumar", "interviewer"),
  ]);
  assert.deepEqual(sorted.map((p) => p.displayName),
    ["Amit Kumar", "Priya Patel", "Respondent 001", "An Observer"]);
});

test("the one-line description names people rather than counting them", () => {
  assert.equal(describeParticipants([]), "Nobody listed");
  assert.equal(describeParticipants([part("p1", "Rahul", "interviewer")]), "Rahul");
  assert.equal(
    describeParticipants([part("p1", "Rahul", "interviewer"), part("p2", "Resp", "respondent")]),
    "Rahul and Resp");
  assert.equal(
    describeParticipants([
      part("p1", "Rahul", "interviewer"),
      part("p2", "Priya", "interviewer"),
      part("p3", "Resp", "respondent"),
    ]),
    "Priya, Rahul and Resp");
});

/* ====================================================== speaker labels */

const segs = [
  { start: 0, end: 4, text: "So tell me about your morning.", speaker: "Speaker 1" },
  { start: 4, end: 20, text: "I usually get up at six.", speaker: "Speaker 2" },
  { start: 20, end: 24, text: "And then?", speaker: "Speaker 3" },
];

test("the labels come from the transcript, not from the participant list", () => {
  /*
   * The provider decides how many voices it heard, and it routinely disagrees
   * with the room: a door becomes Speaker 3, two similar voices become one.
   */
  assert.deepEqual(speakersInTranscript(segs), ["Speaker 1", "Speaker 2", "Speaker 3"]);
});

test("segments with no speaker contribute no labels", () => {
  assert.deepEqual(speakersInTranscript([{ start: 0, end: 1, text: "x" }]), []);
  assert.deepEqual(speakersInTranscript([{ start: 0, end: 1, text: "x", speaker: "  " }]), []);
});

test("unmapped speakers are the work remaining", () => {
  const list = [part("p1", "Rahul", "interviewer", { speakerLabel: "Speaker 1" })];
  assert.deepEqual(unmappedSpeakers(segs, list), ["Speaker 2", "Speaker 3"]);
});

test("AN UNMAPPED VOICE IS SHOWN AS ITSELF, NEVER GUESSED", () => {
  /*
   * §12, and the assertion that matters most in this file. Rendering a name
   * over a voice nobody identified tells the reader something nobody checked.
   */
  const list = [
    part("p1", "Rahul Sharma", "interviewer", { speakerLabel: "Speaker 1" }),
    part("p2", "Respondent 001", "respondent"),
  ];
  const a = attributeSegment(segs[0], list);
  assert.equal(a.label, "Rahul Sharma");
  assert.equal(a.certain, true);

  const b = attributeSegment(segs[1], list);
  assert.equal(b.label, "Speaker 2", "an unmapped label renders as the label");
  assert.equal(b.person, null);
  assert.equal(b.certain, false);
});

test("with only one participant there is nothing to guess between", () => {
  const list = [part("p1", "Rahul", "interviewer")];
  const a = attributeSegment({ start: 0, end: 1, text: "x" }, list);
  assert.equal(a.label, "Rahul");
  assert.equal(a.certain, true);
});

test("with several participants and no diarization, nobody is named", () => {
  const list = [part("p1", "Rahul", "interviewer"), part("p2", "Priya", "interviewer")];
  const a = attributeSegment({ start: 0, end: 1, text: "x" }, list);
  assert.equal(a.label, "Unattributed");
  assert.equal(a.person, null);
  assert.equal(a.certain, false);
});

test("the speaker map ignores blank labels rather than mapping the empty string", () => {
  const m = speakerMap([
    part("p1", "Rahul", "interviewer", { speakerLabel: "  " }),
    part("p2", "Priya", "interviewer", { speakerLabel: "Speaker 2" }),
  ]);
  assert.equal(m.has(""), false);
  assert.equal(m.get("Speaker 2")?.displayName, "Priya");
});

test("progress counts voices heard, not people in the room", () => {
  const list = [
    part("p1", "Rahul", "interviewer", { speakerLabel: "Speaker 1" }),
    part("p2", "Priya", "interviewer"),
    part("p3", "Resp", "respondent"),
  ];
  const p = attributionProgress(segs, list);
  assert.deepEqual({ mapped: p.mapped, total: p.total, done: p.done },
    { mapped: 1, total: 3, done: false });
});

test("progress is done only when every heard voice has a name", () => {
  const list = [
    part("p1", "Rahul", "interviewer", { speakerLabel: "Speaker 1" }),
    part("p2", "Resp", "respondent", { speakerLabel: "Speaker 2" }),
    part("p3", "Priya", "interviewer", { speakerLabel: "Speaker 3" }),
  ];
  assert.equal(attributionProgress(segs, list).done, true);
});

test("a transcript with no diarization is not 'done' — there was nothing to map", () => {
  const plain = [{ start: 0, end: 1, text: "x" }];
  assert.equal(attributionProgress(plain, []).done, false);
  assert.equal(attributionProgress(plain, []).total, 0);
});
