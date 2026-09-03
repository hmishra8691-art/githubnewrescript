/**
 * Which saved state does a TEST link run?
 *
 * Until 2026-09-03 a test link served whatever version the test *deployment*
 * row pointed at — a third pointer beside the autosaved draft and the survey's
 * current version, moved only when "Test Survey" itself was clicked. Saving a
 * version did not move it; autosave never touched it. So a programmer who
 * saved, then opened the test link from a bookmark, an old tab or the Versions
 * panel, was shown an older build with nothing on screen to say so. The live
 * database showed it plainly: a survey with draft revision 236 and current
 * version 1.4 whose test link served 1.3.
 *
 * The rule is now one sentence: **a test link runs the latest successfully
 * saved state.** Concretely, in this order:
 *
 *   1. a version explicitly requested by the URL (`?v=<versionId>`) — this is
 *      the handshake the Studio uses: it saves, then opens exactly what it
 *      saved, and the runtime confirms it loaded that;
 *   2. otherwise the autosaved draft, if there is one — the newest work the
 *      programmer has, already persisted under a revision number;
 *   3. otherwise the survey's current version.
 *
 * Anything that cannot be loaded is an ERROR, never a fallback to something
 * older. Silently rendering an older build is the most expensive failure a
 * test link can have, because the tester believes they are looking at their
 * latest work.
 *
 * Pure: takes the rows, returns a decision. The runtime does the fetching.
 */

export interface TestBuildInput {
  /** the survey the slug resolved to */
  surveyId: string;
  /** `?v=` on the URL, if any */
  requestedVersionId?: string | null;
  /** the row's current pointers */
  currentVersionId: string | null;
  revision: number | null;
  /** the autosaved draft, already parsed (or null / a parse failure) */
  draft: { ok: true; definition: unknown; updatedAt: string | null } | { ok: false; error: string } | null;
  /** a loader result for the version we need — the caller fetches by id */
  version: { ok: true; id: string; surveyId: string; version: string; definition: unknown } | { ok: false; error: string } | null;
}

export type TestBuild =
  | {
      kind: "ok";
      source: "requested" | "draft" | "current";
      /** the version id the session is recorded against (the draft's base) */
      versionId: string;
      /** human label: "1.24" for a version, "draft" for the autosave */
      version: string;
      revision: number | null;
      definition: unknown;
      draftUpdatedAt?: string | null;
    }
  | { kind: "error"; message: string; detail: string };

const UNABLE = "Unable to load the latest saved survey version. Please retry.";

export function decideTestBuild(i: TestBuildInput): TestBuild {
  // 1. an explicit version — must exist and must belong to this survey
  if (i.requestedVersionId) {
    if (!i.version || !i.version.ok) {
      return { kind: "error", message: UNABLE, detail: `Requested version ${i.requestedVersionId} could not be loaded: ${i.version && !i.version.ok ? i.version.error : "not found"}.` };
    }
    if (i.version.id !== i.requestedVersionId) {
      return { kind: "error", message: UNABLE, detail: `Loaded version ${i.version.id} but ${i.requestedVersionId} was requested.` };
    }
    if (i.version.surveyId !== i.surveyId) {
      return { kind: "error", message: UNABLE, detail: `Version ${i.requestedVersionId} belongs to another survey.` };
    }
    return { kind: "ok", source: "requested", versionId: i.version.id, version: i.version.version, revision: i.revision, definition: i.version.definition };
  }

  // 2. the autosaved draft — a draft that will not parse is an error, not a
  //    reason to show the older version underneath it
  if (i.draft) {
    if (!i.draft.ok) {
      return { kind: "error", message: UNABLE, detail: `The autosaved draft does not match the current schema and was NOT loaded: ${i.draft.error}. The older saved version was not shown in its place.` };
    }
    if (!i.currentVersionId) {
      return { kind: "error", message: UNABLE, detail: "This survey has autosaved work but no saved version yet. Click Save version (or Test Survey) in the Studio first." };
    }
    return {
      kind: "ok", source: "draft", versionId: i.currentVersionId, version: "draft",
      revision: i.revision, definition: i.draft.definition, draftUpdatedAt: i.draft.updatedAt,
    };
  }

  // 3. the current version
  if (!i.currentVersionId) {
    return { kind: "error", message: UNABLE, detail: "This survey has no saved version yet. Click Save version (or Test Survey) in the Studio first." };
  }
  if (!i.version || !i.version.ok) {
    return { kind: "error", message: UNABLE, detail: `Current version ${i.currentVersionId} could not be loaded: ${i.version && !i.version.ok ? i.version.error : "not found"}.` };
  }
  if (i.version.id !== i.currentVersionId) {
    return { kind: "error", message: UNABLE, detail: `Loaded version ${i.version.id} but the survey's current version is ${i.currentVersionId}.` };
  }
  return { kind: "ok", source: "current", versionId: i.version.id, version: i.version.version, revision: i.revision, definition: i.version.definition };
}

/** Which version id the runtime needs to fetch for a decision, before deciding. */
export function versionIdToFetch(i: Pick<TestBuildInput, "requestedVersionId" | "currentVersionId" | "draft">): string | null {
  if (i.requestedVersionId) return i.requestedVersionId;
  if (i.draft && i.draft.ok) return null; // the draft carries its own definition
  return i.currentVersionId;
}
