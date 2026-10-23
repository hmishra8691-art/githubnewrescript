import { test } from "node:test";
import assert from "node:assert/strict";
import { QualStudy } from "@rescript/schema";
import { buildModeratorPlan, finishTurn, prepareTurn, startInterview, type PreparedTurn } from "./aiModerator.js";
import { EN_MESSAGES, PARTICIPANT_MESSAGE_KEYS } from "./aiInterviewMessages.js";
import { EN_WORDS, MODERATOR_WORD_KEYS } from "./aiInterviewWords.js";
import {
  BUILTIN_INTERVIEW_LANGUAGES, BUILTIN_MESSAGES, BUILTIN_WORDS, formatMessage, isRtlLanguage, moderatorWordPack, nativeLanguageName, parseAcceptLanguage,
  participantMessages, pickInterviewLanguage,
} from "./aiInterviewLanguages.js";
import { buildLanguagePack, guideSourceTexts, languagePackStatus, languagesNeedingPacks, localizePlan, packSourceItems, publicTextFor } from "./aiInterviewLocalize.js";
import { inLanguage } from "./aiInterviewSafety.js";
import { launchProblems, publicStudyView } from "./aiInterviewStudy.js";

/*
 * THE AI INTERVIEW IN EVERY LANGUAGE (G1 2026-10-22): every label of the participant page and every word
 * the rules say exist in each of the 20 built-in languages (no key missing, placeholders kept, the right
 * script); RTL languages are known; the participant's language is picked from the study's languages and
 * the browser; a study language without built-in wording gets a language pack; the scripted fallback
 * continues in the participant's language when the AI provider fails.
 */

const REQUIRED = ["en", "hi", "mr", "bn", "ta", "te", "gu", "kn", "ml", "pa", "ur", "ar", "es", "pt", "fr", "de", "id", "ja", "zh", "ko"];
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
/* each language's script: a message must be mostly in it (brand words like "AI" and emoji aside) */
const SCRIPT: Record<string, RegExp> = { hi: /[ऀ-ॿ]/, mr: /[ऀ-ॿ]/, bn: /[ঀ-৿]/, ta: /[஀-௿]/, te: /[ఀ-౿]/, gu: /[઀-૿]/, kn: /[ಀ-೿]/, ml: /[ഀ-ൿ]/, pa: /[਀-੿]/, ur: /[؀-ۿ]/, ar: /[؀-ۿ]/, ja: /[぀-ヿ一-鿿]/, zh: /[一-鿿]/, ko: /[가-힯]/ };

test("catalog completeness: every key in every built-in language, non-empty, placeholders kept, in the language's script", () => {
  assert.deepEqual([...BUILTIN_INTERVIEW_LANGUAGES].sort(), [...REQUIRED].sort());
  for (const lang of REQUIRED) {
    const m = BUILTIN_MESSAGES[lang];
    assert.ok(m, lang);
    assert.deepEqual(Object.keys(m).sort(), [...PARTICIPANT_MESSAGE_KEYS].sort(), `${lang}: keys`);
    for (const k of PARTICIPANT_MESSAGE_KEYS) {
      assert.ok(m[k].trim(), `${lang}.${k} is empty`);
      assert.equal(placeholders(m[k]), placeholders(EN_MESSAGES[k]), `${lang}.${k}: placeholders`);
      if (lang !== "en" && m[k].length > 12) assert.notEqual(m[k], EN_MESSAGES[k], `${lang}.${k} is still English`);
      const re = SCRIPT[lang];
      if (re) {
        const letters = [...m[k].replace(/\{\w+\}|AI|IA|KI/g, "")].filter((c) => /\p{L}/u.test(c));
        if (letters.length >= 3) assert.ok(letters.filter((c) => re.test(c)).length / letters.length >= 0.6, `${lang}.${k} is not in its script: ${m[k]}`);
      }
    }
  }
});

test("the moderator's rule wording: every key in every built-in language, {name}/{topic} kept, the participant's language passes the output check", () => {
  for (const lang of REQUIRED) {
    const w = BUILTIN_WORDS[lang];
    assert.deepEqual(Object.keys(w).sort(), [...MODERATOR_WORD_KEYS].sort(), lang);
    for (const k of MODERATOR_WORD_KEYS) {
      assert.ok(w[k].trim(), `${lang}.${k}`);
      assert.equal(placeholders(w[k]), placeholders(EN_WORDS[k]), `${lang}.${k}: placeholders`);
      if (k !== "intro") assert.ok(inLanguage(w[k], lang), `${lang}.${k} fails the language check: ${w[k]}`);
    }
    /* questions end with a question mark the output check recognises */
    for (const k of ["probe1", "probe2", "probe3", "feel", "coverage"] as const) assert.match(w[k], /[?？؟]/, `${lang}.${k}`);
    assert.match(w.checkIn, /[?？؟]/, `${lang}: the check-in asks whether to stop or continue`);
  }
});

test("RTL languages, native names, Accept-Language and the picked language", () => {
  for (const l of ["ar", "ur", "fa", "he", "ar-EG", "ur_PK"]) assert.equal(isRtlLanguage(l), true, l);
  for (const l of ["en", "hi", "ja", "es"]) assert.equal(isRtlLanguage(l), false, l);
  assert.equal(nativeLanguageName("hi"), "हिन्दी (Hindi)");
  assert.equal(nativeLanguageName("en"), "English");
  assert.deepEqual(parseAcceptLanguage("hi-IN,hi;q=0.9,en-US;q=0.8,en;q=0.7,*;q=0.1"), ["hi", "en"]);
  assert.deepEqual(parseAcceptLanguage("fr;q=0.2, de"), ["de", "fr"]);
  assert.equal(pickInterviewLanguage({ studyLanguages: ["en", "hi"], preferences: ["ta", "hi"] }), "hi");
  assert.equal(pickInterviewLanguage({ studyLanguages: ["en", "hi"], preferences: ["ta"] }), "en", "not offered → the study's first");
  assert.equal(pickInterviewLanguage({ studyLanguages: [], preferences: ["ur-PK"] }), "ur", "any language → theirs");
  assert.equal(pickInterviewLanguage({ studyLanguages: [], preferences: [], guideLanguage: "es" }), "es");
  assert.equal(formatMessage(BUILTIN_MESSAGES.es.speaking, { persona: "Maya" }), "Maya está hablando: habla para interrumpir");
  /* a language without built-in labels: the study's translated labels, English for any key it lacks */
  const sw = participantMessages("sw", { start: "Anza mahojiano" });
  assert.equal(sw.start, "Anza mahojiano"); assert.equal(sw.send, "Send");
  assert.equal(moderatorWordPack("sw"), null, "no built-in wording and no pack");
  assert.equal(moderatorWordPack("sw", { thanks: "Asante." })!.thanks, "Asante.");
});

const study = (over: Record<string, unknown> = {}) => QualStudy.parse({
  kind: "interview", title: "Switching", durationMinutes: 15, objectives: ["Understand what triggers switching"],
  consent: { statement: "Taking part is voluntary.", recordingDisclosure: "Audio may be recorded." },
  sections: [
    { id: "s1", title: "Intro", kind: "opening", script: "Thanks for joining." },
    { id: "s2", title: "Triggers", questions: [{ id: "s2q1", text: "Tell me about the last time you thought about changing provider.", probes: ["What happened next?"], conditionalProbes: [{ ifMentions: "price", ask: "What would a fair price have been?" }] }, { id: "s2q2", text: "How did you feel then?" }] },
    { id: "s3", title: "Close", kind: "closing", questions: [{ id: "s3q1", text: "Is there anything else you would like to add?" }] },
  ],
  aiModeration: { modes: ["text", "voice"], languages: ["en", "es", "sw"], screener: [{ id: "scr1", text: "Who pays the bill?", options: [{ label: "I do" }, { label: "Someone else", qualifies: false }] }], ...((over.aiModeration as object) ?? {}) },
});

/* a stand-in translator: deterministic, marks each language */
const fakeTranslate = (lang: string, items: { key: string; text: string }[]) => Object.fromEntries(items.map((i) => [i.key, lang === "es" ? `ES: ${i.text}` : `SW: ${i.text}`]));

test("language packs: what is translated, the status before launch, a stale pack after the guide changes", () => {
  const s = study();
  const keys = guideSourceTexts(s).map((i) => i.key);
  for (const k of ["title", "q:s2q1", "probe:s2q1:0", "if:s2q1:0", "ask:s2q1:0", "q:s2q2", "q:s3q1", "opening", "obj:O1", "consent.statement", "consent.recording", "scr:scr1", "scr:scr1:0", "scr:scr1:1"]) assert.ok(keys.includes(k), k);
  /* Spanish has built-in labels and wording: only the guide; Swahili: the guide, the wording and the labels */
  const es = packSourceItems(s, "es"), sw = packSourceItems(s, "sw");
  assert.ok(!es.some((i) => i.key.startsWith("w:") || i.key.startsWith("ui:")));
  assert.equal(sw.filter((i) => i.key.startsWith("w:")).length, MODERATOR_WORD_KEYS.length);
  assert.equal(sw.filter((i) => i.key.startsWith("ui:")).length, PARTICIPANT_MESSAGE_KEYS.length);
  assert.deepEqual(languagesNeedingPacks(s, "en"), ["es", "sw"]);
  assert.ok(launchProblems(s).warnings.some((w) => /translated into es, sw for the scripted fallback/.test(w)));
  const packs = { es: buildLanguagePack(s, "es", fakeTranslate("es", es)), sw: buildLanguagePack(s, "sw", fakeTranslate("sw", sw)) };
  const withPacks = QualStudy.parse({ ...s, aiModeration: { ...s.aiModeration, translations: packs } });
  assert.deepEqual(languagesNeedingPacks(withPacks, "en"), []);
  assert.deepEqual(languagePackStatus(withPacks, "sw").missing, []);
  const edited = QualStudy.parse({ ...withPacks, sections: withPacks.sections.map((x) => x.id === "s2" ? { ...x, questions: [{ ...x.questions[0], text: "Tell me about switching." }, x.questions[1]] } : x) });
  assert.equal(languagePackStatus(edited, "es").stale, true, "the guide changed after the pack was made");
  assert.deepEqual(languagesNeedingPacks(edited, "en"), ["es", "sw"]);
  /* the public view in Spanish: consent and screener translated (the screener's values stay the original labels on the server) */
  const pub = publicTextFor(publicStudyView(withPacks), packs.es, [{ id: "scr1", options: [{}, {}] }]);
  assert.equal(pub.consent?.statement, "ES: Taking part is voluntary.");
  assert.deepEqual(pub.screener?.scr1, { text: "ES: Who pays the bill?", options: ["ES: I do", "ES: Someone else"] });
});

const model = (p: PreparedTurn) => { assert.equal(p.kind, "model"); return p as Extract<PreparedTurn, { kind: "model" }>; };
const T0 = Date.parse("2026-10-22T10:00:00Z");

test("the scripted fallback in a third language: the AI provider fails → the guide's questions in Spanish, the rules' words in Spanish", () => {
  const s = study();
  const es = buildLanguagePack(s, "es", fakeTranslate("es", packSourceItems(s, "es")));
  const plan = localizePlan(buildModeratorPlan(s, { guideLanguage: "en" }), "es", es);
  assert.equal(plan.localized, "es"); assert.equal(plan.guideLanguage, "en", "the guide's language does not change");
  /* the opening needs no model: it is the pack's (reviewed) wording */
  const open = startInterview(plan, { now: T0, language: "es" });
  assert.equal(open.kind, "final");
  if (open.kind !== "final") return;
  assert.equal(open.reply.say, "Hola, soy Alex, un entrevistador de IA. ES: Thanks for joining. ES: Tell me about the last time you thought about changing provider.");
  /* a full answer, the provider fails → "Gracias." + the next question in Spanish */
  const p = model(prepareTurn(plan, open.state, { kind: "answer", text: "Cambiamos de compañía cuando la velocidad bajó todas las noches durante un mes entero." }, { now: T0 + 60_000 }));
  const out = finishTurn(plan, p, null, { now: T0 + 61_000 });
  assert.equal(out.reply.decision.source, "fallback");
  assert.equal(out.reply.say, "Gracias. ES: How did you feel then?");
  /* a thin answer, the provider fails → the guide's own probe, translated */
  const p2 = model(prepareTurn(plan, open.state, { kind: "answer", text: "no sé" }, { now: T0 + 60_000 }));
  const out2 = finishTurn(plan, p2, new Error("503"), { now: T0 + 61_000 });
  assert.equal(out2.reply.say, "ES: What happened next?");
  assert.equal(out2.reply.intent, "probe");
});

test("the scripted fallback in a language with no built-in wording (Swahili): the pack's wording, the conditional probe in Swahili", () => {
  const s = study();
  const sw = buildLanguagePack(s, "sw", fakeTranslate("sw", packSourceItems(s, "sw")));
  const plan = localizePlan(buildModeratorPlan(s, { guideLanguage: "en" }), "sw", sw);
  const open = startInterview(plan, { now: T0, language: "sw" });
  assert.equal(open.kind, "final");
  if (open.kind !== "final") return;
  assert.match(open.reply.say, /^SW: Hi, I'm Alex, an AI interviewer\. SW: Thanks for joining\. SW: Tell me about the last time/);
  /* the guide's conditional probe fires on the Swahili trigger word (the pack's) */
  const r = prepareTurn(plan, open.state, { kind: "answer", text: "SW: price ilipanda" }, { now: T0 + 60_000 });
  assert.equal(r.kind, "final");
  if (r.kind === "final") assert.equal(r.reply.say, "SW: What would a fair price have been?");
  /* a stop: the closing in the pack's wording */
  const stop = prepareTurn(plan, open.state, { kind: "stop" }, { now: T0 + 60_000 });
  assert.equal(stop.kind, "final");
  if (stop.kind === "final") assert.equal(stop.reply.say.startsWith("SW: Of course"), true);
});

test("the participant's own language without a pack keeps the old behaviour (English rules; the model translates)", () => {
  const s = study({ aiModeration: { languages: [] } });
  const plan = buildModeratorPlan(s, { guideLanguage: "en" });
  const open = startInterview(plan, { now: T0, language: "sw", modelAvailable: false });
  assert.equal(open.kind, "final");
  if (open.kind === "final") assert.match(open.reply.say, /^Hi, I'm Alex/);
  /* a built-in language with no pack: the rules speak it, the guide's words stay as written */
  const hi = startInterview(plan, { now: T0, language: "ta", modelAvailable: false });
  if (hi.kind === "final") assert.match(hi.reply.say, /^வணக்கம், நான் Alex/);
});
