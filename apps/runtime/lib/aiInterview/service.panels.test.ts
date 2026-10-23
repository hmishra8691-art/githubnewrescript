import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { QualStudy, type PanelOutcome } from "@rescript/schema";
import { panelFromPreset, verifyPanelSignature, type NotifyEmitInput, type PanelHasher } from "@rescript/engine";
import { enterPanel, exitPanel, attachPanelSession, memoryPanelStore, emptyPanelState } from "@rescript/analytics";
import { memoryStore, resetMemoryStore } from "./memoryStore.ts";
import { begin, turn, type Deps, type PanelHooks } from "./service.ts";

/*
 * G3 2026-10-22 — the AI-interview link with a PANEL and ALERTS: a Prolific participant enters with PROLIFIC_PID,
 * a screen-out goes back with the screen-out code, a completion with the completion code; the same panel id again is
 * refused; a Cint participant's end link is signed; a distress answer and the completion raise events carrying the
 * participant's pseudonym, the turn's words (the notifier redacts them) and a link to the live view.
 */
let clock = Date.parse("2026-10-22T10:00:00Z");
const hasher: PanelHasher = (alg, data, secret) => (alg.startsWith("hmac") ? createHmac(alg === "hmac-sha256" ? "sha256" : "sha1", secret).update(data).digest() : createHash(alg).update(data + secret).digest());
const guide = QualStudy.parse({
  kind: "interview", title: "Switching", durationMinutes: 15, objectives: ["Triggers"],
  consent: { statement: "Taking part is voluntary." },
  sections: [{ id: "s1", title: "Intro", kind: "opening", script: "Thanks." }, { id: "s2", title: "Q", questions: [{ id: "s2q1", text: "Tell me about switching." }] }, { id: "s3", title: "Close", kind: "closing", questions: [{ id: "s3q1", text: "Anything else?" }] }],
  aiModeration: { modes: ["text"], defaultProbing: "none", screener: [{ id: "scr1", text: "Who pays?", options: [{ label: "I do" }, { label: "Someone else", qualifies: false }] }] },
});
const events: NotifyEmitInput[] = [];
function deps(panels: PanelHooks | null): Deps & { store: ReturnType<typeof memoryStore> } {
  return { store: memoryStore(() => clock), model: null, now: () => clock, newToken: () => randomBytes(32).toString("hex"), hash: async (t) => createHash("sha256").update(t).digest("hex"), panels, notify: async (e) => { events.push(e); } };
}
function hooks(state = emptyPanelState()): PanelHooks {
  const store = memoryPanelStore(state);
  return {
    async enter(a) { const r = await enterPanel(store, a, { hasher }); return r.kind === "over_quota" ? { kind: "over_quota", message: r.message, redirect: r.redirect } : r.kind === "admitted" ? { kind: "admitted", entryId: r.entryId, pid: r.pid } : r.kind === "none" ? r : { kind: r.kind, message: r.message }; },
    async attach(id, ref) { await attachPanelSession(store, id, ref); },
    async exit(a: { entryId?: string | null; sessionRef?: string | null; outcome: PanelOutcome; status?: string | null }) { return exitPanel(store, a, { hasher }); },
  };
}
beforeEach(() => { resetMemoryStore(); events.length = 0; clock = Date.parse("2026-10-22T10:00:00Z"); });
const ok = { consent: { agreed: true }, screener: { scr1: "I do" }, mode: "text", language: "en" };

test("Prolific: screen-out and complete go back with their codes; a duplicate panel id is refused", async () => {
  const state = emptyPanelState();
  state.panels.sandbox = [panelFromPreset("prolific", { completionCode: "ABC123", codes: { screenout: "SCR9" } })];
  const d = deps(hooks(state));
  const st = d.store.launch(guide, { title: "Switching IDIs" }).study;
  const out = await begin(d, { token: st.linkToken, ...ok, screener: { scr1: "Someone else" }, params: { PROLIFIC_PID: "pp-screened", STUDY_ID: "s1", SESSION_ID: "x1" } });
  assert.equal(out.kind, "screened_out");
  assert.equal(out.kind === "screened_out" && out.panel?.url, "https://app.prolific.com/submissions/complete?cc=SCR9");
  const screened = d.store.sessionsOf(st.id).find((s) => s.externalRef === "pp-screened");
  assert.ok(screened && Object.values(state.entries).some((e) => e.pid === "pp-screened" && e.sessionRef === screened.id), "the screened-out row carries its panel entry (the live view shows it)");
  const b = await begin(d, { token: st.linkToken, ...ok, params: { PROLIFIC_PID: "pp-1", STUDY_ID: "s1", SESSION_ID: "x2" } });
  assert.equal(b.kind, "started");
  if (b.kind !== "started") return;
  assert.equal(d.store.sessionsOf(st.id).find((s) => s.status === "in_progress")?.externalRef, "pp-1", "the panel id is the participant's external ref");
  let r = await turn(d, { sessionToken: b.sessionToken, afterSeq: b.interview.lastSeq, input: { kind: "answer", text: "I switched because the price went up a lot." } });
  for (let i = 0; i < 6 && !r.interview.done; i++) r = await turn(d, { sessionToken: b.sessionToken, afterSeq: r.interview.lastSeq, input: { kind: "answer", text: "Nothing more to add, thank you." } });
  assert.equal(r.interview.status, "completed");
  assert.equal(r.interview.redirect, "https://app.prolific.com/submissions/complete?cc=ABC123");
  assert.equal(r.interview.code, "ABC123");
  assert.ok(events.some((e) => e.type === "ai_interview.completed" && e.participant === "P2"));
  const dup = await begin(d, { token: st.linkToken, ...ok, params: { PROLIFIC_PID: "pp-1" } });
  assert.equal(dup.kind, "refused");
  assert.match(dup.kind === "refused" ? dup.message : "", /already taken part/);
  const none = await begin(d, { token: st.linkToken, ...ok, params: {} });
  assert.equal(none.kind, "refused", "a Prolific study needs the Prolific id");
});

test("Cint: signed end link; a distress answer raises the alert with the turn's words and a live-view link", async () => {
  const state = emptyPanelState();
  state.panels.sandbox = [panelFromPreset("cint")];
  state.secrets["sandbox|cint"] = "k3y";
  const d = deps(hooks(state));
  const st = d.store.launch(guide, { title: "Switching IDIs" }).study;
  const b = await begin(d, { token: st.linkToken, ...ok, params: { RID: "rid-9" } });
  assert.equal(b.kind, "started");
  if (b.kind !== "started") return;
  const r = await turn(d, { sessionToken: b.sessionToken, afterSeq: b.interview.lastSeq, input: { kind: "answer", text: "Honestly I want to kill myself, everything is too much" } });
  const ev = events.find((e) => e.type === "ai_interview.distress");
  assert.ok(ev, JSON.stringify(events.map((e) => e.type)));
  assert.equal(ev!.participant, "P1");
  assert.match(String(ev!.excerpt), /too much/);
  assert.equal(ev!.link, `/sandbox?mode=studio&tab=qualitative&qual=ai&interview=${encodeURIComponent(d.store.sessionsOf(st.id)[0].id)}`);
  assert.equal(ev!.idempotencyKey, `ai_interview.distress:${d.store.sessionsOf(st.id)[0].id}`);
  let v = r;
  for (let i = 0; i < 8 && !v.interview.done; i++) v = await turn(d, { sessionToken: b.sessionToken, afterSeq: v.interview.lastSeq, input: { kind: i === 0 ? "stop" : "answer", text: "ok" } });
  assert.ok(v.interview.done);
  assert.match(v.interview.redirect ?? "", /^https:\/\/samplicio\.us\/router\/ClientCallBack\.aspx\?RIS=(?:10|30)&RID=rid-9&hash=/);
  assert.ok(verifyPanelSignature(v.interview.redirect!, state.panels.sandbox[0].signing, "k3y", hasher));
  assert.equal(events.filter((e) => e.type === "ai_interview.distress").length, 1, "once per interview");
});
