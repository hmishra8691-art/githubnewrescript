import { PIPE_TOKEN_RE, parsePipeBody, type PipeToken } from "./pipingTokens.js";

/**
 * ONE PLACEHOLDER GRAMMAR — what a translation must carry over untouched.
 *
 * There were three, and none of them was the piping grammar: the lint's
 * `PIPE_RE` (localization.ts) knew `{{…}}`, `{answer}` and seven named UI
 * parameters; the write-time check (localizationActions.ts) had its own copy
 * of the same list; the provider path (packages/ai) protected `{{…}}`,
 * `${…}`, `[[…]]` and ANY `{word}`. So `{label}` — the hole in "“{label}”
 * cannot be selected together with other answers." — was protected on its way
 * to Google and then not checked on the way back into the survey: a
 * translation that dropped it was stored, and the runtime showed German
 * respondents a sentence with no option in it.
 *
 * This is the one list, used by the lint, the write-time refusal and the
 * provider path alike:
 *
 *   pipe        `{{Q1.label|and}}` — the same token the runtime pipes
 *               (`PIPE_TOKEN_RE`, parsed with `parsePipeBody` when it parses)
 *   variable    `${first_name}`
 *   loop        `[[loop.item]]`
 *   parameter   `{label}`, `{n}`, `{min}` … any `{word}` a UI string fills
 *   code        `Q7`, `S2`, `Q7.R1`, `Q7.R1.C1` — a question code or an
 *               option / row / column reference written into the text. It is
 *               a name, not a word: "see Q7" must still say Q7 in German.
 *               Codes are judged ONE WAY — every code in the source must be in
 *               the translation; a translation may not lose one, but nothing
 *               is refused for a code the source never had.
 *
 * Tokens never overlap: `{{Q1}}` is one pipe, not a pipe and a code.
 */

export type PlaceholderKind = "pipe" | "variable" | "loop" | "parameter" | "code";

export interface Placeholder {
  kind: PlaceholderKind;
  /** the token as written in the text */
  text: string;
  /** the token compared: whitespace inside it removed (`{{ Q1 }}` is `{{Q1}}`) */
  key: string;
  start: number;
  end: number;
  /** a pipe's structured reading, when it parses */
  pipe?: PipeToken;
}

/*
 * One pass, leftmost-longest by alternation order: a pipe before a parameter
 * (`{{n}}` is a pipe, not `{n}` inside braces), a parameter before nothing
 * else. The code alternative is guarded on both sides so it never starts or
 * ends inside a word ("COVID19", "B2B", "iPhone15" are not codes) and a full
 * stop after a code is the sentence's, not part of a reference.
 */
const PIPE_SRC = PIPE_TOKEN_RE.source;
const TOKEN_SRC = `(${PIPE_SRC})|(\\$\\{[^}]+\\})|(\\[\\[[^\\]]+\\]\\])|(\\{\\w+\\})`;
// a sub-question letter may follow the digits ("Q5a") — but not "s", which is a plural ("MP3s"), not a code
const CODE_SRC = `(?<![\\p{L}\\p{N}_.])([A-Z][A-Z0-9]{0,3}?\\d+[a-rt-z]?(?:\\.[A-Z]{1,3}\\d+[a-rt-z]?){0,3})(?![\\p{L}\\p{N}_])`;
const WITH_CODES = new RegExp(`${TOKEN_SRC}|${CODE_SRC}`, "gu");
const WITHOUT_CODES = new RegExp(TOKEN_SRC, "gu");
const KINDS: PlaceholderKind[] = ["pipe", "pipe", "variable", "loop", "parameter", "code"];

/**
 * The protected tokens of a text, in order. `codes: false` leaves question
 * codes out — for a TRANSLATION being checked, where a code is only required
 * when the source had it (see `placeholderMismatch`).
 */
export function placeholdersIn(text: string, opts: { codes?: boolean } = {}): Placeholder[] {
  if (!text) return [];
  const re = new RegExp(opts.codes === false ? WITHOUT_CODES : WITH_CODES);
  const out: Placeholder[] = [];
  for (const m of text.matchAll(re)) {
    // group 1 is the whole pipe, group 2 the pipe's body (PIPE_TOKEN_RE's own capture)
    const g = m.findIndex((v, i) => i > 0 && i !== 2 && v !== undefined);
    const kind = KINDS[g - 1] ?? "parameter";
    const tok = m[0];
    const pipe = kind === "pipe" ? parsePipeBody(m[2] ?? tok.slice(2, -2).trim(), tok) ?? undefined : undefined;
    out.push({ kind, text: tok, key: tok.replace(/\s+/g, ""), start: m.index ?? 0, end: (m.index ?? 0) + tok.length, ...(pipe ? { pipe } : {}) });
  }
  return out;
}

/** The comparable keys of a text's tokens, sorted — the multiset two texts must share. */
export function placeholderKeys(text: string, opts: { codes?: boolean } = {}): string[] {
  return placeholdersIn(text, opts).map((p) => p.key).sort();
}

/**
 * What a translation lost or invented against its source: the pipes,
 * variables, loop references and parameters must be the SAME multiset; every
 * code the source names must still be there. Null when nothing differs.
 */
export function placeholderMismatch(source: string, translation: string): { missing: string[]; extra: string[]; source: string[]; translation: string[] } | null {
  const src = placeholdersIn(source);
  const tr = placeholdersIn(translation);
  const take = (xs: Placeholder[], kinds: (k: PlaceholderKind) => boolean) => xs.filter((p) => kinds(p.kind)).map((p) => p.key);
  const a = take(src, (k) => k !== "code"), b = take(tr, (k) => k !== "code");
  const missing: string[] = [], extra: string[] = [];
  const bag = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ba = bag(a), bb = bag(b);
  for (const [k, n] of ba) for (let i = (bb.get(k) ?? 0); i < n; i++) missing.push(k);
  for (const [k, n] of bb) for (let i = (ba.get(k) ?? 0); i < n; i++) extra.push(k);
  // codes one way: the source's codes must survive; the translation may name more
  const ca = bag(take(src, (k) => k === "code")), cb = bag(take(tr, (k) => k === "code"));
  for (const [k, n] of ca) for (let i = (cb.get(k) ?? 0); i < n; i++) missing.push(k);
  if (!missing.length && !extra.length) return null;
  const shown = (xs: Placeholder[]) => xs.filter((p) => p.kind !== "code" || src.some((s) => s.kind === "code" && s.key === p.key)).map((p) => p.key).sort();
  return { missing, extra, source: src.map((p) => p.key).sort(), translation: shown(tr) };
}

/* ------------------------------------------------------------ scripts */

/**
 * THE WRITING SYSTEM OF A TEXT — for "is this German translation actually in
 * German letters?". A model asked for Russian sometimes answers in English,
 * or in transliterated Latin; asked for Japanese, in romaji. Nothing checked:
 * `set_translations` stored it and the Russian respondents read English.
 *
 * Judged on LETTERS only (digits, punctuation and spaces say nothing about a
 * language), and only on letters a translator should have translated: not
 * inside protected tokens, not in do-not-translate glossary terms, not in a
 * capitalised word copied verbatim from the source (a brand or product
 * name — "Miures", "iPhone"). A translation is in the wrong script when at
 * least WRONG_SCRIPT_SHARE of at least WRONG_SCRIPT_MIN_LETTERS such letters
 * are in a script the language does not use.
 */
export type Script =
  | "Latin" | "Cyrillic" | "Greek" | "Arabic" | "Hebrew" | "Devanagari" | "Bengali" | "Gurmukhi" | "Gujarati" | "Tamil" | "Telugu"
  | "Kannada" | "Malayalam" | "Sinhala" | "Thai" | "Lao" | "Khmer" | "Myanmar" | "Hangul" | "Kana" | "Han" | "Georgian" | "Armenian" | "Ethiopic";

const SCRIPT_TESTS: [Script, RegExp][] = [
  ["Latin", /\p{Script=Latin}/u], ["Cyrillic", /\p{Script=Cyrillic}/u], ["Greek", /\p{Script=Greek}/u], ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u], ["Devanagari", /\p{Script=Devanagari}/u], ["Bengali", /\p{Script=Bengali}/u], ["Gurmukhi", /\p{Script=Gurmukhi}/u],
  ["Gujarati", /\p{Script=Gujarati}/u], ["Tamil", /\p{Script=Tamil}/u], ["Telugu", /\p{Script=Telugu}/u], ["Kannada", /\p{Script=Kannada}/u],
  ["Malayalam", /\p{Script=Malayalam}/u], ["Sinhala", /\p{Script=Sinhala}/u], ["Thai", /\p{Script=Thai}/u], ["Lao", /\p{Script=Lao}/u],
  ["Khmer", /\p{Script=Khmer}/u], ["Myanmar", /\p{Script=Myanmar}/u], ["Hangul", /\p{Script=Hangul}/u],
  ["Kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ["Han", /\p{Script=Han}/u],
  ["Georgian", /\p{Script=Georgian}/u], ["Armenian", /\p{Script=Armenian}/u], ["Ethiopic", /\p{Script=Ethiopic}/u],
];

/** the script of one letter; null for a non-letter or a script not listed */
export function scriptOfLetter(ch: string): Script | null {
  if (!/\p{L}/u.test(ch)) return null;
  for (const [s, re] of SCRIPT_TESTS) if (re.test(ch)) return s;
  return null;
}

/** how many letters of each script a text has */
export function scriptCounts(text: string): { letters: number; counts: Partial<Record<Script, number>> } {
  const counts: Partial<Record<Script, number>> = {};
  let letters = 0;
  for (const ch of text ?? "") {
    // a letter of no listed script (the kana length mark ー is "Common") says nothing either way
    const s = scriptOfLetter(ch);
    if (!s) continue;
    letters++;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return { letters, counts };
}

/** The script most of a text's letters are written in; null when it has none. */
export function scriptOf(text: string): Script | null {
  const { counts } = scriptCounts(text);
  let best: Script | null = null, n = 0;
  for (const [s, c] of Object.entries(counts) as [Script, number][]) if (c > n) { best = s; n = c; }
  return best;
}

/*
 * The scripts a language is written in. A language not listed is assumed to
 * be written in Latin letters — every language of the library without its
 * own script is — and a code nobody knows returns null: no check.
 * Japanese is kana AND kanji; Korean is Hangul with the occasional hanja;
 * Serbian, Uzbek, Azerbaijani, Kazakh and Mongolian are written in more than
 * one script and accept either.
 */
const SCRIPTS_OF: Record<string, Script[]> = {
  ru: ["Cyrillic"], uk: ["Cyrillic"], be: ["Cyrillic"], bg: ["Cyrillic"], mk: ["Cyrillic"], ky: ["Cyrillic"], tg: ["Cyrillic"],
  sr: ["Cyrillic", "Latin"], kk: ["Cyrillic", "Latin"], mn: ["Cyrillic"], uz: ["Latin", "Cyrillic"], az: ["Latin", "Cyrillic"],
  el: ["Greek"], ar: ["Arabic"], fa: ["Arabic"], ur: ["Arabic"], ps: ["Arabic"], ku: ["Latin", "Arabic"], he: ["Hebrew"], iw: ["Hebrew"], yi: ["Hebrew"],
  hi: ["Devanagari"], mr: ["Devanagari"], ne: ["Devanagari"], sa: ["Devanagari"], bn: ["Bengali"], as: ["Bengali"], pa: ["Gurmukhi"], gu: ["Gujarati"],
  ta: ["Tamil"], te: ["Telugu"], kn: ["Kannada"], ml: ["Malayalam"], si: ["Sinhala"], th: ["Thai"], lo: ["Lao"], km: ["Khmer"], my: ["Myanmar"],
  ko: ["Hangul", "Han"], ja: ["Kana", "Han"], zh: ["Han"], ka: ["Georgian"], hy: ["Armenian"], am: ["Ethiopic"], ti: ["Ethiopic"],
};
const LATIN_LANGS = new Set([
  "en", "de", "fr", "es", "it", "pt", "nl", "sv", "da", "no", "nb", "nn", "fi", "is", "pl", "cs", "sk", "sl", "hr", "bs", "ro", "hu", "et", "lv", "lt",
  "tr", "id", "ms", "vi", "tl", "fil", "sw", "ca", "eu", "gl", "ga", "cy", "mt", "sq", "af", "zu", "xh", "yo", "ig", "ha", "so", "mi", "sm", "haw", "eo", "la", "lb", "fo", "ht", "jv", "su", "ceb", "hmn", "ny", "st", "sn", "rw", "mg", "qu", "gn", "ay",
]);

/** The scripts `lang` is written in (its base code decides: "pt-BR" is "pt"); null when the language is unknown. */
export function expectedScripts(lang: string): Script[] | null {
  const base = String(lang ?? "").toLowerCase().split(/[-_]/)[0];
  if (SCRIPTS_OF[base]) return SCRIPTS_OF[base];
  if (LATIN_LANGS.has(base)) return ["Latin"];
  return null;
}

export const WRONG_SCRIPT_SHARE = 0.6;
export const WRONG_SCRIPT_MIN_LETTERS = 4;

/**
 * Is `translation` written in a script `lang` does not use? Returns the
 * judgement with its numbers, or null when it is fine (or cannot be judged:
 * an unknown language, too few letters to say).
 */
export function wrongScript(source: string, translation: string, lang: string, opts: { keep?: string[] } = {}): { script: Script; expected: Script[]; share: number; letters: number } | null {
  const expected = expectedScripts(lang);
  if (!expected) return null;
  // what a translator should have translated: the text without its tokens, kept terms and copied names
  let t = String(translation ?? "").replace(/<[^>]*>/g, " ").replace(/&[A-Za-z#0-9]+;/g, " ");
  for (const p of placeholdersIn(t).sort((a, b) => b.start - a.start)) t = `${t.slice(0, p.start)} ${t.slice(p.end)}`;
  for (const k of opts.keep ?? []) if (k.trim()) t = t.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  const names = new Set((String(source ?? "").replace(/<[^>]*>/g, " ").match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).filter((w) => /^\p{Lu}/u.test(w) || /\p{Lu}/u.test(w.slice(1))));
  t = t.replace(/\p{L}[\p{L}\p{N}'’-]*/gu, (w) => (names.has(w) ? " " : w));
  const { letters, counts } = scriptCounts(t);
  if (letters < WRONG_SCRIPT_MIN_LETTERS) return null;
  const inPlace = expected.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const out = letters - inPlace;
  const share = out / letters;
  if (share < WRONG_SCRIPT_SHARE) return null;
  const script = (Object.entries(counts) as [Script, number][]).filter(([s]) => !expected.includes(s)).sort((a, b) => b[1] - a[1])[0]?.[0];
  return script ? { script, expected, share, letters } : null;
}
