import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustForModel, endOfTurn, endsUnfinished, expectsOpenAnswer, signalsDone, signalsThinking } from "./aiInterviewTurnTaking.js";

test("a pause is not the end: thinking fillers and unfinished sentences wait much longer than a finished answer", () => {
  const q = "Why did you switch banks?";
  const think = endOfTurn({ answer: "Hmm, let me think", question: q });
  const mid = endOfTurn({ answer: "Mainly because the fees went up and", question: q });
  const full = endOfTurn({ answer: "Mainly because the fees went up twice in a year and the app kept crashing whenever I tried to pay a bill.", question: q });
  assert.equal(think.signal, "thinking"); assert.equal(mid.signal, "incomplete"); assert.equal(full.signal, "complete");
  assert.ok(think.waitMs > mid.waitMs && mid.waitMs > full.waitMs, `${think.waitMs} > ${mid.waitMs} > ${full.waitMs}`);
  assert.ok(full.waitMs >= 1500, "even a finished answer gets a thinking window, never an instant reply");
  assert.ok(think.waitMs >= 5000);
});

test("'that's all' in the participant's own language ends the answer at once — 20 languages and code-mixed forms", () => {
  for (const s of ["That's all.", "I'm done", "nothing else to add", "you can move on", "What's next?", "I don't have anything else to add",
    "बस इतना ही", "और कुछ नहीं", "bas itna hi", "aur kuch nahi, aage badho", "eso es todo", "c'est tout", "das ist alles", "é só isso", "itu saja",
    "以上です", "就这些", "이상입니다", "هذا كل شيء", "اور کچھ نہیں", "அவ்வளவுதான்", "అంతే", "এইটুকুই", "The price mostly, that's all"]) {
    assert.ok(signalsDone(s), s);
    assert.equal(endOfTurn({ answer: s }).action, "commit", s);
  }
  for (const s of ["That's all I could think of at first, but actually there is one more thing", "I liked the app", "Next month I will switch", "done with my old bank because of the fees and"]) assert.equal(signalsDone(s), false, s);
});

test("thinking and mid-sentence signals in several languages", () => {
  for (const s of ["umm", "well, let me see", "hmm sochne do", "déjame pensar", "euh", "ähm", "えーと", "让我想想", "글쎄요"]) assert.ok(signalsThinking(s), s);
  for (const s of ["I use it every day because", "it was okay but", "mujhe pasand hai kyunki", "me gusta porque", "c'est bien mais", "the price was,", "and then..."]) assert.ok(endsUnfinished(s), s);
  for (const s of ["I use it every day.", "It was fine overall"]) assert.equal(endsUnfinished(s), false, s);
});

test("context: a short answer to an open question waits and asks the model; to a closed question it does not", () => {
  assert.equal(expectsOpenAnswer("Do you have a credit card?"), false);
  assert.equal(expectsOpenAnswer("Tell me about the last time you used it"), true);
  const open = endOfTurn({ answer: "The price", question: "What matters most when you choose a bank?" });
  const closed = endOfTurn({ answer: "Yes, two", question: "Do you have a credit card?" });
  assert.equal(open.consultAi, true); assert.equal(open.signal, "short");
  assert.equal(closed.consultAi, false); assert.ok(closed.waitMs < open.waitMs);
});

test("patience scales the windows; the model can extend or shorten a wait; nothing waits past the cap", () => {
  const a = { answer: "It was good overall and the staff were helpful", question: "How was the visit?" };
  assert.ok(endOfTurn({ ...a, patience: "patient" }).waitMs > endOfTurn(a).waitMs);
  assert.ok(endOfTurn({ ...a, patience: "quick" }).waitMs < endOfTurn(a).waitMs);
  const d = endOfTurn(a);
  assert.ok(adjustForModel(d, "continuing").waitMs > d.waitMs);
  assert.ok(adjustForModel(d, "complete").waitMs <= 1100);
  assert.ok(endOfTurn({ answer: "um", patience: "patient" }).waitMs <= 15_000);
});
