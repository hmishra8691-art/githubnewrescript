/**
 * THE STUDIO'S OWN SENTENCES, IN THE RESEARCHER'S LANGUAGE (production intents follow-up, 2026-10-18).
 *
 * The model answers in the researcher's language; the notices the Studio adds to its reply — "Nothing was
 * changed: …", "Nothing has been changed yet", "Nothing was built", the part of a request outside the
 * platform, the unsupported-request sentence, the one question back on a brief — were English whatever was
 * asked. A Hindi, Hinglish, Marathi or Urdu conversation now gets them in its own language. The engine's
 * refusal reasons quoted inside them (action names, codes) stay as the engine wrote them.
 */
export type ReplyLanguage = "en" | "hi" | "hinglish" | "mr" | "ur";

/** Marathi words a Hindi sentence does not use (आहे, मला, पाहिजे / पाइजे, मध्ये, नाही, करा, तुम्ही …) */
const MARATHI = /(?<![\p{L}\p{M}])(?:आहे|आहेत|मला|पाहिजे|पाइजे|मध्ये|मधे|मदे|नाही|नको|करा|तुम्ही|तुमचे|केले|केलं|हवे|हवं|विचारा|सगळे|सगळ्या|आणि|मराठीत|प्रश्नांची|आपण|होईल|द्या|घ्या)(?![\p{L}\p{M}])/u;
/** everyday Hindi in Latin letters */
const HINGLISH = /\b(?:hai|hain|ho|karo|kardo|kar|karna|karke|mujhe|mera|meri|mere|nahi|nahin|chahiye|chahta|chahti|lagao|lagana|lagani|wala|wali|kya|aur|mein|mai|ko|ke|ki|ka|pe|par|baad|pehle|sab|sabhi|yeh|ye|woh|wo|jab|tab|tak|agar|toh|rakho|dikhao|banao|bana|hatao|jodo|theek|thik|sahi|accha|acha|bhi|abhi|wahan|yahan)\b/gi;

/** the language the researcher wrote in — enough to choose the Studio's sentences, never the survey's */
export function replyLanguage(text: string): ReplyLanguage {
  const t = String(text ?? "");
  const letters = (re: RegExp) => (t.match(re) ?? []).length;
  const arabic = letters(/[؀-ۿݐ-ݿ]/g), deva = letters(/[ऀ-ॿ]/g), latin = letters(/[A-Za-z]/g);
  if (arabic > 0 && arabic >= deva && arabic * 3 >= latin) return "ur";
  if (deva > 0 && deva * 3 >= latin) return MARATHI.test(t) ? "mr" : "hi";
  if (deva > 0 && MARATHI.test(t)) return "mr";
  if (deva > 0) return "hi";
  const words = t.split(/\s+/).filter(Boolean).length;
  const hindi = (t.match(HINGLISH) ?? []).length;
  return hindi >= 2 && hindi * 5 >= words ? "hinglish" : "en";
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const NOTICES = {
  /** every proposed change was refused */
  nothingChanged(lang: ReplyLanguage, total: number, why: string): string {
    const w = why ? ` (${why})` : "";
    switch (lang) {
      case "hi": return `कुछ भी नहीं बदला: प्रस्तावित ${total} ${plural(total, "बदलाव", "बदलावों")} में से कोई भी लागू नहीं हो सका${w}।`;
      case "hinglish": return `Kuch bhi nahi badla: proposed ${total} ${plural(total, "change", "changes")} mein se koi bhi apply nahi ho saka${w}.`;
      case "mr": return `काहीही बदलले नाही: सुचवलेल्या ${total} ${plural(total, "बदलांपैकी", "बदलांपैकी")} एकही लागू होऊ शकला नाही${w}.`;
      case "ur": return `کچھ بھی نہیں بدلا: تجویز کردہ ${total} ${plural(total, "تبدیلی", "تبدیلیوں")} میں سے کوئی بھی لاگو نہیں ہو سکی${w}۔`;
      default: return `Nothing was changed: none of the ${total} proposed change${total === 1 ? "" : "s"} could be applied${w}.`;
    }
  },
  /** the words claim a change, but no action was proposed */
  notChangedYet(lang: ReplyLanguage): string {
    switch (lang) {
      case "hi": return "(अभी तक कुछ नहीं बदला है — इस जवाब में लागू करने के लिए कोई बदलाव प्रस्तावित नहीं था।)";
      case "hinglish": return "(Abhi tak kuch nahi badla hai — is jawab mein apply karne ke liye koi change propose nahi hua.)";
      case "mr": return "(अजून काहीही बदललेले नाही — या उत्तरात लागू करण्यासाठी कोणताही बदल सुचवलेला नाही.)";
      case "ur": return "(ابھی تک کچھ نہیں بدلا — اس جواب میں لاگو کرنے کے لیے کوئی تبدیلی تجویز نہیں کی گئی۔)";
      default: return "(Nothing has been changed yet — this answer proposed no changes to apply.)";
    }
  },
  /** an approved plan whose items came back empty */
  nothingBuilt(lang: ReplyLanguage, items: number): string {
    switch (lang) {
      case "hi": return `कुछ नहीं बना: स्वीकृत ${plural(items, "आइटम", "आइटम")} बिना किसी बदलाव के लौटे। कुछ नहीं बदला — फिर से बनाने के लिए Resume दबाएँ, या एक-एक block माँगें।`;
      case "hinglish": return `Kuch nahi bana: approved ${plural(items, "item", "items")} bina kisi change ke wapas aaye. Kuch nahi badla — dobara banane ke liye Resume dabaiye, ya ek-ek block maangiye.`;
      case "mr": return `काहीही तयार झाले नाही: मंजूर ${plural(items, "आयटम", "आयटम")} कोणत्याही बदलाशिवाय परत आले. काहीही बदलले नाही — पुन्हा तयार करण्यासाठी Resume दाबा, किंवा एका वेळी एक block मागा.`;
      case "ur": return `کچھ نہیں بنا: منظور شدہ ${plural(items, "آئٹم", "آئٹمز")} بغیر کسی تبدیلی کے واپس آئے۔ کچھ نہیں بدلا — دوبارہ بنانے کے لیے Resume دبائیں، یا ایک وقت میں ایک block مانگیں۔`;
      default: return `Nothing was built: the approved item${items === 1 ? "" : "s"} came back without any changes to apply. Nothing was changed — press Resume to build ${items === 1 ? "it" : "them"} again, or ask for one block at a time.`;
    }
  },
  /** the part of a mixed request outside the platform (the engine's outsideNote, in English) */
  outside(lang: ReplyLanguage, parts: readonly string[], english: string): string {
    const q = parts.slice(0, 3).map((p) => `“${p.replace(/[.!?।]+$/, "")}”`).join(", ");
    switch (lang) {
      case "hi": return `आपके अनुरोध का यह हिस्सा Intelligent Mode की समर्थित क्षमताओं से बाहर है और नहीं किया गया: ${q}। यह engine research planning, hypothesis development, survey design और programming, supported analysis, data-quality workflows, translation और research reporting के लिए है।`;
      case "hinglish": return `Aapki request ka yeh hissa Intelligent Mode ki supported capabilities se bahar hai aur nahi kiya gaya: ${q}. Yeh engine research planning, hypothesis development, survey design aur programming, supported analysis, data-quality workflows, translation aur research reporting ke liye hai.`;
      case "mr": return `तुमच्या विनंतीचा हा भाग Intelligent Mode च्या समर्थित क्षमतांबाहेर आहे आणि केला गेला नाही: ${q}. हे engine research planning, hypothesis development, survey design आणि programming, supported analysis, data-quality workflows, translation आणि research reporting साठी आहे.`;
      case "ur": return `آپ کی درخواست کا یہ حصہ Intelligent Mode کی معاون صلاحیتوں سے باہر ہے اور نہیں کیا گیا: ${q}۔ یہ engine research planning، hypothesis development، survey design اور programming، supported analysis، data-quality workflows، translation اور research reporting کے لیے ہے۔`;
      default: return english;
    }
  },
  /** a request clearly outside the platform (the engine's UNSUPPORTED_MESSAGE, in English) */
  unsupported(lang: ReplyLanguage, english: string): string {
    switch (lang) {
      case "hi": return "यह अनुरोध Intelligent Mode की समर्थित क्षमताओं से बाहर है। आप इस engine का उपयोग research planning, hypothesis development, survey design और programming, supported analysis, data-quality workflows, translation और research reporting के लिए कर सकते हैं।";
      case "hinglish": return "Yeh request Intelligent Mode ki supported capabilities se bahar hai. Aap is engine ko research planning, hypothesis development, survey design aur programming, supported analysis, data-quality workflows, translation aur research reporting ke liye use kar sakte hain.";
      case "mr": return "ही विनंती Intelligent Mode च्या समर्थित क्षमतांबाहेर आहे. तुम्ही हे engine research planning, hypothesis development, survey design आणि programming, supported analysis, data-quality workflows, translation आणि research reporting साठी वापरू शकता.";
      case "ur": return "یہ درخواست Intelligent Mode کی معاون صلاحیتوں سے باہر ہے۔ آپ اس engine کو research planning، hypothesis development، survey design اور programming، supported analysis، data-quality workflows، translation اور research reporting کے لیے استعمال کر سکتے ہیں۔";
      default: return english;
    }
  },
  /**
   * #13 (2026-10-22): a MaxDiff / conjoint design that could not be made — the engine's reasons (as written) and
   * whether it was sent back to the model once. Said after the model's reply, so a reply that claims the design
   * cannot stand alone.
   */
  designRefused(lang: ReplyLanguage, reasons: readonly string[], retried: boolean): string {
    const why = reasons.slice(0, 3).map((r) => r.replace(/\s+/g, " ").trim().slice(0, 400)).join(" · ");
    switch (lang) {
      case "hi": return `ध्यान दें: MaxDiff / conjoint design नहीं बन सका${retried ? " (एक बार सुधार के लिए वापस भेजा गया, फिर भी नहीं बना)" : ""} — ${why}। कृपया ज़रूरी जानकारी दें (जैसे attributes और levels) या शर्तें बदलें।`;
      case "hinglish": return `Dhyan dein: MaxDiff / conjoint design nahi ban saka${retried ? " (ek baar correction ke liye wapas bheja gaya, phir bhi nahi bana)" : ""} — ${why}. Zaroori details dijiye (jaise attributes aur levels) ya conditions badaliye.`;
      case "mr": return `लक्षात घ्या: MaxDiff / conjoint design तयार होऊ शकले नाही${retried ? " (एकदा दुरुस्तीसाठी परत पाठवले, तरीही झाले नाही)" : ""} — ${why}. आवश्यक माहिती द्या (उदा. attributes आणि levels) किंवा अटी बदला.`;
      case "ur": return `نوٹ: MaxDiff / conjoint design نہیں بن سکا${retried ? " (ایک بار درستی کے لیے واپس بھیجا گیا، پھر بھی نہیں بنا)" : ""} — ${why}۔ ضروری تفصیل دیں (جیسے attributes اور levels) یا شرائط بدلیں۔`;
      default: return `Note: the MaxDiff / conjoint design could not be made${retried ? " (it was sent back once for correction and was refused again)" : ""} — ${why}. Nothing was added for it; give what is missing (for example the attributes and their levels) or relax what blocks it, and ask again.`;
    }
  },
  /** the one question back on a brief that could not be planned */
  briefQuestion(lang: ReplyLanguage, q: string | null): string {
    if (q) {
      switch (lang) {
        case "hi": return `इस brief की योजना बनाने से पहले मुझे एक बात चाहिए: ${q}`;
        case "hinglish": return `Is brief ka plan banane se pehle mujhe ek cheez chahiye: ${q}`;
        case "mr": return `या brief ची योजना करण्यापूर्वी मला एक गोष्ट हवी आहे: ${q}`;
        case "ur": return `اس brief کا منصوبہ بنانے سے پہلے مجھے ایک چیز چاہیے: ${q}`;
        default: return `Before I plan this brief I need one thing: ${q}`;
      }
    }
    switch (lang) {
      case "hi": return "मैं अभी इस brief को योजना में नहीं बदल सका। बताइए पहले कौन-सा हिस्सा plan करूँ — जैसे research design और screener — और बाकी मैं वहीं से plan करूँगा।";
      case "hinglish": return "Main abhi is brief ko plan mein nahi badal saka. Bataiye pehle kaunsa hissa plan karun — jaise research design aur screener — aur baaki main wahan se plan karunga.";
      case "mr": return "मी अजून या brief ची योजना करू शकलो नाही. आधी कोणता भाग plan करू ते सांगा — उदा. research design आणि screener — आणि उरलेले मी तिथून plan करेन.";
      case "ur": return "میں ابھی اس brief کو منصوبے میں نہیں بدل سکا۔ بتائیں پہلے کون سا حصہ plan کروں — جیسے research design اور screener — اور باقی میں وہیں سے plan کروں گا۔";
      default: return "I could not turn this brief into a plan yet. Say which part to plan first — for example the research design and the screener — and I will plan the rest from there.";
    }
  },
};
