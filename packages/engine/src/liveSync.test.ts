import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTestBuild, versionIdToFetch } from "./testBuild.js";

/**
 * LIVE SYNC BETWEEN STUDIO AND RUNTIME.
 *
 * The reported symptom was that a Studio change needed a runtime restart
 * before a test link would show it. Nothing was stale and no cache was at
 * fault: Studio's Test Survey appended `?v=<versionId>` to the link, that is
 * branch ONE of `decideTestBuild`, and a version is immutable by database
 * trigger. The tab was asking for a frozen snapshot and the runtime was
 * correctly giving it, however many times it was reloaded.
 *
 * Unpinned, the same link falls to branch TWO — the autosaved draft, read
 * fresh from Postgres on every request and deliberately excluded from the
 * version cache. So these tests pin the branch order itself, because the fix
 * lives entirely in which branch a test link lands on.
 */

const VERSION = {
  ok: true as const,
  id: "ver_1",
  surveyId: "svy_1",
  version: "1.4",
  definition: { marker: "the frozen version" },
};

const DRAFT = {
  ok: true as const,
  definition: { marker: "the live draft" },
  updatedAt: "2026-09-23T07:00:00.000Z",
};

const base = {
  surveyId: "svy_1",
  currentVersionId: "ver_1",
  revision: 236,
};

test("an UNPINNED test link serves the draft — this is what makes the edit loop work", () => {
  const b = decideTestBuild({ ...base, requestedVersionId: null, draft: DRAFT, version: VERSION });
  assert.equal(b.kind, "ok");
  if (b.kind !== "ok") return;
  assert.equal(b.source, "draft");
  assert.deepEqual(b.definition, DRAFT.definition, "an unpinned link must show the latest autosave");
  assert.equal(b.revision, 236, "the revision is what an open tab compares against to notice a change");
});

test("a PINNED test link still serves that exact version, and ignores a newer draft", () => {
  /*
   * The pin has to keep working: it is how you reproduce what a respondent
   * saw. What changed is that Studio no longer applies it by default.
   */
  const b = decideTestBuild({ ...base, requestedVersionId: "ver_1", draft: DRAFT, version: VERSION });
  assert.equal(b.kind, "ok");
  if (b.kind !== "ok") return;
  assert.equal(b.source, "requested");
  assert.deepEqual(b.definition, VERSION.definition, "a pinned link must not drift onto the draft");
});

test("the pin outranks the draft — the whole cause of the reported bug", () => {
  const pinned = decideTestBuild({ ...base, requestedVersionId: "ver_1", draft: DRAFT, version: VERSION });
  const unpinned = decideTestBuild({ ...base, requestedVersionId: null, draft: DRAFT, version: VERSION });
  assert.equal(pinned.kind, "ok");
  assert.equal(unpinned.kind, "ok");
  if (pinned.kind !== "ok" || unpinned.kind !== "ok") return;
  assert.notDeepEqual(pinned.definition, unpinned.definition,
    "if these were the same the pin would be harmless; they are not, which is why it had to go");
});

test("with no draft, an unpinned link falls through to the current version", () => {
  const b = decideTestBuild({ ...base, requestedVersionId: null, draft: null, version: VERSION });
  assert.equal(b.kind, "ok");
  if (b.kind !== "ok") return;
  assert.equal(b.source, "current");
});

test("a draft that will not parse is an error, never a silent older build", () => {
  const b = decideTestBuild({
    ...base, requestedVersionId: null,
    draft: { ok: false, error: "questions.4.type: invalid" },
    version: VERSION,
  });
  assert.equal(b.kind, "error", "showing the older version instead would hide the programmer's own mistake");
  if (b.kind !== "error") return;
  assert.match(b.detail, /was NOT loaded/);
});

test("the draft path never fetches a version, so it can never be served from the version cache", () => {
  /*
   * `getCachedVersionDefinition` memoises by version id for the life of the
   * process and has no invalidation — which is safe only because versions are
   * immutable. A draft must therefore never enter it, and the way that is
   * guaranteed is that the draft path asks for no version at all.
   */
  assert.equal(versionIdToFetch({ requestedVersionId: null, currentVersionId: "ver_1", draft: DRAFT }), null);
  // and the pinned and no-draft paths do fetch one
  assert.equal(versionIdToFetch({ requestedVersionId: "ver_9", currentVersionId: "ver_1", draft: DRAFT }), "ver_9");
  assert.equal(versionIdToFetch({ requestedVersionId: null, currentVersionId: "ver_1", draft: null }), "ver_1");
});

test("the revision moves with the draft, so a polling tab can tell it is behind", () => {
  const before = decideTestBuild({ ...base, revision: 236, requestedVersionId: null, draft: DRAFT, version: VERSION });
  const after = decideTestBuild({ ...base, revision: 240, requestedVersionId: null, draft: DRAFT, version: VERSION });
  assert.equal(before.kind, "ok");
  assert.equal(after.kind, "ok");
  if (before.kind !== "ok" || after.kind !== "ok") return;
  assert.ok((after.revision ?? 0) > (before.revision ?? 0),
    "the tab's 'changes available' check is a strict revision comparison; it needs this to move");
});
