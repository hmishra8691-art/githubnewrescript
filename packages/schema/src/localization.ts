import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * LOCALIZATION — a layer over the survey, never a copy of it.
 *
 * The survey definition stays language-neutral: one set of question ids,
 * option codes, row codes, column ids, logic, quotas and variables. This
 * object adds, per language, the respondent-facing TEXT for each of those
 * elements and the AUDIO that speaks it — addressed by stable element keys
 * (`q:<questionId>:text`, `q:<questionId>:opt:<code>`, `flow:<nodeId>:message`,
 * `ui:required`, …), never by the text itself. Adding, changing or removing a
 * language therefore cannot change what the survey asks, how it branches or
 * what it stores; the one thing a language changes is what the respondent
 * reads and hears. `SURVEY_LANGUAGE` records which one they got.
 *
 * Translations are versioned in place (a bounded history on each entry), so a
 * change is visible — old text, new text, who, when — and never touches
 * historical response data, which stores codes.
 */

/* ------------------------------------------------------------ languages */

export const TEXT_DIRECTIONS = ["ltr", "rtl"] as const;

export interface LanguageInfo {
  /** ISO 639-1/2 code */
  code: string;
  name: string;
  nativeName: string;
  direction: (typeof TEXT_DIRECTIONS)[number];
  /** the regions this language is spoken in, with their BCP-47 tags — the first is the default */
  locales: { tag: string; country: string; countryName: string; name: string }[];
}

/**
 * THE LANGUAGE LIBRARY — the global set a programmer picks from. Not a
 * restriction: a language absent here can still be added by tag, with a
 * name typed in; this list is what the searchable picker offers first, with
 * the regional variants that matter to research (India's languages, the
 * Spanish and Portuguese and Chinese and French variants).
 */
export const LANGUAGE_LIBRARY: LanguageInfo[] = [
  { code: "en", name: "English", nativeName: "English", direction: "ltr", locales: [
    { tag: "en-US", country: "US", countryName: "United States", name: "American English" }, { tag: "en-GB", country: "GB", countryName: "United Kingdom", name: "British English" },
    { tag: "en-IN", country: "IN", countryName: "India", name: "Indian English" }, { tag: "en-AU", country: "AU", countryName: "Australia", name: "Australian English" },
    { tag: "en-CA", country: "CA", countryName: "Canada", name: "Canadian English" }, { tag: "en-SG", country: "SG", countryName: "Singapore", name: "Singapore English" },
    { tag: "en-ZA", country: "ZA", countryName: "South Africa", name: "South African English" }, { tag: "en-IE", country: "IE", countryName: "Ireland", name: "Irish English" }, { tag: "en-NZ", country: "NZ", countryName: "New Zealand", name: "New Zealand English" } ] },
  { code: "es", name: "Spanish", nativeName: "Español", direction: "ltr", locales: [
    { tag: "es-ES", country: "ES", countryName: "Spain", name: "Spanish (Spain)" }, { tag: "es-MX", country: "MX", countryName: "Mexico", name: "Mexican Spanish" },
    { tag: "es-US", country: "US", countryName: "United States", name: "US Spanish" }, { tag: "es-AR", country: "AR", countryName: "Argentina", name: "Argentine Spanish" },
    { tag: "es-CO", country: "CO", countryName: "Colombia", name: "Colombian Spanish" }, { tag: "es-CL", country: "CL", countryName: "Chile", name: "Chilean Spanish" }, { tag: "es-PE", country: "PE", countryName: "Peru", name: "Peruvian Spanish" } ] },
  { code: "fr", name: "French", nativeName: "Français", direction: "ltr", locales: [
    { tag: "fr-FR", country: "FR", countryName: "France", name: "French (France)" }, { tag: "fr-CA", country: "CA", countryName: "Canada", name: "Canadian French" },
    { tag: "fr-BE", country: "BE", countryName: "Belgium", name: "Belgian French" }, { tag: "fr-CH", country: "CH", countryName: "Switzerland", name: "Swiss French" } ] },
  { code: "de", name: "German", nativeName: "Deutsch", direction: "ltr", locales: [
    { tag: "de-DE", country: "DE", countryName: "Germany", name: "German (Germany)" }, { tag: "de-AT", country: "AT", countryName: "Austria", name: "Austrian German" }, { tag: "de-CH", country: "CH", countryName: "Switzerland", name: "Swiss German" } ] },
  { code: "ru", name: "Russian", nativeName: "Русский", direction: "ltr", locales: [{ tag: "ru-RU", country: "RU", countryName: "Russia", name: "Russian" }] },
  { code: "pt", name: "Portuguese", nativeName: "Português", direction: "ltr", locales: [
    { tag: "pt-BR", country: "BR", countryName: "Brazil", name: "Brazilian Portuguese" }, { tag: "pt-PT", country: "PT", countryName: "Portugal", name: "European Portuguese" } ] },
  { code: "it", name: "Italian", nativeName: "Italiano", direction: "ltr", locales: [{ tag: "it-IT", country: "IT", countryName: "Italy", name: "Italian" }] },
  { code: "nl", name: "Dutch", nativeName: "Nederlands", direction: "ltr", locales: [{ tag: "nl-NL", country: "NL", countryName: "Netherlands", name: "Dutch" }, { tag: "nl-BE", country: "BE", countryName: "Belgium", name: "Flemish" }] },
  { code: "zh", name: "Chinese", nativeName: "中文", direction: "ltr", locales: [
    { tag: "zh-CN", country: "CN", countryName: "China", name: "Simplified Chinese" }, { tag: "zh-TW", country: "TW", countryName: "Taiwan", name: "Traditional Chinese (Taiwan)" },
    { tag: "zh-HK", country: "HK", countryName: "Hong Kong", name: "Traditional Chinese (Hong Kong)" }, { tag: "zh-SG", country: "SG", countryName: "Singapore", name: "Simplified Chinese (Singapore)" } ] },
  { code: "ja", name: "Japanese", nativeName: "日本語", direction: "ltr", locales: [{ tag: "ja-JP", country: "JP", countryName: "Japan", name: "Japanese" }] },
  { code: "ko", name: "Korean", nativeName: "한국어", direction: "ltr", locales: [{ tag: "ko-KR", country: "KR", countryName: "South Korea", name: "Korean" }] },
  { code: "ar", name: "Arabic", nativeName: "العربية", direction: "rtl", locales: [
    { tag: "ar-SA", country: "SA", countryName: "Saudi Arabia", name: "Arabic (Saudi Arabia)" }, { tag: "ar-AE", country: "AE", countryName: "United Arab Emirates", name: "Arabic (UAE)" },
    { tag: "ar-EG", country: "EG", countryName: "Egypt", name: "Egyptian Arabic" }, { tag: "ar-MA", country: "MA", countryName: "Morocco", name: "Moroccan Arabic" } ] },
  { code: "tr", name: "Turkish", nativeName: "Türkçe", direction: "ltr", locales: [{ tag: "tr-TR", country: "TR", countryName: "Turkey", name: "Turkish" }] },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", direction: "ltr", locales: [{ tag: "hi-IN", country: "IN", countryName: "India", name: "Hindi" }] },
  { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી", direction: "ltr", locales: [{ tag: "gu-IN", country: "IN", countryName: "India", name: "Gujarati" }] },
  { code: "mr", name: "Marathi", nativeName: "मराठी", direction: "ltr", locales: [{ tag: "mr-IN", country: "IN", countryName: "India", name: "Marathi" }] },
  { code: "bn", name: "Bengali", nativeName: "বাংলা", direction: "ltr", locales: [{ tag: "bn-IN", country: "IN", countryName: "India", name: "Bengali (India)" }, { tag: "bn-BD", country: "BD", countryName: "Bangladesh", name: "Bengali (Bangladesh)" }] },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்", direction: "ltr", locales: [{ tag: "ta-IN", country: "IN", countryName: "India", name: "Tamil (India)" }, { tag: "ta-LK", country: "LK", countryName: "Sri Lanka", name: "Tamil (Sri Lanka)" }, { tag: "ta-SG", country: "SG", countryName: "Singapore", name: "Tamil (Singapore)" }] },
  { code: "te", name: "Telugu", nativeName: "తెలుగు", direction: "ltr", locales: [{ tag: "te-IN", country: "IN", countryName: "India", name: "Telugu" }] },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ", direction: "ltr", locales: [{ tag: "kn-IN", country: "IN", countryName: "India", name: "Kannada" }] },
  { code: "ml", name: "Malayalam", nativeName: "മലയാളം", direction: "ltr", locales: [{ tag: "ml-IN", country: "IN", countryName: "India", name: "Malayalam" }] },
  { code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", direction: "ltr", locales: [{ tag: "pa-IN", country: "IN", countryName: "India", name: "Punjabi (Gurmukhi)" }, { tag: "pa-PK", country: "PK", countryName: "Pakistan", name: "Punjabi (Shahmukhi)" }] },
  { code: "or", name: "Odia", nativeName: "ଓଡ଼ିଆ", direction: "ltr", locales: [{ tag: "or-IN", country: "IN", countryName: "India", name: "Odia" }] },
  { code: "ur", name: "Urdu", nativeName: "اردو", direction: "rtl", locales: [{ tag: "ur-PK", country: "PK", countryName: "Pakistan", name: "Urdu (Pakistan)" }, { tag: "ur-IN", country: "IN", countryName: "India", name: "Urdu (India)" }] },
  { code: "as", name: "Assamese", nativeName: "অসমীয়া", direction: "ltr", locales: [{ tag: "as-IN", country: "IN", countryName: "India", name: "Assamese" }] },
  { code: "ne", name: "Nepali", nativeName: "नेपाली", direction: "ltr", locales: [{ tag: "ne-NP", country: "NP", countryName: "Nepal", name: "Nepali" }] },
  { code: "si", name: "Sinhala", nativeName: "සිංහල", direction: "ltr", locales: [{ tag: "si-LK", country: "LK", countryName: "Sri Lanka", name: "Sinhala" }] },
  { code: "he", name: "Hebrew", nativeName: "עברית", direction: "rtl", locales: [{ tag: "he-IL", country: "IL", countryName: "Israel", name: "Hebrew" }] },
  { code: "fa", name: "Persian", nativeName: "فارسی", direction: "rtl", locales: [{ tag: "fa-IR", country: "IR", countryName: "Iran", name: "Persian" }] },
  { code: "pl", name: "Polish", nativeName: "Polski", direction: "ltr", locales: [{ tag: "pl-PL", country: "PL", countryName: "Poland", name: "Polish" }] },
  { code: "uk", name: "Ukrainian", nativeName: "Українська", direction: "ltr", locales: [{ tag: "uk-UA", country: "UA", countryName: "Ukraine", name: "Ukrainian" }] },
  { code: "cs", name: "Czech", nativeName: "Čeština", direction: "ltr", locales: [{ tag: "cs-CZ", country: "CZ", countryName: "Czechia", name: "Czech" }] },
  { code: "sk", name: "Slovak", nativeName: "Slovenčina", direction: "ltr", locales: [{ tag: "sk-SK", country: "SK", countryName: "Slovakia", name: "Slovak" }] },
  { code: "hu", name: "Hungarian", nativeName: "Magyar", direction: "ltr", locales: [{ tag: "hu-HU", country: "HU", countryName: "Hungary", name: "Hungarian" }] },
  { code: "ro", name: "Romanian", nativeName: "Română", direction: "ltr", locales: [{ tag: "ro-RO", country: "RO", countryName: "Romania", name: "Romanian" }] },
  { code: "bg", name: "Bulgarian", nativeName: "Български", direction: "ltr", locales: [{ tag: "bg-BG", country: "BG", countryName: "Bulgaria", name: "Bulgarian" }] },
  { code: "el", name: "Greek", nativeName: "Ελληνικά", direction: "ltr", locales: [{ tag: "el-GR", country: "GR", countryName: "Greece", name: "Greek" }] },
  { code: "sv", name: "Swedish", nativeName: "Svenska", direction: "ltr", locales: [{ tag: "sv-SE", country: "SE", countryName: "Sweden", name: "Swedish" }] },
  { code: "da", name: "Danish", nativeName: "Dansk", direction: "ltr", locales: [{ tag: "da-DK", country: "DK", countryName: "Denmark", name: "Danish" }] },
  { code: "nb", name: "Norwegian", nativeName: "Norsk", direction: "ltr", locales: [{ tag: "nb-NO", country: "NO", countryName: "Norway", name: "Norwegian Bokmål" }] },
  { code: "fi", name: "Finnish", nativeName: "Suomi", direction: "ltr", locales: [{ tag: "fi-FI", country: "FI", countryName: "Finland", name: "Finnish" }] },
  { code: "et", name: "Estonian", nativeName: "Eesti", direction: "ltr", locales: [{ tag: "et-EE", country: "EE", countryName: "Estonia", name: "Estonian" }] },
  { code: "lv", name: "Latvian", nativeName: "Latviešu", direction: "ltr", locales: [{ tag: "lv-LV", country: "LV", countryName: "Latvia", name: "Latvian" }] },
  { code: "lt", name: "Lithuanian", nativeName: "Lietuvių", direction: "ltr", locales: [{ tag: "lt-LT", country: "LT", countryName: "Lithuania", name: "Lithuanian" }] },
  { code: "hr", name: "Croatian", nativeName: "Hrvatski", direction: "ltr", locales: [{ tag: "hr-HR", country: "HR", countryName: "Croatia", name: "Croatian" }] },
  { code: "sr", name: "Serbian", nativeName: "Српски", direction: "ltr", locales: [{ tag: "sr-RS", country: "RS", countryName: "Serbia", name: "Serbian" }] },
  { code: "sl", name: "Slovenian", nativeName: "Slovenščina", direction: "ltr", locales: [{ tag: "sl-SI", country: "SI", countryName: "Slovenia", name: "Slovenian" }] },
  { code: "ca", name: "Catalan", nativeName: "Català", direction: "ltr", locales: [{ tag: "ca-ES", country: "ES", countryName: "Spain", name: "Catalan" }] },
  { code: "eu", name: "Basque", nativeName: "Euskara", direction: "ltr", locales: [{ tag: "eu-ES", country: "ES", countryName: "Spain", name: "Basque" }] },
  { code: "gl", name: "Galician", nativeName: "Galego", direction: "ltr", locales: [{ tag: "gl-ES", country: "ES", countryName: "Spain", name: "Galician" }] },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia", direction: "ltr", locales: [{ tag: "id-ID", country: "ID", countryName: "Indonesia", name: "Indonesian" }] },
  { code: "ms", name: "Malay", nativeName: "Bahasa Melayu", direction: "ltr", locales: [{ tag: "ms-MY", country: "MY", countryName: "Malaysia", name: "Malay (Malaysia)" }, { tag: "ms-SG", country: "SG", countryName: "Singapore", name: "Malay (Singapore)" }] },
  { code: "th", name: "Thai", nativeName: "ไทย", direction: "ltr", locales: [{ tag: "th-TH", country: "TH", countryName: "Thailand", name: "Thai" }] },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt", direction: "ltr", locales: [{ tag: "vi-VN", country: "VN", countryName: "Vietnam", name: "Vietnamese" }] },
  { code: "fil", name: "Filipino", nativeName: "Filipino", direction: "ltr", locales: [{ tag: "fil-PH", country: "PH", countryName: "Philippines", name: "Filipino" }] },
  { code: "my", name: "Burmese", nativeName: "မြန်မာ", direction: "ltr", locales: [{ tag: "my-MM", country: "MM", countryName: "Myanmar", name: "Burmese" }] },
  { code: "km", name: "Khmer", nativeName: "ខ្មែរ", direction: "ltr", locales: [{ tag: "km-KH", country: "KH", countryName: "Cambodia", name: "Khmer" }] },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili", direction: "ltr", locales: [{ tag: "sw-KE", country: "KE", countryName: "Kenya", name: "Swahili (Kenya)" }, { tag: "sw-TZ", country: "TZ", countryName: "Tanzania", name: "Swahili (Tanzania)" }] },
  { code: "am", name: "Amharic", nativeName: "አማርኛ", direction: "ltr", locales: [{ tag: "am-ET", country: "ET", countryName: "Ethiopia", name: "Amharic" }] },
  { code: "ha", name: "Hausa", nativeName: "Hausa", direction: "ltr", locales: [{ tag: "ha-NG", country: "NG", countryName: "Nigeria", name: "Hausa" }] },
  { code: "yo", name: "Yoruba", nativeName: "Yorùbá", direction: "ltr", locales: [{ tag: "yo-NG", country: "NG", countryName: "Nigeria", name: "Yoruba" }] },
  { code: "ig", name: "Igbo", nativeName: "Igbo", direction: "ltr", locales: [{ tag: "ig-NG", country: "NG", countryName: "Nigeria", name: "Igbo" }] },
  { code: "zu", name: "Zulu", nativeName: "isiZulu", direction: "ltr", locales: [{ tag: "zu-ZA", country: "ZA", countryName: "South Africa", name: "Zulu" }] },
  { code: "af", name: "Afrikaans", nativeName: "Afrikaans", direction: "ltr", locales: [{ tag: "af-ZA", country: "ZA", countryName: "South Africa", name: "Afrikaans" }] },
  { code: "kk", name: "Kazakh", nativeName: "Қазақ", direction: "ltr", locales: [{ tag: "kk-KZ", country: "KZ", countryName: "Kazakhstan", name: "Kazakh" }] },
  { code: "uz", name: "Uzbek", nativeName: "Oʻzbek", direction: "ltr", locales: [{ tag: "uz-UZ", country: "UZ", countryName: "Uzbekistan", name: "Uzbek" }] },
  { code: "az", name: "Azerbaijani", nativeName: "Azərbaycan", direction: "ltr", locales: [{ tag: "az-AZ", country: "AZ", countryName: "Azerbaijan", name: "Azerbaijani" }] },
  { code: "ka", name: "Georgian", nativeName: "ქართული", direction: "ltr", locales: [{ tag: "ka-GE", country: "GE", countryName: "Georgia", name: "Georgian" }] },
  { code: "hy", name: "Armenian", nativeName: "Հայերեն", direction: "ltr", locales: [{ tag: "hy-AM", country: "AM", countryName: "Armenia", name: "Armenian" }] },
  { code: "mn", name: "Mongolian", nativeName: "Монгол", direction: "ltr", locales: [{ tag: "mn-MN", country: "MN", countryName: "Mongolia", name: "Mongolian" }] },
  { code: "ps", name: "Pashto", nativeName: "پښتو", direction: "rtl", locales: [{ tag: "ps-AF", country: "AF", countryName: "Afghanistan", name: "Pashto" }] },
  { code: "sd", name: "Sindhi", nativeName: "سنڌي", direction: "rtl", locales: [{ tag: "sd-PK", country: "PK", countryName: "Pakistan", name: "Sindhi" }] },
  { code: "ku", name: "Kurdish", nativeName: "Kurdî", direction: "ltr", locales: [{ tag: "ku-TR", country: "TR", countryName: "Turkey", name: "Kurdish (Kurmanji)" }] },
  { code: "is", name: "Icelandic", nativeName: "Íslenska", direction: "ltr", locales: [{ tag: "is-IS", country: "IS", countryName: "Iceland", name: "Icelandic" }] },
  { code: "ga", name: "Irish", nativeName: "Gaeilge", direction: "ltr", locales: [{ tag: "ga-IE", country: "IE", countryName: "Ireland", name: "Irish" }] },
  { code: "cy", name: "Welsh", nativeName: "Cymraeg", direction: "ltr", locales: [{ tag: "cy-GB", country: "GB", countryName: "United Kingdom", name: "Welsh" }] },
  { code: "mt", name: "Maltese", nativeName: "Malti", direction: "ltr", locales: [{ tag: "mt-MT", country: "MT", countryName: "Malta", name: "Maltese" }] },
  { code: "sq", name: "Albanian", nativeName: "Shqip", direction: "ltr", locales: [{ tag: "sq-AL", country: "AL", countryName: "Albania", name: "Albanian" }] },
  { code: "mk", name: "Macedonian", nativeName: "Македонски", direction: "ltr", locales: [{ tag: "mk-MK", country: "MK", countryName: "North Macedonia", name: "Macedonian" }] },
  { code: "bs", name: "Bosnian", nativeName: "Bosanski", direction: "ltr", locales: [{ tag: "bs-BA", country: "BA", countryName: "Bosnia and Herzegovina", name: "Bosnian" }] },
  { code: "lo", name: "Lao", nativeName: "ລາວ", direction: "ltr", locales: [{ tag: "lo-LA", country: "LA", countryName: "Laos", name: "Lao" }] },
  { code: "dz", name: "Dzongkha", nativeName: "རྫོང་ཁ", direction: "ltr", locales: [{ tag: "dz-BT", country: "BT", countryName: "Bhutan", name: "Dzongkha" }] },
  { code: "mi", name: "Māori", nativeName: "Te Reo Māori", direction: "ltr", locales: [{ tag: "mi-NZ", country: "NZ", countryName: "New Zealand", name: "Māori" }] },
  { code: "ht", name: "Haitian Creole", nativeName: "Kreyòl ayisyen", direction: "ltr", locales: [{ tag: "ht-HT", country: "HT", countryName: "Haiti", name: "Haitian Creole" }] },
];

export function languageInfo(code: string): LanguageInfo | undefined {
  const c = code.toLowerCase().split("-")[0];
  return LANGUAGE_LIBRARY.find((l) => l.code === c);
}

/* -------------------------------------------------------------- config */

export const LANGUAGE_STATUSES = ["draft", "in_review", "ready", "live"] as const;

/** One language version of the survey: which language, which regional variant, how it is written and formatted. */
export const LanguageConfig = z.object({
  /** ISO 639 language code — the key every translation and audio asset uses ("hi", "es", "zh") */
  code: z.string(),
  /** BCP-47 locale for voice, formatting and regional wording ("hi-IN", "es-MX", "zh-TW") */
  locale: z.string().optional(),
  /** ISO 3166 country the version is for, when one was chosen */
  country: z.string().optional(),
  /** shown to respondents in the language selector; defaults to the library's native name */
  name: z.string().optional(),
  direction: z.enum(TEXT_DIRECTIONS).optional(),
  status: z.enum(LANGUAGE_STATUSES).default("draft"),
  /** offered to respondents at all */
  enabled: z.boolean().default(true),
  /** formatting overrides; unset = what Intl does for the locale */
  format: z.object({
    decimal: z.string().optional(),
    thousands: z.string().optional(),
    currency: z.string().optional(),
    dateStyle: z.enum(["short", "medium", "long"]).optional(),
    /** a dd/MM/yyyy-style pattern when the study wants one fixed format */
    datePattern: z.string().optional(),
    timeFormat: z.enum(["12h", "24h"]).optional(),
  }).default({}),
  /** language-specific terminology notes for translators and the AI ("use the formal register") */
  notes: z.string().optional(),
});
export type LanguageConfig = z.infer<typeof LanguageConfig>;

export const TRANSLATION_STATUSES = ["not_translated", "ai", "edited", "reviewed", "approved"] as const;
export const TRANSLATION_ORIGINS = ["ai", "manual", "import", "glossary", "memory"] as const;

/** One translated string, with where it came from and how it changed. */
export const TranslationEntry = z.object({
  text: z.string(),
  status: z.enum(TRANSLATION_STATUSES).default("not_translated"),
  origin: z.enum(TRANSLATION_ORIGINS).optional(),
  /** a hash of the SOURCE text this translation was made from — differs from the current source when the original was edited afterwards */
  sourceHash: z.string().optional(),
  version: z.number().int().min(1).default(1),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
  reviewedBy: z.string().optional(),
  /** previous versions, newest first, bounded */
  history: z.array(z.object({ text: z.string(), status: z.string(), version: z.number(), updatedAt: z.string().optional(), updatedBy: z.string().optional() })).default([]),
});
export type TranslationEntry = z.infer<typeof TranslationEntry>;

export const AUDIO_KINDS = ["human", "ai", "url"] as const;

/** A recording (or generated audio, or a hosted file) for one element in one language. */
export const AudioAsset = z.object({
  id: z.string(),
  /** the element it speaks: `q:<id>:text`, `q:<id>:opt:<code>`, `flow:<id>:message`, … */
  elementKey: z.string(),
  language: z.string(),
  locale: z.string().optional(),
  kind: z.enum(AUDIO_KINDS),
  url: z.string(),
  fileName: z.string().optional(),
  /** "audio/mpeg", "audio/wav", "audio/webm" */
  mimeType: z.string().optional(),
  durationMs: z.number().optional(),
  bytes: z.number().optional(),
  version: z.number().int().min(1).default(1),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  createdBy: z.string().optional(),
  /** a hash of the TEXT this audio speaks — differs from the current translation when the words changed afterwards */
  textHash: z.string().optional(),
  /** AI audio is used only once a person approved it */
  approved: z.boolean().default(true),
  /** how AI audio was made — informational, and the label respondents' tooling shows */
  voice: z.object({ voiceId: z.string().optional(), gender: z.string().optional(), accent: z.string().optional(), speed: z.number().optional(), style: z.string().optional(), provider: z.string().optional() }).optional(),
});
export type AudioAsset = z.infer<typeof AudioAsset>;

export const AUDIO_SOURCES = ["human", "ai", "url", "none"] as const;

/** A preferred translation of a term — reused everywhere, and told to the AI. */
export const GlossaryEntry = z.object({
  id: z.string(),
  source: z.string(),
  /** language → preferred wording */
  targets: z.record(z.string()),
  /** "project" lives in this survey; "org" entries are copied in from the workspace glossary and marked */
  scope: z.enum(["project", "org"]).default("project"),
  caseSensitive: z.boolean().default(false),
  /** never translate — keep the source term (brand names) */
  doNotTranslate: z.boolean().default(false),
  notes: z.string().optional(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntry>;

export const LANGUAGE_ROUTING_MODES = ["respondent", "url", "browser", "country", "embedded", "invitation", "panel", "rules"] as const;

/** How a respondent gets their language, in order of precedence; the first that yields a live language wins. */
export const LocalizationRouting = z.object({
  order: z.array(z.enum(LANGUAGE_ROUTING_MODES)).default(["url", "embedded", "invitation", "rules", "browser", "respondent"]),
  /** the URL parameter (`?lang=hi`) */
  urlParam: z.string().default("lang"),
  /** the embedded-data field that carries a language, when a panel or invitation sets one */
  embeddedField: z.string().default("language"),
  /** country code → language, for country detection (embedded `country` field or the invitation's) */
  countryMap: z.record(z.string()).default({}),
  /** IF … THEN language — evaluated against the response (embedded data at start) */
  rules: z.array(z.object({ id: z.string().optional(), when: Condition, language: z.string(), label: z.string().optional() })).default([]),
  /** show the selector so the respondent can change language while answering */
  allowSwitch: z.boolean().default(true),
  /** when nothing decides: the source language */
  fallback: z.string().optional(),
});
export type LocalizationRouting = z.infer<typeof LocalizationRouting>;

export const Localization = z.object({
  /** the language the survey is written in — the one every translation is FROM */
  sourceLanguage: z.string().default("en"),
  sourceLocale: z.string().optional(),
  languages: z.array(LanguageConfig).default([]),
  /** language → element key → translation */
  translations: z.record(z.record(TranslationEntry)).default({}),
  audio: z.array(AudioAsset).default([]),
  /** which audio plays when several exist for the same element and language, in order */
  audioPriority: z.array(z.enum(AUDIO_SOURCES)).default(["human", "ai", "url"]),
  glossary: z.array(GlossaryEntry).default([]),
  routing: LocalizationRouting.default({}),
  /** the translation mode the team works in — informational, drives the editor's defaults */
  mode: z.enum(["ai", "manual", "hybrid"]).default("hybrid"),
});
export type Localization = z.infer<typeof Localization>;
