import { test } from "node:test";
import assert from "node:assert/strict";
import { tidyTranscript, coerceNormalised, normaliseUserPrompt, NORMALISE_SYSTEM_PROMPT, pickRecordingMime, languageName } from "./voice.ts";
import { parseIntent } from "./grammar.ts";

test("tidyTranscript turns spoken codes into the codes the grammar reads, and drops filler", () => {
  assert.equal(tidyTranscript("show q 10 only when question five option three is selected"), "show Q10 only when Q5 option 3 is selected");
  assert.equal(tidyTranscript("um, make Q-4 required."), "make Q4 required.");
  assert.equal(tidyTranscript("add a page break after question 12"), "add a page break after Q12");
  assert.equal(tidyTranscript("what are the questions?"), "what are the questions?", "the word question on its own is left alone");
  assert.equal(tidyTranscript("  skip   to Q9 ... "), "skip to Q9.");
  // the spoken sentence the brief gives, once read into English, is a sentence the grammar understands
  const said = tidyTranscript("Display Q10 when Q5 option 3 is selected");
  assert.deepEqual(parseIntent(said), { kind: "display", target: "Q10", action: "show", expression: "Q5 option 3 is selected" });
});

test("coerceNormalised admits {language, english} only, base-tags the language, tidies the English", () => {
  assert.deepEqual(coerceNormalised({ language: "hi-IN", english: "Show q10 when Q5 option 3 is selected" }), { language: "hi", english: "Show Q10 when Q5 option 3 is selected" });
  assert.deepEqual(coerceNormalised({ language: "und", english: "" }), { language: "und", english: "" }, "unintelligible is reported, not invented");
  assert.equal(coerceNormalised({ language: "en" }), null, "no English → nothing");
  assert.equal(coerceNormalised({}), null);
  assert.equal(coerceNormalised(null), null);
  assert.deepEqual(coerceNormalised({ language: "Hindi!", english: "Make Q4 required" }), { language: "en", english: "Make Q4 required" }, "a malformed tag falls back to en rather than leaking");
});

test("the normalisation prompt keeps codes and asks for one JSON shape; the user turn carries the provider's language guess", () => {
  assert.match(NORMALISE_SYSTEM_PROMPT, /"language"/); assert.match(NORMALISE_SYSTEM_PROMPT, /"english"/);
  assert.match(NORMALISE_SYSTEM_PROMPT, /Q5, Q10/);
  assert.equal(normaliseUserPrompt("Q5 के option 3 पर Q10 को दिखाना है", "hi"), "Spoken language (provider's guess): hi\nTranscript: Q5 के option 3 पर Q10 को दिखाना है");
  assert.equal(normaliseUserPrompt("hello", null), "Transcript: hello");
});

test("pickRecordingMime prefers opus in webm, and languageName reads a tag", () => {
  assert.equal(pickRecordingMime((m) => m === "audio/webm" || m === "audio/webm;codecs=opus"), "audio/webm;codecs=opus");
  assert.equal(pickRecordingMime((m) => m === "audio/mp4"), "audio/mp4");
  assert.equal(pickRecordingMime(() => false), "");
  assert.equal(languageName("hi"), "Hindi");
  assert.equal(languageName("mr"), "Marathi");
});
