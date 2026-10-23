import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { QualStudy } from "@rescript/schema";
import { buildLanguagePack, packSourceItems } from "@rescript/engine";
import { memoryStore, resetMemoryStore } from "./memoryStore.ts";
import { begin, studyInfo, turn, AiInterviewError, type Deps, type ModelCaller } from "./service.ts";

/*
 * THE RESPONDENT LINK, VOICE AND LANGUAGES (G1 2026-10-22), without Next or a database: the hands-free style
 * is recorded and its replies are spoken sentence by sentence through the speech gate (a reply that asks
 * for a phone number is never spoken past the safe sentence); an interruption is measured against the
 * STORED moderator turn; latency and fallbacks are kept; realtime is offered only with a provider, and its
 * two-phase turn records what the provider said and corrects a reply that fails the checks; a study
 * language's pack makes the scripted fallback speak it.
 */

let clock = Date.parse("2026-10-22T10:00:00Z");
const guide = (over: Record<string, unknown> = {}) => QualStudy.parse({
  kind: "interview", title: "Switching", durationMinutes: 15, objectives: ["Understand what triggers switching"],
  consent: { statement: "Taking part is voluntary.", recordingDisclosure: "Audio may be recorded." },
  sections: [
    { id: "s1", title: "Intro", kind: "opening", script: "Thanks for joining." },
    { id: "s2", title: "Triggers", questions: [{ id: "s2q1", text: "Tell me about the last time you thought about changing provider." }, { id: "s2q2", text: "How did you feel about your provider then?" }] },
    { id: "s3", title: "Close", kind: "closing", questions: [{ id: "s3q1", text: "Is there anything else you would like to add?" }] },
  ],
  aiModeration: { modes: ["text", "voice"], defaultProbing: "none", ...((over.aiModeration as object) ?? {}) },
});
const scripted = (replies: unknown[]): ModelCaller => async (_req, o) => {
  const next = replies.length ? replies.shift() : o.fake();
  if (next === "fail") return { failed: "503" };
  const v = next as Record<string, unknown>;
  /* the model writes the intent first, then the words, in pieces */
  const intent = String(v.intent ?? "");
  for (let i = 0; i < intent.length; i += 3) o.onIntent?.(intent.slice(i, i + 3));
  const say = String(v.say ?? "");
  for (let i = 0; i < say.length; i += 9) o.onSay?.(say.slice(i, i + 9));
  return { value: next, costUsd: 0.01 };
};
function deps(model: ModelCaller | null = scripted([]), realtime = false): Deps & { store: ReturnType<typeof memoryStore> } {
  return { store: memoryStore(() => clock), model, now: () => clock, newToken: () => randomBytes(32).toString("hex"), hash: async (t) => createHash("sha256").update(t).digest("hex"), realtimeAvailable: realtime };
}
beforeEach(() => { resetMemoryStore(); clock = Date.parse("2026-10-22T10:00:00Z"); });
const ok = { consent: { agreed: true, recording: false } };

test("styles: conversation offered by default, realtime only with a provider; the style is the session's", async () => {
  const d = deps();
  const st = d.store.launch(guide(), { title: "S" }).study;
  assert.deepEqual((await studyInfo(d, st.linkToken)).view.voiceStyles, ["turn_based", "conversation"]);
  const st2 = d.store.launch(guide({ aiModeration: { voiceStyles: ["conversation", "realtime"] } }), { title: "S2" }).study;
  assert.deepEqual((await studyInfo(d, st2.linkToken)).view.voiceStyles, ["conversation"], "no realtime provider here");
  await assert.rejects(begin(d, { token: st2.linkToken, ...ok, mode: "realtime", language: "en" }), (e: AiInterviewError) => e.code === "mode");
  assert.deepEqual((await studyInfo(deps(scripted([]), true), st2.linkToken)).view.voiceStyles, ["conversation", "realtime"]);
  const b = await begin(d, { token: st.linkToken, ...ok, mode: "conversation", language: "en" });
  assert.equal(b.kind, "started");
  if (b.kind === "started") { assert.equal(b.interview.mode, "voice"); assert.equal(b.interview.voice, "conversation"); }
  assert.equal(d.store.sessionsOf(st.id)[0].state.voice?.style, "conversation");
});

test("the hands-free reply is spoken sentence by sentence through the gate; an unsafe sentence is never spoken; interruption, latency and fallback are kept", async () => {
  const d = deps(scripted([
    { intent: "next", say: "Thank you for explaining that so clearly. How did you feel about your provider then?" },
    { intent: "next", say: "I hear you, that sounds frustrating to deal with. Could you send me your phone number so I can follow up?" },
  ]));
  const st = d.store.launch(guide(), { title: "S" }).study;
  const spoken: { i: number; text: string }[] = [];
  const b = await begin(d, { token: st.linkToken, ...ok, mode: "conversation", language: "en" }, { onSpeak: (c) => spoken.push(c) });
  if (b.kind !== "started") throw new Error(b.kind);
  assert.ok(spoken.length >= 2 && spoken.every((c, i) => c.i === i), "the opening, in sentences");
  assert.equal(spoken.map((c) => c.text).join(" "), b.interview.turns[0].text);
  /* the participant cut the opening short after 20 characters (the server measures it on the STORED turn) */
  spoken.length = 0;
  clock += 30_000;
  const r1 = await turn(d, { sessionToken: b.sessionToken, afterSeq: 1, input: { kind: "answer", text: "The price went up twice last year and the speed dropped every evening." }, voice: { interrupted: { heardChars: 20 }, latencyMs: 850 } }, { onSpeak: (c) => spoken.push(c) });
  assert.deepEqual(spoken.map((c) => c.text), ["Thank you for explaining that so clearly.", "How did you feel about your provider then?"], "the first sentence was cleared before the reply was finished");
  const s1 = d.store.sessionsOf(st.id)[0];
  assert.equal(s1.state.voice?.interruptions, 1); assert.deepEqual(s1.state.voice?.latenciesMs, [850]);
  const answer = s1.turns.find((t) => t.speaker === "participant")!;
  assert.deepEqual((answer.decision as unknown as { voice: unknown }).voice, { interrupted: { seq: 1, heardChars: 20, of: b.interview.turns[0].text.length }, previousReplyLatencyMs: 850 });
  /* the second model reply asks for a phone number: only the safe first sentence is spoken, then the scripted turn */
  spoken.length = 0;
  clock += 30_000;
  const r2 = await turn(d, { sessionToken: b.sessionToken, afterSeq: r1.interview.lastSeq, input: { kind: "answer", text: "Let down, honestly, after ten years nobody explained anything to me." }, voice: { style: "turn_based", fallback: "no_mic" } }, { onSpeak: (c) => spoken.push(c) });
  const heard = spoken.map((c) => c.text).join(" ");
  assert.doesNotMatch(heard, /phone number/, "the unsafe sentence is never spoken");
  assert.match(heard, /^I hear you, that sounds frustrating to deal with\. /);
  const mod = r2.added.find((t) => t.speaker === "moderator")!;
  assert.match(mod.text, /^I hear you, that sounds frustrating to deal with\. /, "the transcript says what was actually heard");
  const s2 = d.store.sessionsOf(st.id)[0];
  assert.match(String((s2.turns.at(-1)!.decision as unknown as { problems?: string[] }).problems), /contact or identity/);
  assert.equal(s2.state.voice?.style, "turn_based"); assert.equal(s2.state.voice?.fallback, "no_mic");
});

test("realtime: refused without a provider; with one, a rules turn comes back to be said verbatim, a model turn as instructions, then the spoken words are checked and recorded", async () => {
  const d = deps(scripted([]), true);
  const st = d.store.launch(guide({ aiModeration: { voiceStyles: ["realtime"] } }), { title: "R" }).study;
  const b = await begin(d, { token: st.linkToken, ...ok, mode: "realtime", language: "en" });
  if (b.kind !== "started") throw new Error(b.kind);
  assert.equal(b.interview.voice, "realtime");
  const input = { kind: "answer" as const, text: "We changed provider when the speed dropped every evening for a month." };
  const p = await turn(d, { sessionToken: b.sessionToken, afterSeq: 1, input, realtime: { prepare: true } });
  assert.equal(p.realtime?.action, "respond");
  assert.match(p.realtime?.instructions ?? "", /ALLOWED TOOLS NOW: next_question \| check_in/);
  assert.equal(d.store.sessionsOf(st.id)[0].turns.length, 1, "nothing recorded yet");
  /* the provider spoke and called next_question: checked, recorded as said */
  const r = await turn(d, { sessionToken: b.sessionToken, afterSeq: 1, input, realtime: { transcript: "Thank you. How did you feel about your provider then?", call: { name: "next_question", arguments: "{\"reason\":\"full answer\"}" } } });
  assert.equal(r.realtime?.action, "none");
  assert.equal(r.added.at(-1)!.text, "Thank you. How did you feel about your provider then?");
  /* the next: the provider asked for an e-mail address → flagged, the scripted turn follows as a correction */
  const input2 = { kind: "answer" as const, text: "Pretty annoyed, to be honest, it felt like nobody cared about us." };
  const p2 = await turn(d, { sessionToken: b.sessionToken, afterSeq: r.interview.lastSeq, input: input2, realtime: { prepare: true } });
  assert.equal(p2.realtime?.action, "respond");
  const r2 = await turn(d, { sessionToken: b.sessionToken, afterSeq: r.interview.lastSeq, input: input2, realtime: { transcript: "I see. What is your e-mail address?", call: { name: "next_question", arguments: "{}" } } });
  assert.equal(r2.realtime?.action, "say"); assert.equal(r2.realtime?.correction, true);
  assert.match(r2.realtime?.instructions ?? "", /Say exactly the following words/);
  const s = d.store.sessionsOf(st.id)[0];
  assert.ok(s.flags.some((f) => f.kind === "realtime_unchecked"));
  assert.match(s.turns.at(-1)!.text, /^I see\. What is your e-mail address\? /, "what the provider said, then the correction, are both in the transcript");
  /* a rules turn (stop) comes back to be said verbatim; a verbatim turn said differently is flagged */
  const st3 = await turn(d, { sessionToken: b.sessionToken, afterSeq: s.turns.at(-1)!.seq, input: { kind: "stop" }, realtime: { prepare: true, lastVerbatim: "Something else entirely was said here." } });
  assert.equal(st3.realtime?.action, "say");
  assert.ok(d.store.sessionsOf(st.id)[0].flags.filter((f) => f.kind === "realtime_unchecked").length >= 2);
});

test("a study language's pack: the page's text in it, and the scripted fallback speaks it when the provider fails", async () => {
  const g0 = guide({ aiModeration: { languages: ["en", "es"] } });
  const es = buildLanguagePack(g0, "es", Object.fromEntries(packSourceItems(g0, "es").map((i) => [i.key, `ES ${i.text}`])));
  const g = QualStudy.parse({ ...g0, aiModeration: { ...g0.aiModeration, translations: { es } } });
  const d = deps(scripted(["fail"]));
  const st = d.store.launch(g, { title: "S" }).study;
  const info = await studyInfo(d, st.linkToken);
  assert.equal(info.i18n?.texts.es?.consent?.statement, "ES Taking part is voluntary.");
  assert.ok(info.i18n?.builtin.includes("es"));
  const b = await begin(d, { token: st.linkToken, ...ok, mode: "text", language: "es" });
  if (b.kind !== "started") throw new Error(b.kind);
  assert.equal(b.interview.turns[0].text, "Hola, soy Alex, un entrevistador de IA. ES Thanks for joining. ES Tell me about the last time you thought about changing provider.");
  const r = await turn(d, { sessionToken: b.sessionToken, afterSeq: 1, input: { kind: "answer", text: "Cambiamos cuando la velocidad bajó todas las noches durante un mes entero." } });
  assert.equal(r.added.at(-1)!.text, "Gracias. ES How did you feel about your provider then?");
});
