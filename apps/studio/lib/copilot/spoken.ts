/**
 * WHAT A RESEARCHER SAID, AS SPEECH-TO-TEXT WROTE IT (production intents, 2026-10-18).
 *
 * Researchers speak Hindi, Hinglish, Marathi and Urdu to Intelligent Mode, often by voice, and the
 * transcript garbles the English survey words in it: "Q1" arrives as क्यूबन / क्यूँ एन, "Q2" as क्यूटू,
 * "question 9" as "quotient 9", "question 3" as ख्योशन 3, "JavaScript" as जावस्यूप / जावसक्रिप्ट /
 * جاوا سکرپٹ, "popup" as पॉप अप / پاپ اپ, "English" as इंग्लिस्ट. Every spelling below was seen in the
 * production operations log (2026-10-06…17) or is the same word's obvious neighbour.
 *
 * Words, not grammar: these choose the CONTEXT a request is sent with (the guides, the questions shown in
 * full) and recognise the few requests the Studio answers without a model (undo, apply). They never
 * decide what a change is — the model and the engine's gate do.
 *
 * Devanagari and Arabic-script words take no \b (JavaScript's word boundary is ASCII-only): their
 * boundaries are written as look-arounds on letters.
 */

/* ------------------------------------------------------------ numbers as spoken */

/** English number words as the transcript writes them in Devanagari / Urdu / Latin, and Hindi's own */
const NUMBER_WORDS: [RegExp, number][] = [
  [/^(?:one|won|wan|वन|वान|बन|एन|एक|ek|ون|ایک)$/i, 1],
  [/^(?:two|too|to|टू|तू|दो|do|ٹو|دو)$/i, 2],
  [/^(?:three|tree|थ्री|थ्रि|तीन|teen|تھری|تین)$/i, 3],
  [/^(?:four|for|फोर|फ़ोर|फॉर|चार|char|فور|چار)$/i, 4],
  [/^(?:five|फाइव|फ़ाइव|फाईव|फाय|फ़ाय|फाव|पांच|पाँच|panch|paanch|فائیو|پانچ)$/i, 5],
  [/^(?:six|सिक्स|सिक्स़|छह|छः|छे|chhe|che|سکس|چھ)$/i, 6],
  [/^(?:seven|सेवन|सात|saat|سیون|سات)$/i, 7],
  [/^(?:eight|एट|एइट|ऐट|आठ|aath|ایٹ|آٹھ)$/i, 8],
  [/^(?:nine|नाइन|नाईन|नौ|nau|نائن|نو)$/i, 9],
  [/^(?:ten|टेन|दस|das|ٹین|دس)$/i, 10],
  [/^(?:eleven|इलेवन|ग्यारह)$/i, 11], [/^(?:twelve|ट्वेल्व|बारह)$/i, 12], [/^(?:thirteen|थर्टीन|तेरह)$/i, 13],
  [/^(?:fourteen|फोर्टीन|चौदह)$/i, 14], [/^(?:fifteen|फिफ्टीन|पंद्रह)$/i, 15], [/^(?:sixteen|सिक्सटीन|सोलह)$/i, 16],
  [/^(?:seventeen|सेवनटीन|सत्रह)$/i, 17], [/^(?:eighteen|एटीन|एइटीन|अठारह)$/i, 18], [/^(?:nineteen|नाइनटीन|उन्नीस)$/i, 19], [/^(?:twenty|ट्वेंटी|बीस)$/i, 20],
];
const DEVANAGARI_DIGITS = "०१२३४५६७८९";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹";
function digitsOf(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d))).replace(/[٠-٩۰-۹]/g, (d) => String(ARABIC_DIGITS.indexOf(d) % 10));
}
/** a spoken number token → its value (digits in any script, or a number word) */
export function spokenNumber(token: string): number | null {
  const t = digitsOf(token.trim().replace(/[.,;:!?।]+$/, ""));
  if (/^\d{1,3}$/.test(t)) return Number(t);
  for (const [re, n] of NUMBER_WORDS) if (re.test(t)) return n;
  return null;
}

/* ------------------------------------------------------------ "question 9" as spoken */

const L = String.raw`[\p{L}\p{M}]`;
/** the word "question(s)" as the transcript writes it (seen: ख्योशन, कोश्यन, कोशन, कोश्ण, कॉष्णस, कुष्ण, क्वेशन, कोशंट, "quotient") */
export const QUESTION_WORD = String.raw`(?:questions?|question\s+(?:number|no\.?|num)|quest(?:ion)?|kwestion|qn|quotients?|sawaa?l|prashn|सवाल|प्रश्न|क्वेश्चन|क्वेश्चंस|क्वेशचन|क्वेशन|क्वेस्चन|क्वेस्टन|क्योश्चन|क्योशन|ख्योशन|ख्वेशन|कोश्चन|कोश्यन|कोशन|कोश्ण|कोशंट|कॉशन|कॉष्णस|कॉष्ण|कोष्ण|कुष्ण|कुशन|प्रेशन|سوال|کوئسچن|کویسچن)`;
/** "Q" as the transcript writes it before a number (क्यू टू, क्यूँ एन, kyu 5) — never "क्यूँ" (why) on its own */
const Q_LETTER = String.raw`(?:q|queue|cue|kyu|kyoo|क्यूँ|क्यूं|क्यों|क्यू|क्यु|کیوں|کیو)(?![\p{M}])`;
/** the same fused into one word: क्यूबन / क्यूवन (Q1), क्यूटू (Q2), क्यूथ्री (Q3) … */
const FUSED = /(?<![\p{L}\p{M}])(?:क्यू|क्यु|क्यूँ)(बन|वन|एन|टू|थ्री|फोर|फ़ोर|फाइव|फाय|सिक्स|सेवन|एट|नाइन|टेन)(?![\p{L}\p{M}])/gu;
const NUMBER_TOKEN = String.raw`(?:\d{1,3}|[०-९]{1,3}|[٠-٩۰-۹]{1,3}|${L}+)`;

/**
 * The question NUMBERS a sentence names the way speech-to-text writes them — "quotient 9", "ख्योशन 3",
 * "क्यू फाय", "क्यूबन", "question number two", "سوال 3" — as numbers (Q9, Q3, Q5, Q1, Q2, Q3). A number
 * that is arithmetic ("the quotient 9/3", "quotient of 9") is not a reference. Plain "Q9" is read by
 * referencedQuestions itself.
 */
export function spokenQuestionNumbers(text: string): number[] {
  const out: number[] = [];
  const t = String(text ?? "").normalize("NFC");
  const push = (n: number | null) => { if (n && n > 0 && n < 1000 && !out.includes(n)) out.push(n); };
  const re = new RegExp(String.raw`(?<![\p{L}\p{M}])(?:${QUESTION_WORD}|${Q_LETTER})\s*(?:[-#.]\s*)?(?:(?:number|no\.?|nambar|नंबर|नम्बर|نمبر)\s*)?(${NUMBER_TOKEN})(?![\p{L}\p{M}])(?!\s*[/*÷×%^]\s*\d)(?![.,]\d)`, "giu");
  for (const m of t.matchAll(re)) {
    const head = m[0].slice(0, m[0].length - m[1].length).trim().toLowerCase();
    const isLetter = new RegExp(String.raw`^${Q_LETTER}\s*[-#.]?$`, "iu").test(head);
    const n = spokenNumber(m[1]);
    // "q" / "क्यू" alone needs a number right after it; "why" (क्यों / क्यूँ) followed by an ordinary word is not a question letter
    if (isLetter && n === null) continue;
    // a Latin "to"/"for"/"do" after "question" is grammar ("question to …"), not "two" / "four"
    if (/^(?:to|too|for|do|won|tree)$/i.test(m[1]) && !isLetter) continue;
    if (isLetter && /^(?:to|too|for|do|won|tree|ek|do|das|nau|che|char|teen)$/i.test(m[1])) continue;
    if (isLetter && /^(?:क्यों|کیوں)/u.test(head) && !/^\d+$/.test(digitsOf(m[1]))) continue;
    push(n);
  }
  for (const m of t.matchAll(FUSED)) push(spokenNumber(m[1]));
  return out;
}

/* ------------------------------------------------------------ look and behaviour words */

/** JavaScript / script as spoken, in Devanagari and Urdu script (seen: जावस्यूप, जावसक्रिप्ट, जावस्ट्रिप्ट, जावस्रिप, जावास्क्रिप्ट, جاوا سکرپٹ) */
export const SPOKEN_SCRIPT = /जाव[ाअ]?\s?स|जावा\s?स्क्रिप्ट|स्क्रिप्ट|सक्रिप्ट|स्क्रिप|जेएस|जे एस|جاوا\s?ا?سکر[یي]?پٹ|جاوا\s?اسکریپت|جافا\s?سكريبت|جاوااسکرپٹ|اسکرپٹ|سکرپٹ|سکریپٹ/u;
/** the same garbled in Latin letters (a Hinglish transcript): "java script", "jawa script", "javascrip" */
export const SPOKEN_SCRIPT_LATIN = /\b(?:java|jawa|jav)\s?scr?ipt?\w*|\bjavascrip\b/i;
/** popup / alert / animation as spoken (पॉप अप, पाप अप, پاپ اپ, एलेट = alert) */
export const SPOKEN_POPUP = /प[ॉाो]प\s?-?\s?अप|पॉपअप|पापअप|पोपअप|अलर्ट|एलर्ट|एलेट|ऐलर्ट|टूलटिप|پاپ\s?‌?\s?اپ|پوپ\s?اپ|پاپ‌اپ|الرٹ|انیمیشن|اینیمیشن|اینیمیشن|ٹول\s?ٹپ/u;

/* ------------------------------------------------------------ languages as spoken */

const LANGS: [string, string, RegExp][] = [
  ["mr", "Marathi", /मराठी|مراٹھی|marathi/iu],
  ["hi", "Hindi", /हिंदी|हिन्दी|ہندی|hindi/iu],
  ["en", "English", /इंग्लिश|इंग्लिस्ट|इंग्लिस|इंगलिश|इंग्लिशमें|अंग्रेज़ी|अंग्रेजी|انگریزی|انگلش|انگلیش|english|inglish/iu],
  ["gu", "Gujarati", /गुजराती|گجراتی|gujarati/iu],
  ["ta", "Tamil", /तमिल|تامل|tamil/iu],
  ["te", "Telugu", /तेलुगु|तेलगू|تیلگو|telugu/iu],
  ["bn", "Bengali", /बंगाली|बांग्ला|बंगला|بنگالی|bengali|bangla/iu],
  ["kn", "Kannada", /कन्नड़|कन्नडा|کنڑ|kannada/iu],
  ["ml", "Malayalam", /मलयालम|ملیالم|malayalam/iu],
  ["pa", "Punjabi", /पंजाबी|پنجابی|punjabi/iu],
  ["ur", "Urdu", /उर्दू|اردو|urdu/iu],
  ["or", "Odia", /ओड़िया|उड़िया|ओडिया|odia|oriya/iu],
  ["as", "Assamese", /असमिया|assamese/iu],
];
/** the languages a sentence names, in any script (codes) */
export function spokenLanguages(text: string): { code: string; name: string }[] {
  return LANGS.filter(([, , re]) => re.test(text)).map(([code, name]) => ({ code, name }));
}
/** "in Marathi / into Marathi" in Hindi, Marathi, Hinglish and Urdu: में, मध्ये, मदे, -त, -ला, mein, میں … or the word for language / translate */
const LANG_CUE = /(?:मराठी|हिंदी|हिन्दी|इंग्लि\S*|अंग्रेज़ी|अंग्रेजी|गुजराती|तमिल|तेलुगु|बंगाली|बांग्ला|कन्नड़|मलयालम|पंजाबी|उर्दू|ओड़िया|उड़िया)(?:त|ला|तून|मध्ये|मधे|मदे|मध्ये)?(?:\s+(?:में|मे|मैं|मध्ये|मधे|मदे|मधी|लैंग्वेज|लँग्वेज|भाषा|भाषेत|भाषेमध्ये|वर्जन|वर्ज़न|version|language|translation|ट्रांसलेट|ट्रांसलेशन|अनुवाद|भाषांतर|कर|करा|करो|बदल|चाहिए|पाहिजे|पाइजे|विचारा|विचारायचे|हवे|हवं))|(?:मराठी|हिंदी|गुजराती|तमिल|बंगाली|पंजाबी|उर्दू)(?:त|ला|तून)(?![\p{L}\p{M}])|(?:ترجمہ|ترجمه|زبان|میں\s+(?:کر|بدل|ترجمہ))|अनुवाद|भाषांतर|ट्रांसलेट|ट्रांसलेशन|ट्रान्सलेट|लैंग्वेज|लँग्वेज|\b(?:marathi|hindi|english|gujarati|tamil|telugu|bengali|punjabi|urdu|kannada|malayalam)\s+(?:me|mein|mai|mai|mein\s+karo|mein\s+kar|me\s+kar|language|version)\b/iu;
/** a request about the survey's LANGUAGE in another script / Hinglish: a language named with a translation cue */
export function spokenTranslation(text: string): boolean {
  return LANG_CUE.test(text) || (spokenLanguages(text).length > 0 && /अनुवाद|ट्रांसलेट|translate|भाषा|लैंग्वेज|ترجمہ|زبان/iu.test(text));
}

/* ------------------------------------------------------------ undo: "take back what you just did" */

const UNDO_VERB = [
  String.raw`\bundo\b`, String.raw`\bun-do\b`, String.raw`\brevert(?:\s+back)?\b`, String.raw`\broll\s?-?\s?back\b`, String.raw`\brol+\s+back\b`, String.raw`\brole\s+back\b`, String.raw`\breward\s+back\b`, String.raw`\breword\s+back\b`, String.raw`\brollback\b`,
  String.raw`\btake\s+(?:it|that|this|them|those|these|(?:the|those|these|your|my|all)\s+(?:last\s+|latest\s+|recent\s+)?(?:ai\s+)?(?:changes?|edits?))\s+back\b`,
  String.raw`\b(?:go|put\s+it)\s+back\s+(?:to\s+)?(?:how|the\s+way|what)\s+it\s+was\b`, String.raw`\brestore\s+(?:the\s+)?(?:previous|earlier|old|last|original)\s+(?:version|survey|state)\b`,
  String.raw`\bwapa?s\s+(?:kar|karo|kardo|kar\s+do|le|lo|le\s+lo)\b`, String.raw`\bp[ae]hle\s+jaisa\b`, String.raw`\b(?:undo|revert|rollback)\s+kar\b`,
  "वापस\\s*(?:कर|करो|करें|कीजिए|कीजिये|ले|लो|लें|लीजिए|ला)", "पहले\\s+जैसा", "पहले\\s+जैसे", "पहले\\s+वाला", "अनडू", "अन\\s?डू", "रिवर्ट", "रोलबैक", "रोल\\s?बैक", "रोल\\s?बॅक", "रिवॉर्ड\\s?बैक", "रिवार्ड\\s?बैक",
  "पूर्ववत", "परत\\s+(?:कर|करा|घे|आण)", "आधीसारखे", "आधी\\s+सारखे",
  /* "हटा दो जो अभी किया" — remove what was just done */
  "(?:हटा|निकाल)\\s*(?:दो|दीजिए|दें|दे)?\\s.{0,25}जो\\s+(?:अभी|आपने|तुमने)", "जो\\s+(?:अभी\\s+)?(?:आपने|तुमने|अभी)\\s+(?:\\S+\\s+){0,2}(?:किया|किए|किये|बदला|जोड़ा)\\s+(?:है\\s+)?(?:उसे|वो|उन्हें|ये|इसे)?\\s*(?:हटा|निकाल)",
  "واپس\\s*(?:کر|کریں|لے|لو)", "پہلے\\s+جیسا", "ان\\s?ڈو", "ریورٹ",
].join("|");
/** "what you just did / the changes / it" — the thing taken back */
const UNDO_REFERENT = /\b(?:changes?|change|edits?|it|that|this|them|those|these|last|latest|recent|previous|before|as\s+it\s+was|what\s+you\s+(?:just\s+)?(?:did|made|changed|added)|you\s+(?:just\s+)?(?:did|made|changed|added))\b|चेंज\S*|बदलाव|परिवर्तन|किया|किए|किये|आपने|तुमने|अभी|जो|सब|ये|यह|पहले|जैसा|बदल|केले|केलेले|आधी|تبدیلی|کیا|ابھی|پہلے/iu;
/** creating something new, or naming a question / an element — then "undo" is part of a request, not the request */
const UNDO_NOT = /\b(?:add|create|insert|make|build|show|display|put|new|button|option|options|question|questions|answer|block|page|respondents?|link|feature|undo\s+button|back\s+button)\b|बटन|ऑप्शन|विकल्प|बनाओ|बनाइए|जोड़ो|जोडो|लगाओ|दिखाओ/iu;

/**
 * "Undo", "revert the changes you just made", "roll back", "reward back कर दो" (STT for roll back),
 * "जो changes अभी आपने किया उसे वापस कर दो", "पहले जैसा कर दो", "wapas kar do" — a request to take back the
 * last Intelligent Mode change. The Studio does it through History (no model call); a request that also
 * creates something or names a question ("revert Q5 to single select", "add an undo button") is not one.
 */
export function undoIntent(text: string): boolean {
  const t = String(text ?? "").normalize("NFC").trim();
  if (!t || t.length > 200) return false;
  if (!new RegExp(UNDO_VERB, "iu").test(t)) return false;
  if (UNDO_NOT.test(t) || /\bQ\d+\b/i.test(t) || spokenQuestionNumbers(t).length) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= 3 || UNDO_REFERENT.test(t);
}

/* ------------------------------------------------------------ apply: "it is good, apply it" */

/** the apply verbs, any language (one must be said) */
const APPLY_VERBS = new Set(["apply", "implement", "commit", "proceed", "go", "ahead", "save", "confirm", "do", "lagao", "laga", "lagado", "kardo", "karo", "kar", "apply", "अप्लाई", "एप्लाई", "अप्लाय", "इंप्लिमेंट", "इम्प्लीमेंट", "इम्प्लिमेंट", "इंप्लीमेंट", "लागू", "लगा", "लगाओ", "लगादो", "सेव", "प्रोसीड", "कन्फर्म", "करो", "कर", "करा", "لگا", "لگاؤ", "اپلائی", "امپلیمنٹ"]);
const APPLY_CORE = new Set(["apply", "implement", "commit", "proceed", "save", "confirm", "ahead", "lagao", "lagado", "अप्लाई", "एप्लाई", "अप्लाय", "इंप्लिमेंट", "इम्प्लीमेंट", "इम्प्लिमेंट", "इंप्लीमेंट", "लागू", "लगाओ", "लगादो", "सेव", "प्रोसीड", "कन्फर्म", "لگاؤ", "اپلائی", "امپلیمنٹ"]);
/** what may surround the verb in a bare confirmation */
const APPLY_FILLER = new Set([
  "please", "pls", "plz", "ok", "okay", "yes", "yeah", "yep", "sure", "great", "good", "fine", "perfect", "nice", "looks", "look", "it", "its", "it's", "is", "that", "that's", "this", "these", "those", "them", "the", "all", "everything", "changes", "change", "now", "then", "and", "so", "lets", "let's", "let", "us", "me", "you", "can", "could", "would", "will", "just", "go", "ahead", "do", "with", "to", "of", "a", "no", "more", "other", "further", "edits", "thanks", "thank", "i", "am", "happy", "fine.", "done", "same", "as", "proposed", "shown",
  "haan", "han", "ha", "ji", "theek", "thik", "hai", "he", "sahi", "badhiya", "accha", "acha", "kar", "karo", "do", "de", "dijiye", "sab", "ye", "yeh", "isko", "inko", "changes", "mujhe", "koi", "aur", "nahi", "nahin", "karna",
  "हाँ", "हां", "हा", "जी", "ठीक", "है", "हैं", "सही", "बढ़िया", "अच्छा", "अच्छे", "कर", "करो", "करें", "दो", "दीजिए", "दें", "सब", "ये", "यह", "इसे", "इन्हें", "इनको", "चेंज", "चेंजस", "चेंजेस", "चेंजेज", "बदलाव", "मुझे", "कोई", "और", "नहीं", "करना", "लेट्स", "प्लीज", "प्लीज़", "ओके", "चलो", "अब", "बस", "होगा", "लगता", "मस्त", "छान", "आहे", "करा", "बरोबर",
  "ہاں", "جی", "ٹھیک", "ہے", "سب", "کر", "دو", "دیں", "یہ", "اب", "پلیز",
]);
const NEGATION = new Set(["not", "don't", "dont", "do not", "never", "mat", "na", "mat.", "नहीं", "मत", "ना", "नको", "مت", "نہیں", "wait", "hold", "stop", "रुको", "ruko"]);

/**
 * A bare confirmation to apply what is proposed — "Please apply the changes. It is good.", "OK apply it",
 * "lets implement", "हाँ लागू कर दो", "मुझे कोई और चेंजस नहीं करना है लेट्स इंप्लिमेंट". Every word must be a
 * confirmation word and one must be an apply verb; a negation next to the verb ("don't apply", "apply मत
 * करो") is not one. Anything with content — a question, an object, an instruction — is a request for the model.
 */
export function applyIntent(text: string): boolean {
  const t = String(text ?? "").normalize("NFC").toLowerCase().replace(/[.,!?।;:"“”'’()]+/g, " ").trim();
  if (!t || t.length > 160) return false;
  const words = t.split(/\s+/).filter(Boolean).map((w) => w.replace(/^let’s$/, "lets"));
  const core = words.map((w, i) => (APPLY_CORE.has(w) || (w === "go" && words[i + 1] === "ahead") || (w === "do" && ["it", "that", "this"].includes(words[i + 1] ?? "")) ? i : -1)).filter((i) => i >= 0);
  if (!core.length) return false;
  if (!words.every((w) => APPLY_FILLER.has(w) || APPLY_VERBS.has(w))) return false;
  // a negation right by the verb: "don't apply", "apply mat karo", "लागू मत करो"
  return !core.some((i) => words.slice(Math.max(0, i - 2), i + 3).some((w) => NEGATION.has(w)));
}
