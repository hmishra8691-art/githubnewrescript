import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UNSUPPORTED_MESSAGE, outsideNote } from "@rescript/engine";
import { NOTICES, replyLanguage, type ReplyLanguage } from "./notices.ts";
import { honestReply, coerceCopilotReply } from "./prompt.ts";

/**
 * The Studio's own sentences in a copilot reply follow the researcher's language (2026-10-18): a Hindi,
 * Hinglish, Marathi or Urdu conversation is no longer told "Nothing was changed: …" in English.
 */
test("the researcher's language: English, Hindi, Hinglish, Marathi, Urdu — from the production prompts", () => {
  const cases: [string, ReplyLanguage][] = [
    ["Make Q1 required", "en"],
    ["Create a calculation SUPPORT_SCORE as the average of the Q5 rows", "en"],
    ["Please apply the changes. It is good.", "en"],
    ["जो changes अभी आपने किया उसे reward back कर दो क्योंकि ये worthless है", "hi"],
    ["Q7 में अगर मैं Option 5 सिलेक्ट करूं तो मुझे एक warning message दिखे", "hi"],
    ["मुझे ख्योशन 3 पे जावस्यूप लगाना अगर एज एटिन के ऊपर मैं टाइप करता हूँ", "hi"],
    ["Q3 pe mujhe javascript lagana hai, agar age ki value 18 ke upar dalta hu to wahan pe automatic popup hokar aana chahiye", "hinglish"],
    ["tariff thread ko quotient 9 ke baad hi rakho wo sahi rahega", "hinglish"],
    ["SUPPORT_SCORE calculate karo Q5 ke rows se", "hinglish"],
    ["मला हाँ पाइजे कि सारे कोश्ण टेक्सलातो मी मराठीला विचारा मराठी मदे विचारा", "mr"],
    ["सगळे प्रश्न मराठीत करा", "mr"],
    ["مجھے Q3 میں ایک جاوا سکرپٹ لگانی ہے یہ اگر میں اپشنل ون سیلیکٹ کرتا ہوں", "ur"],
    ["", "en"],
  ];
  for (const [t, want] of cases) assert.equal(replyLanguage(t), want, t);
});

test("the production corpus: every prompt gets a language, and the Devanagari / Urdu ones are never English", () => {
  const corpus = JSON.parse(readFileSync(new URL("./fixtures/productionPrompts.json", import.meta.url), "utf8")) as { cases: { id: string; prompt: string }[] };
  for (const c of corpus.cases) {
    const l = replyLanguage(c.prompt);
    if (/[؀-ۿ]/.test(c.prompt)) assert.equal(l, "ur", c.id);
    else if ((c.prompt.match(/[ऀ-ॿ]/g) ?? []).length > 20) assert.ok(l === "hi" || l === "mr", `${c.id}: ${l}`);
  }
});

const refusedAll = [{ ok: false, description: "Create block “Screener”", error: "a block with this title exists" }];
const proposal = (reply: string) => coerceCopilotReply({ kind: "proposal", reply, actions: [{ op: "create_block", title: "Screener" }] })!;

test("“nothing was changed” in the researcher's language; the engine's reason is quoted as it is", () => {
  const want: Record<ReplyLanguage, RegExp> = {
    en: /^Nothing was changed: none of the 1 proposed change could be applied \(Create block “Screener” — a block with this title exists\)\. /,
    hi: /^कुछ भी नहीं बदला: प्रस्तावित 1 बदलाव में से कोई भी लागू नहीं हो सका \(Create block “Screener” — a block with this title exists\)।/,
    hinglish: /^Kuch bhi nahi badla: proposed 1 change mein se koi bhi apply nahi ho saka/,
    mr: /^काहीही बदलले नाही: /,
    ur: /^کچھ بھی نہیں بدلا: /,
  };
  for (const lang of Object.keys(want) as ReplyLanguage[]) {
    const r = honestReply(proposal("ठीक है, screener जोड़ रहा हूँ।"), refusedAll, lang);
    assert.match(r.reply, want[lang], lang);
    assert.ok(r.reply.endsWith("ठीक है, screener जोड़ रहा हूँ।"), "the model's own words follow");
    if (lang !== "en") assert.doesNotMatch(r.reply, /Nothing was changed/, lang);
  }
  assert.match(honestReply(proposal("x"), refusedAll).reply, /^Nothing was changed/, "no language given: English, as before");
});

test("a claimed change with nothing proposed — English and Indic claims — gets the notice in the researcher's language", () => {
  const answer = (reply: string) => coerceCopilotReply({ kind: "answer", reply })!;
  assert.match(honestReply(answer("I've added the screener."), null, "hi").reply, /अभी तक कुछ नहीं बदला है/);
  assert.match(honestReply(answer("मैंने screener जोड़ दिया है।"), null, "hi").reply, /अभी तक कुछ नहीं बदला है/, "a Hindi claim is caught too");
  assert.match(honestReply(answer("Maine screener add kar diya hai."), null, "hinglish").reply, /Abhi tak kuch nahi badla/);
  assert.match(honestReply(answer("میں نے screener شامل کر دیا ہے"), null, "ur").reply, /ابھی تک کچھ نہیں بدلا/);
  assert.equal(honestReply(answer("Q3 asks about age."), null, "hi").reply, "Q3 asks about age.", "an answer that claims nothing is untouched");
});

test("the other notices: nothing built, the outside part, unsupported, the brief's one question — English unchanged, the rest translated", () => {
  const langs: ReplyLanguage[] = ["en", "hi", "hinglish", "mr", "ur"];
  for (const l of langs) {
    for (const s of [NOTICES.nothingBuilt(l, 2), NOTICES.outside(l, ["book me a flight"], outsideNote(["book me a flight"])), NOTICES.unsupported(l, UNSUPPORTED_MESSAGE), NOTICES.briefQuestion(l, "Which markets?"), NOTICES.briefQuestion(l, null), NOTICES.notChangedYet(l)]) {
      assert.ok(s.length > 20, `${l}: ${s}`);
      if (l === "en") continue;
      assert.doesNotMatch(s, /^(?:Nothing|This request|Before I plan|I could not|This part)/, `${l}: ${s}`);
      if (l === "hi" || l === "mr") assert.match(s, /[ऀ-ॿ]/, `${l}: ${s}`);
      if (l === "ur") assert.match(s, /[؀-ۿ]/, `${l}: ${s}`);
    }
  }
  assert.equal(NOTICES.unsupported("en", UNSUPPORTED_MESSAGE), UNSUPPORTED_MESSAGE);
  assert.equal(NOTICES.outside("en", ["x"], outsideNote(["x"])), outsideNote(["x"]));
  assert.match(NOTICES.outside("hi", ["book me a flight"], ""), /“book me a flight”/, "the outside part is quoted as said");
  assert.match(NOTICES.briefQuestion("mr", "Which markets?"), /Which markets\?$/, "the model's question is kept");
});
