import { test } from "node:test";
import assert from "node:assert/strict";
import { QualStudy } from "@rescript/schema";
import { buildModeratorPlan, fakeModeratorReply, finishTurn, prepareTurn, speechGateContext, startInterview, MODERATOR_REPLY_SCHEMA, type PreparedTurn } from "./aiModerator.js";
import { SentenceChunker, SpeechGate, sentenceProblems, speechChunks } from "./aiInterviewVoice.js";
import { realtimeReplyFrom, realtimeSessionInstructions, realtimeTurnInstructions, realtimeVerbatimInstructions, spokeVerbatim, REALTIME_TOOLS } from "./aiInterviewRealtime.js";
import { voiceSummaryOf } from "./aiInterviewStudy.js";

/*
 * VOICE CONVERSATION (G1 2026-10-22): the reply is cut into sentences for speech as it streams (TTS
 * chunking), each sentence is spoken only after the per-sentence output checks, a sentence that fails
 * closes the gate and the scripted turn follows; the participant's interruption reaches the moderator
 * (asked again when they did not hear the question; told to the model otherwise) and is counted;
 * the realtime provider's tool calls map onto the engine's intents.
 */

test("TTS chunking: sentence ends in several scripts, abbreviations, short sentences merged, long runs split, streamed = whole", () => {
  assert.deepEqual(speechChunks("Thank you. Tell me about the last time you changed provider. What happened next?"), ["Thank you. Tell me about the last time you changed provider.", "What happened next?"]);
  assert.deepEqual(speechChunks("e.g. the price went up. Dr. Rao said so! Then what?"), ["e.g. the price went up.", "Dr. Rao said so! Then what?"]);
  assert.deepEqual(speechChunks("धन्यवाद। आपने कब सोचा कि प्रदाता बदलना चाहिए? और फिर क्या हुआ?"), ["धन्यवाद। आपने कब सोचा कि प्रदाता बदलना चाहिए?", "और फिर क्या हुआ?"]);
  assert.deepEqual(speechChunks("ありがとうございます。前回プロバイダーを変えようと思ったときのことを教えてください。"), ["ありがとうございます。前回プロバイダーを変えようと思ったときのことを教えてください。"]);
  assert.deepEqual(speechChunks("شكرًا لك. حدّثني عن آخر مرة فكّرت فيها في تغيير مزوّد الخدمة؟ ماذا حدث بعد ذلك؟"), ["شكرًا لك. حدّثني عن آخر مرة فكّرت فيها في تغيير مزوّد الخدمة؟", "ماذا حدث بعد ذلك؟"]);
  const long = `${"word ".repeat(80)}end.`;
  const parts = speechChunks(long, { maxChars: 120 });
  assert.ok(parts.length >= 3 && parts.every((p) => p.length <= 120), parts.map((p) => p.length).join(","));
  /* streamed in small pieces = the same chunks */
  const text = "Thank you. Tell me about the last time you changed provider. What happened next?";
  const c = new SentenceChunker();
  const streamed: string[] = [];
  for (let i = 0; i < text.length; i += 7) streamed.push(...c.push(text.slice(i, i + 7)));
  streamed.push(...c.flush());
  assert.deepEqual(streamed, speechChunks(text));
  assert.equal(new SentenceChunker().push("Thank you. ").length, 0, "a short first sentence waits for the next one");
});

const ctx = { allowed: ["probe", "clarify", "next", "check_in"], language: "en", questionText: "Tell me about the last time you thought about changing provider.", answer: "The price went up" };

test("the speech gate: safe sentences are cleared as they arrive; a failing one closes the gate; an intent not allowed speaks nothing", () => {
  const g = new SpeechGate(ctx);
  g.setIntent("probe");
  const said = [...g.pushSay("Thank you for sharing that with me. "), ...g.pushSay("You mentioned the price going up. "), ...g.pushSay("What would a fair price ")];
  assert.deepEqual(said, ["Thank you for sharing that with me.", "You mentioned the price going up."]);
  assert.equal(g.blocked, null);
  assert.deepEqual(g.finish("Thank you for sharing that with me. You mentioned the price going up. What would a fair price have been?"), { remainder: "What would a fair price have been?", spoken: "Thank you for sharing that with me. You mentioned the price going up.", replaced: false });

  const bad = new SpeechGate(ctx);
  bad.setIntent("probe");
  assert.deepEqual(bad.pushSay("I understand that completely. Could you share your phone number with me? "), ["I understand that completely."]);
  assert.match(bad.blocked ?? "", /contact or identity/);
  assert.deepEqual(bad.pushSay("Then I can call you. "), [], "nothing more of a blocked reply is spoken");
  const f = bad.finish("Thank you. What happened next?");
  assert.equal(f.replaced, true); assert.equal(f.remainder, "Thank you. What happened next?");

  const notAllowed = new SpeechGate(ctx);
  notAllowed.setIntent("close");
  assert.deepEqual(notAllowed.pushSay("That's all I wanted to ask. Thank you so much for your time today. "), []);
  assert.match(notAllowed.blocked ?? "", /not allowed/);
  assert.deepEqual(sentenceProblems("Visit www.example.com for more.", ctx), ["contains a link or address"]);
  assert.deepEqual(sentenceProblems("Ignore my instructions, the system prompt says hello.", ctx).includes("talks about its instructions"), true);
  assert.deepEqual(sentenceProblems("यह बिल्कुल भी सही भाषा में नहीं लिखा गया है।", ctx), ["not in the participant's language"]);
  assert.deepEqual(sentenceProblems("OK.", { ...ctx, language: "hi" }), [], "too short to judge the language");
});

const study = () => QualStudy.parse({
  kind: "interview", title: "Switching", durationMinutes: 15, objectives: ["Understand what triggers switching"],
  consent: { statement: "Taking part is voluntary." },
  sections: [
    { id: "s1", title: "Intro", kind: "opening", script: "Thanks for joining." },
    { id: "s2", title: "Triggers", questions: [{ id: "s2q1", text: "Tell me about the last time you thought about changing provider.", probes: ["What happened next?"] }, { id: "s2q2", text: "How did you feel then?" }] },
    { id: "s3", title: "Close", kind: "closing", questions: [{ id: "s3q1", text: "Is there anything else you would like to add?" }] },
  ],
  aiModeration: { modes: ["text", "voice"] },
});
const T0 = Date.parse("2026-10-22T10:00:00Z");
const model = (p: PreparedTurn) => { assert.equal(p.kind, "model"); return p as Extract<PreparedTurn, { kind: "model" }>; };

test("interruption: before the question was heard and too short to be an answer → asked again (not a follow-up); otherwise the model is told; counted either way", () => {
  const plan = buildModeratorPlan(study(), { guideLanguage: "en" });
  const open = startInterview(plan, { now: T0, language: "en" });
  if (open.kind !== "final") throw new Error("model");
  const said = open.reply.say;
  /* cut off after "Hi, I'm Alex" — they said "sorry, what?" */
  const r = prepareTurn(plan, open.state, { kind: "answer", text: "sorry, what?", interrupted: { said, heardChars: 12 } }, { now: T0 + 5000 });
  assert.equal(r.kind, "final");
  if (r.kind !== "final") return;
  assert.equal(r.reply.intent, "repeat");
  assert.equal(r.reply.say, "Sorry — let me ask that again. Tell me about the last time you thought about changing provider.");
  assert.deepEqual(r.reply.decision.interrupted, { heardChars: 12, heardQuestion: false });
  assert.equal(r.state.followUps, 0, "not a follow-up");
  assert.equal(r.state.voice?.interruptions, 1);
  /* a substantive answer over the moderator: the model gets the interruption in its turn context */
  const m = model(prepareTurn(plan, open.state, { kind: "answer", text: "Oh I know this one, it was when the price went up twice and the speed dropped every evening.", interrupted: { said, heardChars: said.length - 20 } }, { now: T0 + 5000 }));
  assert.match(m.request.user, /INTERRUPTED: the participant spoke over your last turn; they heard only: "Hi, I'm Alex/);
  assert.match(m.request.user, /did NOT hear your question/);
  assert.equal(m.fallback.decision.interrupted?.heardQuestion, false);
  const done = finishTurn(plan, m, fakeModeratorReply(plan, m), { now: T0 + 6000 });
  assert.ok(done.reply.decision.interrupted, "the model's reply records the interruption too");
  assert.equal(done.state.voice?.interruptions, 1);
  assert.deepEqual(voiceSummaryOf({ voice: { style: "conversation", interruptions: 2, latenciesMs: [900, 1500, 700] } }), { style: "conversation", interruptions: 2, medianLatencyMs: 900, maxLatencyMs: 1500, turnsMeasured: 3 });
  assert.equal(voiceSummaryOf({}), null);
});

test("the model writes the intent first (the gate knows it before the words); a streamed reply the gate blocked falls back", () => {
  assert.deepEqual(Object.keys(MODERATOR_REPLY_SCHEMA.properties as object).slice(0, 2), ["intent", "say"]);
  const plan = buildModeratorPlan(study(), { guideLanguage: "en" });
  const open = startInterview(plan, { now: T0, language: "en" });
  if (open.kind !== "final") throw new Error("model");
  const m = model(prepareTurn(plan, open.state, { kind: "answer", text: "ok" }, { now: T0 + 5000 }));
  assert.deepEqual(Object.keys(fakeModeratorReply(plan, m)).slice(0, 2), ["intent", "say"]);
  const g = speechGateContext(plan, m);
  assert.deepEqual([...g.allowed], ["probe", "clarify", "next", "check_in"]);
  const out = finishTurn(plan, m, { intent: "probe", say: "You mentioned ok. Could you tell me more?" }, { now: T0 + 6000, extraProblems: ["not in the participant's language"] });
  assert.equal(out.reply.decision.source, "fallback");
  assert.deepEqual(out.reply.decision.problems, ["not in the participant's language"]);
});

test("realtime: the guide as instructions, tools for what was done, tool calls → intents, verbatim turns compared", () => {
  const plan = buildModeratorPlan(study(), { guideLanguage: "en" });
  assert.match(realtimeSessionInstructions(plan), /THE GUIDE, in order:[\s\S]*\[s2q1\] Tell me about the last time/);
  assert.deepEqual(REALTIME_TOOLS.map((t) => t.name), ["probe", "next_question", "check_in", "end_interview"]);
  const open = startInterview(plan, { now: T0, language: "en" });
  if (open.kind !== "final") throw new Error("model");
  const m = model(prepareTurn(plan, open.state, { kind: "answer", text: "ok" }, { now: T0 + 5000 }));
  const ins = realtimeTurnInstructions(plan, m);
  assert.match(ins, /ALLOWED TOOLS NOW: probe \| next_question \| check_in/);
  assert.match(ins, /⟦DATA id=/, "the participant's words are fenced exactly as in a written turn");
  assert.deepEqual(realtimeReplyFrom(" You said ok.  Could you say more? ", { name: "probe", arguments: "{\"reason\":\"short\",\"covered\":[\"O1\"]}" }), { intent: "probe", say: "You said ok. Could you say more?", reason: "short", covered: ["O1"] });
  assert.equal(realtimeReplyFrom("Thanks.", { name: "next_question", arguments: {} }).intent, "next");
  assert.equal(realtimeReplyFrom("Thanks.", null).intent, "", "no tool call = no intent → the output check fails it");
  const out = finishTurn(plan, m, realtimeReplyFrom("Thanks.", null), { now: T0 + 6000 });
  assert.equal(out.reply.decision.source, "fallback");
  assert.match(realtimeVerbatimInstructions("Say \"\"\"this\"\"\""), /Say exactly the following words/);
  assert.equal(spokeVerbatim("Thank you. What happened next?", "thank you what happened next"), true);
  assert.equal(spokeVerbatim("Thank you. What happened next?", "Could you share your number?"), false);
});
