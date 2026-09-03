import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTestBuild, versionIdToFetch } from "./testBuild.js";

/*
 * The rule a test link follows: the latest successfully saved state, and an
 * ERROR — never an older build — when that cannot be loaded.
 */

const S = "survey-1";
const v = (id: string, version: string, surveyId = S) => ({ ok: true as const, id, surveyId, version, definition: { meta: { version } } });
const draft = (updatedAt = "2026-09-03T16:11:00Z") => ({ ok: true as const, definition: { meta: { version: "draft" } }, updatedAt });

test("an explicitly requested version wins — the Studio's handshake", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: "v24", currentVersionId: "v23", revision: 9, draft: draft(), version: v("v24", "1.24") });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") { assert.equal(r.source, "requested"); assert.equal(r.version, "1.24"); assert.equal(r.versionId, "v24"); }
});

test("a requested version that does not exist is an error, not the current version", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: "v99", currentVersionId: "v23", revision: 9, draft: null, version: null });
  assert.equal(r.kind, "error");
  if (r.kind === "error") assert.match(r.detail, /v99 could not be loaded/);
});

test("a requested version belonging to another survey is refused", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: "vX", currentVersionId: "v23", revision: 9, draft: null, version: v("vX", "3.1", "other-survey") });
  assert.equal(r.kind, "error");
  if (r.kind === "error") assert.match(r.detail, /another survey/);
});

test("a loader that returns a different version than requested is caught", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: "v24", currentVersionId: "v23", revision: 9, draft: null, version: v("v23", "1.23") });
  assert.equal(r.kind, "error");
});

test("with no request, the autosaved draft is the latest saved state", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: null, currentVersionId: "v23", revision: 236, draft: draft(), version: null });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.source, "draft");
    assert.equal(r.version, "draft");
    assert.equal(r.revision, 236);
    assert.equal(r.versionId, "v23", "the session is recorded against the draft's base version");
    assert.equal(r.draftUpdatedAt, "2026-09-03T16:11:00Z");
  }
});

test("the reported bug: current version 1.4, a pinned test deployment on 1.3 — the pin plays no part", () => {
  // there is no `pinnedVersionId` input at all: the decision cannot see it
  const r = decideTestBuild({ surveyId: S, requestedVersionId: null, currentVersionId: "v1.4", revision: 236, draft: null, version: v("v1.4", "1.4") });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") assert.equal(r.version, "1.4");
});

test("with no draft and no request, the current version is loaded", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: null, currentVersionId: "v23", revision: 9, draft: null, version: v("v23", "1.23") });
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") { assert.equal(r.source, "current"); assert.equal(r.version, "1.23"); }
});

test("a draft that fails to parse is an error — the older version is NOT shown in its place", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: null, currentVersionId: "v23", revision: 9,
    draft: { ok: false, error: "questions[3].type: invalid" }, version: v("v23", "1.23") });
  assert.equal(r.kind, "error");
  if (r.kind === "error") assert.match(r.detail, /NOT loaded/);
});

test("a survey with no saved version at all says so", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: null, currentVersionId: null, revision: 0, draft: null, version: null });
  assert.equal(r.kind, "error");
  if (r.kind === "error") assert.match(r.detail, /no saved version yet/);
});

test("a draft with no base version cannot start a session, and says why", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: null, currentVersionId: null, revision: 2, draft: draft(), version: null });
  assert.equal(r.kind, "error");
});

test("the loader is told which version to fetch, and not to fetch one for a draft", () => {
  assert.equal(versionIdToFetch({ requestedVersionId: "v24", currentVersionId: "v23", draft: draft() }), "v24");
  assert.equal(versionIdToFetch({ requestedVersionId: null, currentVersionId: "v23", draft: draft() }), null);
  assert.equal(versionIdToFetch({ requestedVersionId: null, currentVersionId: "v23", draft: null }), "v23");
  assert.equal(versionIdToFetch({ requestedVersionId: null, currentVersionId: "v23", draft: { ok: false, error: "x" } }), "v23");
});

test("every error carries the same respondent-facing sentence", () => {
  const r = decideTestBuild({ surveyId: S, requestedVersionId: "nope", currentVersionId: null, revision: 0, draft: null, version: null });
  assert.equal(r.kind, "error");
  if (r.kind === "error") assert.equal(r.message, "Unable to load the latest saved survey version. Please retry.");
});
