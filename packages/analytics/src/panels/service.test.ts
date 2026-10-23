import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { panelFromPreset, verifyPanelSignature, type PanelHasher } from "@rescript/engine";
import { enterPanel, exitPanel, attachPanelSession } from "./service.js";
import { memoryPanelStore, emptyPanelState } from "./stores.js";

const hasher: PanelHasher = (alg, data, secret) => (alg.startsWith("hmac") ? createHmac(alg === "hmac-sha256" ? "sha256" : "sha1", secret).update(data).digest() : createHash(alg).update(data + secret).digest());

test("Prolific: enter with PROLIFIC_PID → admitted; screen-out and complete links; the first outcome stands; a duplicate is refused", async () => {
  const state = emptyPanelState();
  state.panels.s1 = [panelFromPreset("prolific", { completionCode: "ABC123", codes: { screenout: "SCR9" } })];
  const store = memoryPanelStore(state);
  const a = await enterPanel(store, { surveyId: "s1", target: "ai_interview", targetRef: "study-1", params: { PROLIFIC_PID: "5f1e2d3c", STUDY_ID: "st1", SESSION_ID: "se1" }, isTest: false }, { hasher });
  assert.equal(a.kind, "admitted");
  if (a.kind !== "admitted") return;
  await attachPanelSession(store, a.entryId, "sess-1");
  const out = await exitPanel(store, { sessionRef: "sess-1", outcome: "screenout" }, { hasher });
  assert.equal(out?.url, "https://app.prolific.com/submissions/complete?cc=SCR9");
  const again = await exitPanel(store, { entryId: a.entryId, outcome: "complete" }, { hasher });
  assert.equal(again?.url, "https://app.prolific.com/submissions/complete?cc=SCR9", "a screen-out is never turned into a complete");
  const dup = await enterPanel(store, { surveyId: "s1", target: "group_session", targetRef: "g", params: { PROLIFIC_PID: "5f1e2d3c" }, isTest: false }, { hasher });
  assert.equal(dup.kind, "duplicate");
  assert.equal(dup.kind === "duplicate" && dup.outcome, "screenout");
  const b = await enterPanel(store, { surveyId: "s1", target: "ai_interview", targetRef: "study-1", params: { PROLIFIC_PID: "aaaa1111" }, isTest: false }, { hasher });
  assert.equal(b.kind, "admitted");
  assert.equal((await exitPanel(store, { entryId: b.kind === "admitted" ? b.entryId : "", outcome: "complete" }, { hasher }))?.url, "https://app.prolific.com/submissions/complete?cc=ABC123");
  assert.equal((await enterPanel(store, { surveyId: "s1", target: "ai_interview", targetRef: null, params: {}, isTest: false }, { hasher })).kind, "refused", "no id: refused");
  assert.equal((await enterPanel(store, { surveyId: "nopanel", target: "ai_interview", targetRef: null, params: { pid: "p1" }, isTest: false }, { hasher })).kind, "none");
});

test("Cint: signed end links with the secret; quota sync sends the next arrival back as over quota; tests are never counted or sent away", async () => {
  const state = emptyPanelState();
  state.panels.s2 = [panelFromPreset("cint", { completesTarget: 1 })];
  state.secrets["s2|cint"] = "s3cret";
  const store = memoryPanelStore(state);
  const a = await enterPanel(store, { surveyId: "s2", target: "survey", targetRef: null, params: { RID: "R-1" }, isTest: false }, { hasher });
  assert.equal(a.kind, "admitted");
  const done = await exitPanel(store, { entryId: a.kind === "admitted" ? a.entryId : "", outcome: "complete" }, { hasher });
  assert.ok(done?.signed);
  assert.ok(verifyPanelSignature(done!.url!, state.panels.s2[0].signing, "s3cret", hasher));
  const t = await enterPanel(store, { surveyId: "s2", target: "survey", targetRef: null, params: { RID: "T-1" }, isTest: true }, { hasher });
  assert.equal(t.kind, "admitted", "a test entry is not sent away by the quota");
  const over = await enterPanel(store, { surveyId: "s2", target: "survey", targetRef: null, params: { RID: "R-2" }, isTest: false }, { hasher });
  assert.equal(over.kind, "over_quota");
  assert.match(over.kind === "over_quota" ? over.redirect.url! : "", /RIS=40&RID=R-2&hash=/);
  assert.equal(state.entries.find((e) => e.pid === "R-2")?.outcome, "over_quota");
});
