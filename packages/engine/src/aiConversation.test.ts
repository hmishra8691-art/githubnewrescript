import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  effectiveAiConversation, questionAi, voiceOn, applyVoicePreset, VOICE_PRESETS, LOCALES, resolveVoiceLocale,
  spokenSegments, spokenText, pronounce, parseVoiceCommand, applicableCommands, matchSpokenAnswer, parseSpokenNumber, readBack,
  effectiveProbe, probeInstruction, acknowledgement, lintAiConversation, recordVoice, voiceKey,
  createResponseState, setAnswer, buildVariableDictionary, flattenVariables, probeSourceTextFor, nextProbe,
} from "./index.js";

/**
 * THE AI CONVERSATIONAL SURVEY ENGINE — the pure half.
 *
 * One configuration for what used to be three "types"; the legacy settings
 * still read; what the voice says, in what order, with what pauses; how
 * speech maps onto the question's own values; which commands apply; how the
 * survey-wide adaptive settings become a probe on a question — under the
 * programmer's rules, never past them.
 */

const OPTS = [{ code: "ap", label: "Apple" }, { code: "sa", label: "Samsung" }, { code: "go", label: "Google" }, { code: "xi", label: "Xiaomi", spoken: "shao-mee" }, { code: "ot", label: "Other", flags: ["other_specify"] }, { code: "no", label: "None of the above", flags: ["none_of_above"] }];
const base = (branding: Record<string, unknown> = {}, extraQ: Record<string, unknown>[] = []) => SurveyDefinition.parse({
  meta: { id: "ai", code: "AI", title: "AI conversational", version: "1.0" },
  branding,
  questions: [
    { id: "q1", code: "Q1", variableName: "BRANDS", type: "multi_select", text: "Which brands have you used in the past 12 months?", instruction: "Pick all that apply.", options: OPTS },
    { id: "q2", code: "Q2", variableName: "SAT", type: "single_select", text: "How satisfied are you with {{Q1}}?", options: [{ code: 1, label: "Very dissatisfied" }, { code: 2, label: "Dissatisfied" }, { code: 3, label: "Neutral" }, { code: 4, label: "Satisfied" }, { code: 5, label: "Very satisfied" }] },
    { id: "q3", code: "Q3", variableName: "WHY", type: "long_text", text: "Why?" },
    { id: "q4", code: "Q4", variableName: "N", type: "numeric", text: "How many?" },
    { id: "q5", code: "Q5", variableName: "GRID", type: "matrix_single", text: "Please rate each brand on satisfaction.", rows: [{ code: "ap", label: "Apple" }, { code: "sa", label: "Samsung" }], options: [{ code: 1, label: "Very dissatisfied" }, { code: 2, label: "Neutral" }, { code: 3, label: "Very satisfied" }] },
    ...extraQ,
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e1", status: "complete" }],
});
const ctxOf = (d: SurveyDefinition) => { const state = createResponseState(d, { seed: 1 }); return { def: d, state, loop: null }; };

test("ONE CONFIG: the legacy presentation/voice settings still read; absent everything, the interviewer is off and nothing changes", () => {
  const off = effectiveAiConversation(base());
  assert.equal(off.enabled, false);
  assert.equal(off.interaction, "text");
  assert.equal(off.conversation, "standard");
  assert.equal(voiceOn(off), false);
  const legacy = effectiveAiConversation(base({ layout: { presentation: "conversational", voice: { readAloud: true, dictation: true, lang: "en-IN" } } }));
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.conversation, "conversational");
  assert.equal(legacy.interaction, "text_voice");
  assert.equal(legacy.voice.locale.dialect, "en-IN");
  assert.equal(legacy.voice.reading.question, true);
  assert.equal(legacy.voice.interaction.listen, true, "dictation on → the console listens");
  assert.equal(legacy.interviewer.acknowledge, false, "the older settings never acknowledged answers; they still do not");
  const readOnly = effectiveAiConversation(base({ layout: { voice: { readAloud: true, dictation: false } } }));
  assert.equal(voiceOn(readOnly), true, "read-aloud alone is a voice survey…");
  assert.equal(readOnly.voice.interaction.listen, false, "…that listens to nobody: no microphone, as before");
  const explicit = effectiveAiConversation(base({ aiConversation: { enabled: true, interaction: "voice", conversation: "adaptive", adaptive: { enabled: true, maxFollowUps: 3 } } }));
  assert.equal(explicit.interaction, "voice");
  assert.equal(explicit.adaptive.maxFollowUps, 3);
  assert.equal(explicit.voice.audio.rate, 1, "defaults filled");
});

test("PER-QUESTION OVERRIDES merge over the survey; unspecified parts stay the survey's", () => {
  const d = base({ aiConversation: { enabled: true, interaction: "voice", voice: { reading: { question: true, options: true }, audio: { rate: 0.9 } } } }, [
    { id: "q9", code: "Q9", variableName: "Q9", type: "single_select", text: "Q9", options: OPTS.slice(0, 2), ai: { reading: { options: false }, audio: { volume: 0.5 }, conversation: "conversational" } },
  ]);
  const q9 = d.questions.find((q) => q.id === "q9")!;
  const c = questionAi(d, q9);
  assert.equal(c.voice.reading.options, false, "overridden");
  assert.equal(c.voice.reading.question, true, "kept");
  assert.equal(c.voice.audio.volume, 0.5);
  assert.equal(c.voice.audio.rate, 0.9, "kept");
  assert.equal(c.conversation, "conversational");
  assert.equal(questionAi(d, d.questions[0]).voice.reading.options, true, "a question without overrides gets the survey's");
});

test("PRESETS describe a style, never an identity; applying one keeps everything it does not mention", () => {
  const c = effectiveAiConversation(base({ aiConversation: { enabled: true, interaction: "voice", voice: { pronunciations: { Xiaomi: "shao-mee" } } } }));
  const acc = applyVoicePreset(c.voice, "accessibility");
  assert.equal(acc.audio.rate, 0.8);
  assert.equal(acc.pauses.afterQuestionMs, 1500);
  assert.equal(acc.reading.instructions, true);
  assert.equal(acc.preset, "accessibility");
  assert.deepEqual(acc.pronunciations, { Xiaomi: "shao-mee" }, "untouched by the preset");
  assert.equal(applyVoicePreset(c.voice, "nope"), c.voice, "unknown preset → unchanged");
  assert.ok(VOICE_PRESETS.every((p) => !/celebrity|famous/i.test(p.name + p.description)));
  assert.match(VOICE_PRESETS.find((p) => p.id === "youth_research")!.description, /voice style/, "a youthful voice STYLE, not an age claim");
});

test("LOCALE: explicit dialect wins; 'match' follows a reliable respondent locale; a bare language + country resolves to that country's dialect; never a guess", () => {
  const v = (locale: Record<string, unknown>) => effectiveAiConversation(base({ aiConversation: { enabled: true, interaction: "voice", voice: { locale } } })).voice;
  assert.equal(resolveVoiceLocale(v({ dialect: "en-IN" }), "en-US"), "en-IN", "explicit beats respondent");
  assert.equal(resolveVoiceLocale(v({ language: "auto", dialect: "match" }), "en-AU"), "en-AU", "match → the respondent's full tag");
  assert.equal(resolveVoiceLocale(v({ language: "en", dialect: "match", country: "IN" }), "en"), "en-IN", "bare respondent language + survey country → the country's English");
  assert.equal(resolveVoiceLocale(v({ language: "en", dialect: "match" }), null), "en", "nothing reliable → the language alone, not an invented region");
  assert.equal(resolveVoiceLocale(v({ language: "hi", dialect: "match", country: "IN" }), "en-US"), "hi-IN", "the survey's language wins over a respondent locale in another language");
  assert.ok(LOCALES.find((l) => l.country === "IN")!.languages.some((x) => x.dialect === "en-IN" && x.dialectName === "Indian English"));
  assert.ok(LOCALES.length >= 12);
});

test("WHAT THE VOICE SAYS — question only; question + options with pauses; instructions; pronunciations; spoken labels; special options", () => {
  const d = base({ aiConversation: { enabled: true, interaction: "voice", voice: { reading: { question: true, options: false }, pauses: { afterQuestionMs: 1000, betweenOptionsMs: 400, beforeOptionsMs: 500, afterAnswerMs: 700 }, pronunciations: { Google: "goo-gul" } } } });
  const q1 = d.questions[0];
  const ctx = ctxOf(d);
  const only = spokenSegments(d, q1, ctx, questionAi(d, q1), { options: q1.options });
  assert.deepEqual(only.map((s) => s.kind), ["question"]);
  assert.equal(only[0].text, "Which brands have you used in the past 12 months?");
  assert.equal(only[0].pauseMs, 1000);

  const withOpts = { ...questionAi(d, q1), voice: { ...questionAi(d, q1).voice, reading: { ...questionAi(d, q1).voice.reading, options: true, instructions: true } } };
  const segs = spokenSegments(d, q1, ctx, withOpts, { options: q1.options });
  assert.deepEqual(segs.map((s) => s.kind), ["question", "instruction", "option", "option", "option", "option", "option", "option"]);
  assert.equal(segs[1].text, "Pick all that apply.");
  assert.equal(segs[2].text, "Apple"); assert.equal(segs[2].pauseMs, 400, "pause between options");
  assert.equal(segs[4].text, "goo-gul", "survey-wide pronunciation applied to the spoken form only");
  assert.equal(segs[5].text, "shao-mee", "the option's own spoken label");
  assert.equal(segs[7].text, "None of the above"); assert.equal(segs[7].pauseMs, 700, "the last option pauses for the answer");
  assert.equal(q1.options[3].label, "Xiaomi", "stored labels never change");
  assert.equal(spokenText(segs.slice(0, 3)), "Which brands have you used in the past 12 months? Pick all that apply. Apple.");

  // special options can be silenced
  const quiet = { ...withOpts, voice: { ...withOpts.voice, reading: { ...withOpts.voice.reading, speakOther: false, speakNone: false } } };
  assert.deepEqual(spokenSegments(d, q1, ctx, quiet, { options: q1.options }).filter((s) => s.kind === "option").map((s) => s.text), ["Apple", "Samsung", "goo-gul", "shao-mee"]);

  // only VISIBLE options are ever spoken — masking is honoured by construction
  const masked = spokenSegments(d, q1, ctx, withOpts, { options: q1.options.filter((o) => o.code !== "sa") });
  assert.ok(!masked.some((s) => s.text === "Samsung"), "a masked option is not exposed by voice");
});

test("LARGE LISTS: first N, grouped, on request, none", () => {
  const d = base({ aiConversation: { enabled: true, interaction: "voice", voice: { reading: { question: true, options: true, optionMode: "first_n", firstN: 2 } } } });
  const q1 = d.questions[0]; const ctx = ctxOf(d);
  const firstN = spokenSegments(d, q1, ctx, questionAi(d, q1), { options: q1.options });
  assert.deepEqual(firstN.filter((s) => s.kind === "option").map((s) => s.text), ["Apple", "Samsung"]);
  assert.match(firstN[firstN.length - 1].text, /and 4 more\. Say "read options"/);
  const c = questionAi(d, q1);
  const onReq = { ...c, voice: { ...c.voice, reading: { ...c.voice.reading, optionMode: "on_request" as const } } };
  const asked = spokenSegments(d, q1, ctx, onReq, { options: q1.options });
  assert.deepEqual(asked.map((s) => s.kind), ["question", "prompt"]);
  assert.match(asked[1].text, /There are 6 options/);
  assert.equal(spokenSegments(d, q1, ctx, onReq, { options: q1.options, optionsRequested: true }).filter((s) => s.kind === "option").length, 6, "…and all six when asked");
  const grouped = { ...c, voice: { ...c.voice, reading: { ...c.voice.reading, optionMode: "grouped" as const, groupSize: 3 } } };
  const g = spokenSegments(d, q1, ctx, grouped, { options: q1.options }).filter((s) => s.kind === "option");
  assert.ok(g[2].pauseMs > g[1].pauseMs, "a longer pause after each group of 3");
  const none = { ...c, voice: { ...c.voice, reading: { ...c.voice.reading, optionMode: "none" as const } } };
  assert.deepEqual(spokenSegments(d, q1, ctx, none, { options: q1.options }).map((s) => s.kind), ["question"]);
});

test("GRIDS: question first (rows, then the columns once); row by row; respondent-driven", () => {
  const d = base({ aiConversation: { enabled: true, interaction: "voice", voice: { reading: { question: true, options: true, gridMode: "question_first" }, pauses: { betweenRowsMs: 700, betweenColumnsMs: 300 } } } });
  const q5 = d.questions[4]; const ctx = ctxOf(d);
  const rows = q5.rows.map((r) => ({ code: r.code, label: r.label })), cols = q5.options.map((o) => ({ code: o.code, label: o.label }));
  const qf = spokenSegments(d, q5, ctx, questionAi(d, q5), { options: q5.options, rows, columns: cols });
  assert.deepEqual(qf.map((s) => `${s.kind}:${s.text}`), [
    "question:Please rate each brand on satisfaction.", "row:Apple", "row:Samsung", "prompt:The choices for each are:",
    "column:Very dissatisfied", "column:Neutral", "column:Very satisfied",
  ]);
  assert.equal(qf[1].pauseMs, 700);
  const c = questionAi(d, q5);
  const rbr = spokenSegments(d, q5, ctx, { ...c, voice: { ...c.voice, reading: { ...c.voice.reading, gridMode: "row_by_row" as const } } }, { options: q5.options, rows, columns: cols });
  assert.deepEqual(rbr.map((s) => s.kind), ["question", "row", "column", "column", "column", "row", "column", "column", "column"], "Apple. VD, N, VS. Samsung. VD, N, VS.");
  assert.equal(rbr[4].pauseMs, 700, "a longer pause after each row's columns");
  const rd = { ...c, voice: { ...c.voice, reading: { ...c.voice.reading, gridMode: "respondent_driven" as const } } };
  const ask = spokenSegments(d, q5, ctx, rd, { options: q5.options, rows, columns: cols });
  assert.equal(ask[ask.length - 1].text, "Which one would you like to rate first?");
  const apple = spokenSegments(d, q5, ctx, rd, { options: q5.options, rows, columns: cols, rowCode: "ap" });
  assert.deepEqual(apple.filter((s) => s.kind !== "question").map((s) => s.text), ["Apple", "Very dissatisfied", "Neutral", "Very satisfied"]);
  assert.ok(!apple.some((s) => s.text === "Samsung"), "only the chosen row");
});

test("SPOKEN SCRIPT: custom wording, approved AI wording, locked wording; piping resolved so a loop item is spoken as shown", () => {
  const d = base({ aiConversation: { enabled: true, interaction: "voice" } }, [
    { id: "c1", code: "C1", variableName: "C1", type: "single_select", text: "Which of the following products have you purchased?", options: OPTS.slice(0, 2), spoken: { mode: "custom", question: "Which products have you purchased?" } },
    { id: "c2", code: "C2", variableName: "C2", type: "single_select", text: "How satisfied were you with the overall post-purchase customer service experience?", options: OPTS.slice(0, 2), spoken: { mode: "ai", aiVersion: "How satisfied were you with the customer service after your purchase?", aiApproved: false } },
    { id: "c3", code: "C3", variableName: "C3", type: "single_select", text: "Locked wording.", options: OPTS.slice(0, 2), spoken: { mode: "ai", aiVersion: "Changed.", aiApproved: true, locked: true } },
  ]);
  const ctx = ctxOf(d);
  const seg = (id: string) => spokenSegments(d, d.questions.find((q) => q.id === id)!, ctx, questionAi(d, d.questions.find((q) => q.id === id)!), { options: [] })[0].text;
  assert.equal(seg("c1"), "Which products have you purchased?");
  assert.equal(seg("c2"), "How satisfied were you with the overall post-purchase customer service experience?", "an UNAPPROVED AI version is never spoken");
  const c2 = d.questions.find((q) => q.id === "c2")!; c2.spoken!.aiApproved = true;
  assert.equal(seg("c2"), "How satisfied were you with the customer service after your purchase?", "approved → spoken");
  assert.equal(seg("c3"), "Locked wording.", "locked → the displayed text, whatever was generated");
  // piping: {{Q1}} in Q2's text is resolved before speaking
  setAnswer(d, ctx.state, "q1", ["ap", "go"]);
  const q2seg = spokenSegments(d, d.questions[1], ctx, questionAi(d, d.questions[1]), { options: d.questions[1].options })[0].text;
  assert.equal(q2seg, "How satisfied are you with Apple, Google?");
  assert.equal(pronounce("Xiaomi and xiaomi phones", { Xiaomi: "shao-mee" }), "shao-mee and shao-mee phones", "whole words, case-insensitive");
  assert.equal(pronounce("Xiaomis", { Xiaomi: "shao-mee" }), "Xiaomis", "not inside a longer word");
});

test("VOICE COMMANDS are recognised, and only the applicable ones are offered", () => {
  assert.deepEqual(parseVoiceCommand("Next"), { kind: "next" });
  assert.deepEqual(parseVoiceCommand("go back"), { kind: "back" });
  assert.deepEqual(parseVoiceCommand("Repeat the question"), { kind: "repeat" });
  assert.deepEqual(parseVoiceCommand("I didn't understand"), { kind: "clarify" });
  assert.deepEqual(parseVoiceCommand("read options"), { kind: "read_options" });
  assert.deepEqual(parseVoiceCommand("Repeat options"), { kind: "read_options" });
  assert.deepEqual(parseVoiceCommand("Select Apple"), { kind: "select", target: "apple" });
  assert.deepEqual(parseVoiceCommand("Remove Samsung"), { kind: "remove", target: "samsung" });
  assert.deepEqual(parseVoiceCommand("None of the above"), { kind: "none" });
  assert.deepEqual(parseVoiceCommand("Other"), { kind: "other" });
  assert.deepEqual(parseVoiceCommand("Help"), { kind: "help" });
  assert.deepEqual(parseVoiceCommand("Yes, that's correct"), null, "a sentence is an answer, not a command…");
  assert.deepEqual(parseVoiceCommand("correct"), { kind: "confirm", yes: true });
  assert.deepEqual(parseVoiceCommand("Apple and Samsung"), null, "…and so is this");
  const d = base();
  const multi = applicableCommands(d.questions[0], false, true, true);
  assert.ok(multi.includes("remove") && multi.includes("none") && multi.includes("other") && multi.includes("read_options") && multi.includes("back"));
  const single = applicableCommands(d.questions[1], false, false, true);
  assert.ok(!single.includes("remove") && !single.includes("back") && !single.includes("none"), "no removal on a single select; no back on page 1; no none option");
  assert.ok(applicableCommands(d.questions[4], false, false, true).includes("row"), "a grid takes 'rate Apple first'");
  assert.ok(!applicableCommands({ ...d.questions[1], required: true }, false, false, true).includes("skip"), "a required question cannot be skipped by voice");
});

test("SPOKEN ANSWERS map to VALUES: single, multi with 'and', natural lists, removal, none/other, hedges → ambiguous, numbers", () => {
  const d = base();
  const q1 = d.questions[0], q2 = d.questions[1], q4 = d.questions[3];
  let m = matchSpokenAnswer(q2, "Satisfied", q2.options, 0.92);
  assert.deepEqual(m.codes, ["4"]); assert.equal(m.ambiguous, false); assert.equal(m.confidence, 0.92, "label match × recognition confidence");
  m = matchSpokenAnswer(q1, "Apple and Samsung.", q1.options);
  assert.deepEqual(m.codes, ["ap", "sa"]);
  m = matchSpokenAnswer(q1, "Apple, Samsung, and Google", q1.options);
  assert.deepEqual(m.codes, ["ap", "sa", "go"]); assert.deepEqual(m.unmatched, []);
  m = matchSpokenAnswer(q1, "shao mee", q1.options);
  assert.deepEqual(m.codes, ["xi"], "the spoken label is matched too");
  m = matchSpokenAnswer(q1, "remove Samsung", q1.options);
  assert.deepEqual(m.removed, ["sa"]); assert.deepEqual(m.codes, []);
  m = matchSpokenAnswer(q1, "None of the above", q1.options);
  assert.deepEqual(m.codes, ["no"]); assert.equal(m.none, true);
  m = matchSpokenAnswer(q1, "Other", q1.options);
  assert.deepEqual(m.codes, ["ot"]); assert.equal(m.other, true);
  m = matchSpokenAnswer(q1, "Apple, I think", q1.options);
  assert.deepEqual(m.codes, ["ap"]); assert.equal(m.ambiguous, true, "a hedge → confirm before storing");
  m = matchSpokenAnswer(q2, "Pretty happy", q2.options);
  assert.deepEqual(m.codes, [], "no configured synonym → nothing is forced");
  assert.deepEqual(m.unmatched, ["pretty happy"]);
  const withSyn = { ...q2, options: q2.options.map((o) => (o.code === 4 ? { ...o, meta: { synonyms: ["pretty happy", "happy", "good"] } } : o)) };
  m = matchSpokenAnswer(withSyn, "Pretty happy", withSyn.options);
  assert.deepEqual(m.codes, ["4"], "a programmer-configured synonym maps");
  m = matchSpokenAnswer(q4, "Maybe around 200 or something", q4.options);
  assert.equal(m.number, 200); assert.equal(m.ambiguous, true, "an approximate number is flagged, not silently stored");
  m = matchSpokenAnswer(q4, "two hundred and fifty", q4.options);
  assert.equal(m.number, 250); assert.equal(m.ambiguous, false);
  assert.equal(parseSpokenNumber("twelve"), 12); assert.equal(parseSpokenNumber("no idea"), null);
  m = matchSpokenAnswer(q1, "Banana", q1.options);
  assert.deepEqual(m.codes, []); assert.deepEqual(m.unmatched, ["banana"]);
  assert.equal(readBack(q1, ["ap", "sa", "go"], q1.options), "Apple, Samsung and Google");
  assert.equal(readBack(q1, ["xi"], q1.options), "shao-mee", "read back in the spoken form");
});

test("ADAPTIVE → PROBE: survey-wide settings become a ProbeConfig on eligible questions, under the programmer's rules; a question's own probe wins", () => {
  const d = base({ aiConversation: { enabled: true, conversation: "adaptive", adaptive: {
    enabled: true, maxFollowUps: 2, maxDepth: 3, probeStyle: "warm", researchObjective: "Understand drivers of dissatisfaction with delivery.", allowedTopics: ["delivery", "packaging"], restrictedTopics: ["income", "health"], applyTo: "all",
    rules: [
      { when: { type: "rule", source: { kind: "question", ref: "Q2" }, operator: "in", value: [4, 5] }, maxFollowUps: 0, label: "satisfied → no follow-up" },
      { when: { type: "rule", source: { kind: "question", ref: "Q2" }, operator: "in", value: [1, 2] }, maxFollowUps: 2 },
    ],
  } } });
  const ctx = ctxOf(d);
  const q2 = d.questions[1], q3 = d.questions[2];
  setAnswer(d, ctx.state, "q2", 4);
  assert.equal(effectiveProbe(d, q3, ctx), null, "IF Q2 = Satisfied THEN no follow-up — a rule that says 0 is a rule");
  setAnswer(d, ctx.state, "q2", 2);
  const p = effectiveProbe(d, q3, ctx)!;
  assert.equal(p.maxProbes, 2);
  assert.match(p.instruction!, /Research objective: Understand drivers/);
  assert.match(p.instruction!, /Never ask about: income, health/);
  assert.match(p.instruction!, /Style: warm/);
  assert.match(p.instruction!, /never suggest a preferred answer/);
  assert.equal(effectiveProbe(d, q2, ctx)!.maxProbes, 2, "applyTo: all → the satisfaction scale itself gets a follow-up");
  assert.equal(probeSourceTextFor(q2, 2), "Dissatisfied", "…about the LABEL the respondent saw, not the code");
  assert.equal(nextProbe(q2, ctx, effectiveProbe(d, q2, ctx)), 1);
  // a question's own probe is not overridden by the survey
  const own = { ...q3, probe: { maxProbes: 1, minWords: 0, required: false, prompt: "Say more?" } } as typeof q3;
  assert.equal(effectiveProbe(d, own, ctx)!.prompt, "Say more?");
  // maxDepth caps the survey default
  const deep = base({ aiConversation: { enabled: true, conversation: "adaptive", adaptive: { enabled: true, maxFollowUps: 5, maxDepth: 2 } } });
  assert.equal(effectiveProbe(deep, deep.questions[2], ctxOf(deep))!.maxProbes, 2);
  // not adaptive → nothing
  assert.equal(effectiveProbe(base({ aiConversation: { enabled: true, conversation: "conversational" } }), q3, ctx), null);
  assert.equal(effectiveProbe(base(), q3, ctx), null);
});

test("acknowledgements are brief and never evaluative; interviewer style changes tone, not meaning", () => {
  const c = effectiveAiConversation(base({ aiConversation: { enabled: true, conversation: "conversational", interviewer: { style: "warm" } } }));
  const acks = [0, 1, 2, 3].map((n) => acknowledgement(c, n)!);
  for (const a of acks) assert.ok(!/great|good choice|excellent|perfect|wonderful/i.test(a), `no praise: ${a}`);
  assert.equal(acknowledgement(effectiveAiConversation(base({ aiConversation: { enabled: true, conversation: "standard" } })), 0), null, "standard mode does not chat");
  assert.match(probeInstruction(c), /Avoid leading, suggestive, approving or disapproving, persuasive language/);
});

test("TRANSCRIPTS beside the normalised answer: stored when allowed, columns declared when voice is on, absent otherwise", () => {
  const d = base({ aiConversation: { enabled: true, interaction: "text_voice" } });
  const names = buildVariableDictionary(d).map((v) => v.name);
  assert.ok(names.includes("BRANDS_VOICE_TRANSCRIPT") && names.includes("BRANDS_VOICE_CONFIDENCE") && names.includes("SAT_VOICE_REPEATS"));
  const state = createResponseState(d, { seed: 1 });
  setAnswer(d, state, "q1", ["ap", "sa"]);
  recordVoice(state.answers as Record<string, unknown>, "q1", { transcript: "I'd say Apple and maybe Samsung.", confidence: 0.88, repeats: 1, clarifications: 1 }, true);
  const flat = flattenVariables(d, state);
  assert.deepEqual(flat.BRANDS, ["ap", "sa"], "the normalised answer");
  assert.equal(flat.BRANDS_VOICE_TRANSCRIPT, "I'd say Apple and maybe Samsung.", "the raw transcript, separately");
  assert.equal(flat.BRANDS_VOICE_CONFIDENCE, 0.88);
  assert.equal(flat.BRANDS_VOICE_REPEATS, 1);
  // don't store: the transcript is dropped, the counts stay
  recordVoice(state.answers as Record<string, unknown>, "q2", { transcript: "satisfied", confidence: 0.9, repeats: 2 }, false);
  assert.equal((state.answers[voiceKey("q2")] as { transcript: string }).transcript, "");
  const text = base({ aiConversation: { enabled: true, interaction: "text" } });
  assert.ok(!buildVariableDictionary(text).some((v) => /_VOICE_/.test(v.name)), "text-only: no voice columns");
  const off = base({ aiConversation: { enabled: true, interaction: "voice", voice: { interaction: { transcript: "dont_store" } } } });
  assert.ok(!buildVariableDictionary(off).some((v) => /_VOICE_TRANSCRIPT/.test(v.name)), "transcript off → no transcript column");
});

test("LINT says what is inconsistent, in words", () => {
  assert.deepEqual(lintAiConversation(base()), [], "off → nothing");
  const l = lintAiConversation(base({ aiConversation: { enabled: true, conversation: "adaptive", adaptive: { enabled: false } } }));
  assert.match(l[0], /set to Adaptive but adaptive follow-ups are off/);
  const l2 = lintAiConversation(base({ aiConversation: { enabled: true, conversation: "adaptive", adaptive: { enabled: true, stayWithinObjective: true } } }));
  assert.match(l2[0], /no objective is written/);
  const l3 = lintAiConversation(base({ aiConversation: { enabled: true, interaction: "voice", voice: { reading: { question: false, options: false } } } }));
  assert.match(l3[0], /respondents will hear nothing/);
  const l4 = lintAiConversation(base({ aiConversation: { enabled: true } }, [{ id: "z", code: "Z", variableName: "Z", type: "open_text", text: "z", spoken: { mode: "custom" } }]));
  assert.match(l4[0], /Z: spoken text is set to Custom but no custom wording/);
});
