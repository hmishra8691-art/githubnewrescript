import type { Condition, Question, SurveyDefinition } from "@rescript/schema";
import { addQuestion } from "./questionOps.js";
import { listPages } from "./blocks.js";

/**
 * THE PASTE ENGINE (2026-11-17) — what a paste MEANT, not what the clipboard carried.
 *
 * Text copied from Word, Excel, a PDF, a web page or another survey platform arrives with things nobody typed for a
 * respondent: "1." and "a)" and "•" in front of every line, non-breaking and zero-width spaces, Word's private bullet
 * glyphs, lines broken where the PDF's column ended, cells wrapped in quotes, and notes to the programmer in square
 * brackets. Each field of the Studio used to deal with a little of this in its own way, or not at all.
 *
 * This module is the one place it is decided, for every field, by WHERE the text is going:
 *
 *   field        list markers   line breaks          programmer notes      everything else
 *   question     removed        PDF wraps rejoined   taken out, returned   invisible junk removed, spaces normalised
 *   option       removed        one option per line  taken out, returned   "
 *   title        removed        joined               left alone            "
 *   instruction  removed        kept                 taken out, returned   "
 *   open         kept           kept                 left alone            invisible junk only
 *   code         kept           kept                 left alone            invisible junk only; nothing else is touched
 *
 * THE RULE: remove formatting noise, never information. So:
 *   - a marker is only a marker when it is followed by a space and by text: "1. Apple" loses "1.", while "1.5 litres",
 *     "18-24", "1,000", "-5", "Option 1", "Q1" and "3 times a week" are untouched;
 *   - a single capital letter with a full stop ("A. Smith") is a marker only inside a list that runs a, b, c;
 *   - survey syntax is fenced off BEFORE anything is cleaned and put back afterwards, byte for byte: {{Q1}}, ${Q1},
 *     ${q://QID1/ChoiceTextEntryValue}, ${e://Field/Country}, [pipe: q1], [% Q1 %], %%name%%, <<Q1>>, [[Q1]], and a
 *     lone bracketed name like [BRAND] (a placeholder, not a note);
 *   - zero-width JOINERS between letters are kept — Hindi, Persian and emoji are written with them;
 *   - wording, order and punctuation are never changed, and two lines are never merged unless the first plainly
 *     stops mid-sentence.
 *
 * PROGRAMMER NOTES — "[PROGRAMMER: RANDOMIZE OPTIONS]", "[ASK ONLY IF Q1 = 1]", "(SINGLE RESPONSE)", "PN: …" — are
 * never left in what a respondent reads and never thrown away: each is returned as a `PasteInstruction`, read into
 * the setting it asks for when it can be read with confidence (`applyPasteInstructions`), and otherwise handed back
 * for the person to review.
 */
export type PasteField = "question" | "option" | "title" | "instruction" | "open" | "code";

export type PasteInstructionKind =
  | "randomize" | "no_randomize" | "anchor" | "exclusive" | "other_specify"
  | "single" | "multi" | "required" | "optional" | "condition" | "terminate" | "unknown";

export interface PasteInstruction {
  /** the note exactly as written, without its brackets */
  raw: string;
  kind: PasteInstructionKind;
  /** for a condition: the expression after ASK IF / SHOW IF */
  expression?: string;
  /** which pasted line it was written on (0-based), so an option-level note finds its option */
  line?: number;
}

export interface CleanResult {
  text: string;
  instructions: PasteInstruction[];
  /** what was taken out, in words — for the "cleaned" note; empty when nothing was */
  removed: string[];
  changed: boolean;
}

/* ------------------------------------------------------------ characters */

/** zero-width and formatting characters that are never content */
const INVISIBLE = /[\u200B\u2060\uFEFF\u00AD\uFFFC\u180E\u061C\u202A-\u202E\u2066-\u2069]/g;
/** C0 / C1 controls except tab and newline */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** every space that is not a plain space */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/** Symbol / Wingdings bullets Word leaves in the private-use area */
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
/** joiners are kept between letters (Devanagari, Arabic script, emoji sequences), dropped anywhere else */
const STRAY_JOINER = /(^|[\s\x00-\x7F])[\u200C\u200D]+|[\u200C\u200D]+(?=$|[\s\x00-\x7F])/g;

export function stripInvisible(text: string): string {
  return text
    .replace(/\r\n?/g, "\n").replace(/[\u2028\u2029\u0085]/g, "\n")
    .replace(INVISIBLE, "").replace(CONTROLS, "").replace(ODD_SPACES, " ")
    .replace(STRAY_JOINER, "$1");
}

/* ------------------------------------------------------------ survey syntax: fenced off, restored untouched */

const SYNTAX = [
  /\{\{[^{}\n]{1,200}\}\}/g,                 // {{Q1}}, {{Q1:label}}
  /\$\{[^{}\n]{1,300}\}/g,                   // ${Q1}, ${q://QID1/…}, ${e://Field/x}
  /\[%[^\]\n]{1,200}%\]/g,                   // [% Q1 %]
  /\[\[[^\]\n]{1,200}\]\]/g,                 // [[Q1]]
  /\[(?:pipe|loopvar|rel|res)\s*:[^\]\n]{1,200}\]/gi, // Decipher [pipe: q1], [loopvar: label]
  /%%[A-Za-z0-9_.:-]{1,80}%%/g,              // %%name%%
  /<<[^<>\n]{1,120}>>/g,                     // <<Q1>>
  /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,30});/gi, // HTML entities
];
/** a lone placeholder: [BRAND], [Q1], [PRODUCT_NAME] */
const PLACEHOLDER = /\[[A-Z][A-Z0-9_]{0,40}\]/g;
SYNTAX.push(PLACEHOLDER);
const ONE_WORD_NOTE = /^\[(?:RANDOMI[SZ]E|ROTATE|ANCHOR|FIX(?:ED)?|EXCLUSIVE|SPECIFY|MANDATORY|REQUIRED|OPTIONAL|TERMINATE|SINGLE|MULTI(?:PLE)?|HIDDEN)\]$/;
const FENCE = "\uE000";
function fence(text: string): { text: string; held: string[] } {
  const held: string[] = [];
  let out = text.replace(new RegExp(FENCE, "g"), "");
  for (const re of SYNTAX) out = out.replace(re, (m) => {
    /* one capital word in brackets is a placeholder — unless the word is itself an instruction: [RANDOMIZE], [ANCHOR] */
    if (re === PLACEHOLDER && ONE_WORD_NOTE.test(m)) return m;
    held.push(m); return `${FENCE}${held.length - 1}${FENCE}`;
  });
  return { text: out, held };
}
const unfence = (text: string, held: string[]): string => text.replace(new RegExp(`${FENCE}(\\d+)${FENCE}`, "g"), (_m, i: string) => held[Number(i)] ?? "");

/* ------------------------------------------------------------ list markers */

const BULLET = "[•◦▪▫■□●○◆◇◊➢➤➔➜►▶▸▹✓✔✗☐☑☒❖·‣⁃∙⦁⚫⚪\\uF000-\\uF8FF]";
const ROMAN = "(?:x{0,2}(?:ix|iv|v?i{1,3}|v|x))";
/** markers that are always markers when followed by a space and text */
const STRONG_MARKER = new RegExp(
  `^\\s*(?:` +
  `${BULLET}+` +                                   // • Apple
  `|[-–—*+]` +                                     // - Apple   * Apple
  `|\\(?\\d{1,3}[.)]` +                            // 1.  1)  (1)
  `|\\d{1,3}\\s*[:]` +                             // 1:
  `|\\([a-zA-Z]\\)|[a-zA-Z]\\)` +                  // (a)  a)
  `|\\(${ROMAN}\\)|${ROMAN}\\)` +                  // (iv)  iv)
  `|Q(?:uestion)?\\s?\\d{1,3}[a-z]?\\s*[.:)]` +    // Q1.  Q12a:  Question 3)
  `)[ \\t]+(?=\\S)`, "i");
/** "A." / "b." / "iv." — a marker only inside a list that runs in sequence */
const WEAK_MARKER = new RegExp(`^\\s*(?:[a-zA-Z]|${ROMAN})\\.[ \\t]+(?=\\S)`, "i");
const BULLET_ONLY = new RegExp(`^\\s*${BULLET}+\\s*`);

/** does a run of lines carry lettered markers in order (a. b. c. / A. B. C. / i. ii. iii.)? */
function weakSequence(lines: string[]): boolean {
  const marks = lines.map((l) => /^\s*([a-zA-Z]{1,4})\.[ \t]+\S/.exec(l)?.[1]?.toLowerCase()).filter((m): m is string => !!m);
  if (marks.length < 2 || marks.length < lines.filter((l) => l.trim()).length * 0.6) return false;
  const letters = marks.every((m) => m.length === 1) && marks.every((m, i) => i === 0 || m.charCodeAt(0) === marks[i - 1].charCodeAt(0) + 1);
  const romans = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
  const roman = marks.every((m, i) => m === romans[i]);
  return letters || roman;
}

export function stripListMarker(line: string, opts: { weak?: boolean } = {}): string {
  let out = line.replace(BULLET_ONLY, (m) => (m.trim() ? "" : m));
  const strong = STRONG_MARKER.exec(out);
  if (strong) out = out.slice(strong[0].length);
  else if (opts.weak) { const weak = WEAK_MARKER.exec(out); if (weak) out = out.slice(weak[0].length); }
  /* "1.  • Apple": a number in front of a bullet (Word's two-level lists) */
  return out.replace(BULLET_ONLY, "");
}

/* ------------------------------------------------------------ programmer notes */

const NOTE_LEAD = "PROGRAMMER|PROGRAMMING|PROG(?:\\.|\\s+NOTE)?|PN|SCRIPTER|SCRIPTING|DP|INTERVIEWER";
const NOTE_WORDS =
  "DO NOT|DON'T|RANDOMI[SZ]E|ROTATE|ANCHOR|FIX(?:ED)?|EXCLUSIVE|ASK|SHOW|HIDE|DISPLAY|SKIP|GO ?TO|TERMINATE|SCREEN ?OUT|INSERT|PIPE|" +
  "SINGLE|MULTI(?:PLE)?|SELECT|CODE|OPEN|NUMERIC|MANDATORY|REQUIRED|OPTIONAL|FORCE|ALLOW|SPECIFY|IF|FILTER|BASE|QUOTA|LOOP|MASK|CARRY|" +
  "READ|PROBE|RANGE|MIN|MAX|HIDDEN|AUTOPUNCH|PUNCH|KEEP|END|CLOSE|THANK";
/** [ … ] whose content starts with a programming word and is not a lone placeholder */
const BRACKET_NOTE = new RegExp(`\\[\\s*((?:(?:${NOTE_LEAD})\\b[\\s:.-]*)?(?:${NOTE_WORDS})\\b[^\\]\\n]{0,300}|(?:${NOTE_LEAD})\\b[\\s:.-]+[^\\]\\n]{1,300})\\]`, "gi");
/** ( … ) only when it is written in capitals: "(SINGLE RESPONSE)", "(SPECIFY)" — "(Please specify)" is wording */
const PAREN_NOTE = new RegExp(`\\(\\s*((?:${NOTE_WORDS})\\b[^()\\n]{0,160})\\)`, "g");
/** a whole line addressed to the programmer */
const LINE_NOTE = new RegExp(`^\\s*(?:${NOTE_LEAD})\\s*(?:NOTE|INSTRUCTION)?S?\\s*[:\\-–]\\s*(.+)$`, "i");

export function classifyInstruction(raw: string, line?: number): PasteInstruction {
  const t = raw.replace(new RegExp(`^(?:${NOTE_LEAD})\\b[\\s:.-]*`, "i"), "").replace(/\s+/g, " ").trim();
  const u = t.toUpperCase();
  const base = { raw: raw.trim(), ...(line != null ? { line } : {}) };
  const cond = /^(?:ASK|SHOW|DISPLAY)\b(?:\s+(?:THIS\s+)?(?:QUESTION\s+)?)?(?:ONLY\s+)?(?:IF|WHEN)\s+(.+)$/i.exec(t) ?? /^(?:FILTER|BASE)\s*[:\-]?\s*(?:IF\s+)?(.+)$/i.exec(t) ?? /^IF\s+(.+)$/i.exec(t);
  if (cond) return { ...base, kind: "condition", expression: cond[1].trim() };
  if (/^(DO NOT|DON'T|NO)\s+(RANDOMI[SZ]E|ROTATE)\b/.test(u) || /^KEEP\s+(IN\s+)?ORDER/.test(u)) return { ...base, kind: "no_randomize" };
  if (/^(RANDOMI[SZ]E|ROTATE)\b/.test(u)) return { ...base, kind: "randomize" };
  if (/^(ANCHOR|FIX(ED)?)\b/.test(u) || /^(DO NOT|DON'T)\s+MOVE/.test(u)) return { ...base, kind: "anchor" };
  if (/^(EXCLUSIVE|SINGLE\s+PUNCH\s+ONLY)\b/.test(u)) return { ...base, kind: "exclusive" };
  if (/^(SPECIFY|OPEN\s*(END|TEXT)?\s*SPECIFY|ALLOW\s+(TEXT|SPECIFY))\b/.test(u)) return { ...base, kind: "other_specify" };
  if (/^(SINGLE)\s*(RESPONSE|CODE|SELECT|CHOICE|ANSWER|PUNCH)?\b/.test(u) || /^(SELECT|CODE)\s+ONE\b/.test(u)) return { ...base, kind: "single" };
  if (/^MULTI(PLE)?\s*(RESPONSE|CODE|SELECT|CHOICE|ANSWER|PUNCH)?\b/.test(u) || /^(SELECT|CODE)\s+ALL\b/.test(u)) return { ...base, kind: "multi" };
  if (/^(MANDATORY|REQUIRED|FORCE(D)?\s+RESPONSE)\b/.test(u)) return { ...base, kind: "required" };
  if (/^(OPTIONAL|NOT\s+(MANDATORY|REQUIRED))\b/.test(u)) return { ...base, kind: "optional" };
  if (/^(TERMINATE|SCREEN\s?OUT)\b/.test(u)) return { ...base, kind: "terminate" };
  return { ...base, kind: "unknown" };
}

/** take the programmer notes out of one line; what is left is what the respondent reads */
export function extractInstructions(line: string, lineIndex?: number): { text: string; instructions: PasteInstruction[] } {
  const instructions: PasteInstruction[] = [];
  const whole = LINE_NOTE.exec(line);
  if (whole) return { text: "", instructions: [classifyInstruction(whole[1], lineIndex)] };
  let text = line.replace(BRACKET_NOTE, (_m, inner: string) => { instructions.push(classifyInstruction(inner, lineIndex)); return " "; });
  text = text.replace(PAREN_NOTE, (m, inner: string) => {
    /* capitals only: a parenthesis in sentence case is part of the wording */
    if (inner !== inner.toUpperCase() || !/[A-Z]{3}/.test(inner)) return m;
    instructions.push(classifyInstruction(inner, lineIndex));
    return " ";
  });
  return { text: instructions.length ? text.replace(/[ \t]{2,}/g, " ").replace(/\s+([?.!,;:])/g, "$1").trim() : text, instructions };
}

/* ------------------------------------------------------------ lines */

/** a spreadsheet cell copied with line breaks or quotes inside comes wrapped in quotes, its own quotes doubled */
function unwrapCell(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"') && (t.includes('""') || t.includes("\n")) && !/[^"]"[^"]/.test(t.slice(1, -1).replace(/""/g, ""))) return t.slice(1, -1).replace(/""/g, '"');
  return text;
}

const TERMINAL = /[.?!:;…)\]"”’»]$/;
/** rejoin lines a PDF broke where its column ended: the first stops mid-sentence and the next carries on in lower case */
export function rejoinWrappedLines(lines: string[], startsItem: boolean[] = []): string[] {
  const out: string[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const prev = out[out.length - 1];
    /* a line that had its own number or bullet is an item of a list, never the rest of a sentence */
    if (prev && line && !startsItem[i] && !TERMINAL.test(prev) && /^[a-z]/.test(line) && prev.length >= 25) {
      out[out.length - 1] = /[A-Za-z]-$/.test(prev) ? prev + line : `${prev} ${line}`;
    } else out.push(line);
  });
  return out;
}

/* spacing only — a space before "?" is how French is written, and is left alone */
const tidy = (s: string) => s.replace(/\t+/g, " ").replace(/ {2,}/g, " ").trim();

/**
 * Clean pasted PLAIN text for one destination field. Lines stay lines (an option list is split by the caller with
 * `cleanPastedLines`); only a `title` is forced onto one line.
 */
export function cleanPastedText(input: string, field: PasteField): CleanResult {
  const removed: string[] = [];
  const note = (w: string) => { if (!removed.includes(w)) removed.push(w); };
  if (!input) return { text: "", instructions: [], removed, changed: false };
  /*
   * ORDER MATTERS. Symbol-font characters first (the fence's marker lives in that range); then survey syntax is
   * fenced off; only then are invisible characters and spaces touched — so nothing inside a token is normalised.
   */
  const source = input.replace(/\r\n?/g, "\n");
  const symbols = source.replace(PRIVATE_USE, (c) => (new RegExp(BULLET).test(c) ? "•" : ""));
  if (symbols !== source) note("symbol-font characters");
  const first = fence(symbols);
  const visible = stripInvisible(first.text);
  if (visible !== first.text) note("invisible characters");
  if (field === "code" || field === "open") { const text = unfence(visible, first.held); return { text, instructions: [], removed, changed: text !== input }; }

  let text = unfence(visible, first.held);
  const unwrapped = unwrapCell(text);
  if (unwrapped !== text) { text = unwrapped; note("spreadsheet quotes"); }
  const { text: fenced, held } = fence(text);
  let lines = fenced.split("\n");
  const instructions: PasteInstruction[] = [];
  const takeNotes = field === "question" || field === "option" || field === "instruction";
  const weak = weakSequence(lines);
  /* Word's hollow bullet arrives as the letter "o" (Qualtrics' Word export lists every choice this way) — a bullet
     only when EVERY line of the paste starts with it */
  const filled = lines.filter((l) => l.trim());
  const oBullets = filled.length >= 2 && filled.every((l) => /^\s*o[ \t]+\S/.test(l));
  if (oBullets) lines = lines.map((l) => l.replace(/^\s*o[ \t]+/, "• "));
  const startsItem: boolean[] = [];
  lines = lines.map((line, i) => {
    let l = line;
    /* one cell of a pasted column, quoted by the spreadsheet because it holds a quote */
    if (l.includes('""')) { const u = unwrapCell(l); if (u !== l) { l = u; note("spreadsheet quotes"); } }
    if (takeNotes) { const x = extractInstructions(l, i); if (x.instructions.length) { instructions.push(...x.instructions); note("programmer notes"); l = x.text; } }
    const stripped = stripListMarker(l, { weak });
    startsItem[i] = stripped !== l;
    if (stripped !== l) note("numbering and bullets");
    const t = tidy(stripped);
    if (t !== stripped.trim()) note("extra spaces");
    return t;
  });
  if (field === "question" || field === "instruction") {
    const joined = rejoinWrappedLines(lines, startsItem);
    if (joined.length !== lines.filter((l) => l !== "").length && joined.filter(Boolean).length < lines.filter(Boolean).length) note("line breaks inside sentences");
    lines = joined;
  }
  /* blank runs collapse to one; none at the ends */
  const compact: string[] = [];
  for (const l of lines) { if (l === "" && (compact.length === 0 || compact[compact.length - 1] === "")) continue; compact.push(l); }
  while (compact.length && compact[compact.length - 1] === "") compact.pop();
  let out = unfence(compact.join(field === "title" ? " " : "\n"), held);
  if (field === "title") out = out.replace(/ {2,}/g, " ").trim();
  /* the notes' own text had syntax fenced too */
  for (const ins of instructions) { ins.raw = unfence(ins.raw, held); if (ins.expression) ins.expression = unfence(ins.expression, held); }
  return { text: out, instructions, removed, changed: out !== input };
}

/** an option list: one entry per non-empty line, each cleaned; a note written on an option's line stays tied to it */
export function cleanPastedLines(input: string, field: PasteField = "option"): { lines: string[]; instructions: PasteInstruction[]; removed: string[] } {
  const r = cleanPastedText(input, field);
  const lines: string[] = [];
  const map = new Map<number, number>();
  r.text.split("\n").forEach((l) => { if (l.trim()) lines.push(l); });
  /* re-tie each note to the option that was on its line */
  const source = stripInvisible(input).split("\n");
  let k = -1;
  source.forEach((raw, i) => { const kept = cleanPastedText(raw, field).text.trim(); if (kept) k++; map.set(i, kept ? k : -1); });
  const instructions = r.instructions.map((ins) => ({ ...ins, line: ins.line != null ? map.get(ins.line) ?? -1 : -1 }));
  return { lines, instructions, removed: r.removed };
}

/* ------------------------------------------------------------ HTML (Word, web pages) */

const WORD_LIST_IGNORE = /<!--\[if !supportLists\]-->[\s\S]*?<!--\[endif\]-->/gi;
const MSO_LIST_SPAN = /<span\b[^>]*mso-list\s*:\s*Ignore[^>]*>[\s\S]*?<\/span>(?:\s*<\/span>)?/gi;
const OFFICE_TAGS = /<\/?o:p\b[^>]*>/gi;
const BLOCK_START = /(<(?:p|li|div|h[1-6]|td|th|blockquote)\b[^>]*>(?:\s*<(?!\/)(?:span|b|strong|i|em|u|font|a)\b[^>]*>)*)([^<]*)/gi;

/* ---- the look of the source document is not content ---- */

const DROP_BLOCKS = /<(head|style|script|xml|title|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->|<!\[[^\]]*\]>|<!DOCTYPE[^>]*>/gi;
/** tags that carry meaning: kept, without the attributes that only carry appearance */
const KEEP_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "br", "p", "div", "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "img"]);
const VOID_TAGS = new Set(["br", "img", "hr", "meta", "link", "input", "col", "wbr"]);
const KEEP_ATTRS: Record<string, string[]> = { a: ["href"], img: ["src", "alt"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] };
const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/**
 * COLOURS, FONTS AND SIZES STAY BEHIND (2026-11-18). A paste from Word, Google Docs, Outlook or a web page arrives
 * as HTML that describes how the SOURCE looked: `<span style="color:#1F3864;font-family:Calibri;font-size:11pt">`,
 * `<font face=…>`, classes, ids, headings. Pasted as it came, the question carried that markup — another font and
 * colour in the survey, and a wall of tags in the HTML view. Only what carries MEANING is kept:
 *
 *   kept      bold, italic, underline, strike-through, sub / superscript, links (their address), line breaks,
 *             paragraphs, lists, tables, images (their source and alt text)
 *   converted emphasis written as a style (`font-weight:700`, `font-style:italic`, `text-decoration:underline`) becomes
 *             <b> / <i> / <u>; a heading becomes a bold paragraph; Google Docs' `<b style="font-weight:normal">`
 *             wrapper is NOT bold and is dropped
 *   dropped   every style, class, id, lang, dir and data attribute; <span>, <font> and Office's own tags (their text
 *             stays); <style>, <head>, comments and conditional blocks
 */
export function stripPresentation(html: string): string {
  if (!html || !html.includes("<")) return html;
  const src = html.replace(DROP_BLOCKS, "").replace(COMMENTS, "");
  let out = "";
  let last = 0;
  /* per open source tag: what was written for it, so its close writes the matching closers */
  const stack: { name: string; close: string }[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const closing = m[1] === "/", name = m[2].toLowerCase(), attrs = m[3] ?? "";
    if (closing) {
      const at = stack.map((x) => x.name).lastIndexOf(name);
      if (at < 0) continue;
      /* a close that skips open tags closes them too, innermost first */
      while (stack.length > at) out += stack.pop()!.close;
      continue;
    }
    const style = (attr(attrs, "style") ?? "").toLowerCase();
    const weight = /font-weight\s*:\s*([a-z0-9]+)/.exec(style)?.[1];
    const styledBold = weight ? weight === "bold" || weight === "bolder" || Number(weight) >= 600 : false;
    const notBold = weight ? weight === "normal" || Number(weight) <= 500 : false;
    const styledItalic = /font-style\s*:\s*(italic|oblique)/.test(style);
    const styledUnder = /text-decoration[a-z-]*\s*:[^;]*underline/.test(style);
    const styledStrike = /text-decoration[a-z-]*\s*:[^;]*line-through/.test(style);
    const isBoldTag = name === "b" || name === "strong";
    const heading = /^h[1-6]$/.test(name);
    let open = "", close = "";
    const wrap = (t: string) => { open += `<${t}>`; close = `</${t}>${close}`; };
    if (heading) { wrap("p"); wrap("b"); }
    else if (isBoldTag && notBold) { /* Google Docs' wrapper: a <b> that says it is not bold */ }
    else if (KEEP_TAGS.has(name)) {
      const kept = (KEEP_ATTRS[name] ?? []).map((k) => { const v = attr(attrs, k); return v == null ? "" : ` ${k}="${v.replace(/"/g, "&quot;")}"`; }).join("");
      if (VOID_TAGS.has(name)) { out += `<${name}${kept}>`; continue; }
      open += `<${name}${kept}>`; close = `</${name}>`;
    } else if (VOID_TAGS.has(name) || /\/\s*$/.test(attrs)) continue;
    /* emphasis that was written as a style, on a tag that does not already say it */
    if (styledBold && !isBoldTag && !heading) wrap("b");
    if (styledItalic && name !== "i" && name !== "em") wrap("i");
    if (styledUnder && name !== "u" && name !== "a") wrap("u");
    if (styledStrike && name !== "s" && name !== "strike") wrap("s");
    out += open;
    stack.push({ name, close });
  }
  out += src.slice(last);
  while (stack.length) out += stack.pop()!.close;
  /* wrappers left with nothing in them, and a document that was one paragraph */
  return out.replace(/<(b|i|u|s|p|div)>\s*<\/\1>/gi, "").replace(/(?:&nbsp;|\s)+$/g, "").trim();
}

/**
 * Clean pasted HTML before it is sanitised and inserted: Word's own list numbers (which are text in the clipboard,
 * not list items), the markers at the start of each paragraph, invisible characters and non-breaking spaces. Tags
 * and their formatting are left for the sanitiser; text inside survey syntax is not touched.
 */
export function cleanPastedHtml(html: string, field: PasteField): { html: string; instructions: PasteInstruction[]; removed: string[] } {
  const removed: string[] = [];
  const note = (w: string) => { if (!removed.includes(w)) removed.push(w); };
  if (!html) return { html: "", instructions: [], removed };
  let out = html;
  const noWord = out.replace(WORD_LIST_IGNORE, "").replace(MSO_LIST_SPAN, "").replace(OFFICE_TAGS, "");
  if (noWord !== out) { out = noWord; note("numbering and bullets"); }
  if (field === "code" || field === "open") return { html: out, instructions: [], removed };
  /* the source's colours, fonts and sizes are not content (stripPresentation) */
  let plainLook = stripPresentation(out);
  /* one paragraph pasted into a line of text joins that line: its <p> wrapper would start a new paragraph in the middle */
  const lone = /^<p>([\s\S]*)<\/p>$/.exec(plainLook);
  if (lone && !/<\/?(?:p|div|ul|ol|li|table|blockquote)\b/i.test(lone[1])) plainLook = lone[1];
  if (plainLook !== out) { out = plainLook; note("fonts, colours and styling"); }
  const instructions: PasteInstruction[] = [];
  const takeNotes = field === "question" || field === "option" || field === "instruction";
  /* text between tags: characters and notes; never inside a tag */
  let first = true;
  out = out.replace(/(^|>)([^<]+)(?=<|$)/g, (_m, lead: string, text: string) => {
    /* symbol-font bullets first: the fence's own marker lives in the same private range */
    const { text: fenced, held } = fence(text.replace(/&nbsp;/gi, " ").replace(PRIVATE_USE, "•"));
    let t = stripInvisible(fenced).replace(/\n+/g, " ");
    if (t !== fenced) note("invisible characters");
    if (takeNotes) { const x = extractInstructions(t); if (x.instructions.length) { for (const i of x.instructions) { i.raw = unfence(i.raw, held); if (i.expression) i.expression = unfence(i.expression, held); } instructions.push(...x.instructions); note("programmer notes"); t = x.text ? ` ${x.text} `.replace(/^ (?=\S)/, text.startsWith(" ") ? " " : "").replace(/ $/, text.endsWith(" ") ? " " : "") : ""; } }
    if (first && t.trim()) { first = false; const s = stripListMarker(t); if (s !== t) { note("numbering and bullets"); t = s; } }
    return `${lead}${unfence(t.replace(/ {2,}/g, " "), held)}`;
  });
  /* the marker at the start of every block: <p>1. …</p>, <li>• …</li> */
  out = out.replace(BLOCK_START, (m, open: string, text: string) => {
    if (!text.trim()) return m;
    const { text: fenced, held } = fence(text);
    const s = stripListMarker(fenced);
    if (s === fenced) return m;
    note("numbering and bullets");
    return `${open}${unfence(s, held)}`;
  });
  return { html: out, instructions, removed };
}

/* ------------------------------------------------------------ several questions at once */

export interface PastedQuestion { text: string; options: string[]; instructions: PasteInstruction[]; optionInstructions: { option: number; instruction: PasteInstruction }[] }

const QUESTION_MARK = /^\s*(?:\(?\d{1,3}[.)]|Q(?:uestion)?\s?\d{1,3}[a-z]?\s*[.:)])\s+\S/i;
/**
 * Is this paste a list of QUESTIONS (rather than one question's text, or one question's options)? Each numbered or
 * question-mark line starts a question; the lines under it, until the next, are its options.
 *
 * Deliberately narrow — a paste is only split when it can only be read one way:
 *   - a run of lines that all end in "?" (two or more), or
 *   - numbered "Q1." / "1." lines of which at least two end in "?" or have lettered / bulleted lines beneath them.
 * A numbered list of short labels with no "?" anywhere is an option list and is left to the option paste.
 */
export function parsePastedQuestions(input: string): PastedQuestion[] | null {
  const lines = stripInvisible(input).replace(PRIVATE_USE, "•").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const isQ = (l: string) => /\?\s*(?:[\[(][^\])]*[\])]\s*)*$/.test(l.trim());
  const marked = lines.map((l) => QUESTION_MARK.test(l));
  const asks = lines.map(isQ);
  const explicitQ = lines.map((l) => /^\s*Q(?:uestion)?\s?\d{1,3}[a-z]?\s*[.:)]\s+\S/i.test(l));
  const starts = lines.map((_, i) => explicitQ[i] || asks[i]);
  const nStarts = starts.filter(Boolean).length;
  if (nStarts < 2) return null;
  /* every line before the first question start would be orphaned: not a question list */
  if (!starts[0]) return null;
  void marked;
  const out: PastedQuestion[] = [];
  lines.forEach((raw, i) => {
    if (starts[i]) {
      const c = cleanPastedText(raw, "question");
      out.push({ text: c.text, options: [], instructions: c.instructions, optionInstructions: [] });
    } else {
      const cur = out[out.length - 1];
      const whole = extractInstructions(raw);
      if (!whole.text.trim() && whole.instructions.length) { cur.instructions.push(...whole.instructions); return; }
      const c = cleanPastedText(raw, "option");
      if (!c.text.trim()) { cur.instructions.push(...c.instructions); return; }
      cur.options.push(c.text);
      for (const ins of c.instructions) cur.optionInstructions.push({ option: cur.options.length - 1, instruction: ins });
    }
  });
  return out.every((q) => q.text.trim()) ? out : null;
}

/* ------------------------------------------------------------ turning notes into settings */

export interface AppliedInstructions {
  /** what was set, in words */
  applied: string[];
  /** notes that could not be read with confidence — kept in the question's Notes for review */
  review: PasteInstruction[];
}

/** "Q1 = 1", "Q1 = 1 OR 2", "Q1 IN (1,2)", "Q1 != 3", "Q1 = 1 AND Q2 = 2" → a condition, when every question is known */
export function conditionFromExpression(def: Pick<SurveyDefinition, "questions">, expression: string, selfId?: string): Condition | null {
  const byCode = new Map<string, Question>();
  for (const q of def.questions) { byCode.set(q.code.toUpperCase(), q); byCode.set(q.variableName.toUpperCase(), q); }
  const clause = (s: string): Condition | null => {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(=|==|!=|<>|≠|IN|NOT IN|IS NOT|IS)\s*\(?\s*([0-9]+(?:\s*(?:,|OR|\/|&)\s*[0-9]+)*)\s*\)?\s*$/i.exec(s);
    if (!m) return null;
    const q = byCode.get(m[1].toUpperCase());
    if (!q || q.id === selfId) return null;
    const codes = m[3].split(/\s*(?:,|OR|\/|&)\s*/i).map((c) => c.trim()).filter(Boolean);
    const known = new Set((q.options ?? []).map((o) => String(o.code)));
    if (!codes.length || !codes.every((c) => known.has(c))) return null;
    const not = /^(!=|<>|≠|NOT IN|IS NOT)$/i.test(m[2]);
    const typed = codes.map((c) => { const o = q.options.find((x) => String(x.code) === c); return o ? o.code : c; });
    const source = { kind: "question" as const, ref: q.id };
    if (typed.length === 1) return { type: "rule", source, operator: not ? "notSelected" : "selected", value: typed[0] } as Condition;
    return { type: "rule", source, operator: not ? "containsNone" : "containsAny", value: typed } as Condition;
  };
  const text = expression.replace(/[.;]\s*$/, "").trim();
  if (/\bOR\b/i.test(text.replace(/\(\s*[0-9\s,OR/&]+\)/gi, "").replace(/=\s*[0-9]+(?:\s+OR\s+[0-9]+)+/gi, "")) ) return null; // OR between questions: not guessed
  const parts = text.split(/\s+AND\s+/i);
  const rules = parts.map(clause);
  if (rules.some((r) => !r)) return null;
  return rules.length === 1 ? rules[0]! : ({ type: "group", op: "and", children: rules as Condition[] });
}

/**
 * Apply the notes found in a paste to the question they were pasted into (mutates `q`). Only what can be read with
 * confidence is applied; the rest comes back as `review` and is written to the question's Notes — an internal field —
 * so nothing is silently dropped and nothing reaches a respondent.
 */
export function applyPasteInstructions(def: Pick<SurveyDefinition, "questions">, q: Question, instructions: PasteInstruction[], optionOf: (ins: PasteInstruction) => number = (ins) => ins.line ?? -1): AppliedInstructions {
  const applied: string[] = [];
  const review: PasteInstruction[] = [];
  const hasOptions = Array.isArray(q.options) && q.options.length > 0;
  const flag = (i: number, f: "exclusive" | "other_specify" | "anchor_bottom"): boolean => {
    const o = q.options?.[i];
    if (!o) return false;
    const flags = new Set(o.flags ?? []);
    flags.add(f);
    o.flags = [...flags] as typeof o.flags;
    return true;
  };
  for (const ins of instructions) {
    const at = optionOf(ins);
    switch (ins.kind) {
      case "randomize":
        if (!hasOptions) { review.push(ins); break; }
        q.randomization = { ...(q.randomization ?? { scope: "options", method: "shuffle" }), enabled: true } as Question["randomization"];
        applied.push("Answer options are randomized"); break;
      case "no_randomize":
        if (q.randomization) q.randomization = { ...q.randomization, enabled: false };
        applied.push("Answer options are not randomized"); break;
      case "anchor": if (flag(at, "anchor_bottom")) applied.push(`“${plainLabel(q, at)}” stays in place when options are randomized`); else review.push(ins); break;
      case "exclusive": if (q.type === "multi_select" && flag(at, "exclusive")) applied.push(`“${plainLabel(q, at)}” is exclusive`); else review.push(ins); break;
      case "other_specify": if (flag(at, "other_specify")) applied.push(`“${plainLabel(q, at)}” asks the respondent to specify`); else review.push(ins); break;
      case "required": q.required = true; applied.push("The question is required"); break;
      case "optional": q.required = false; applied.push("The question is optional"); break;
      case "condition": {
        const c = ins.expression ? conditionFromExpression(def, ins.expression, q.id) : null;
        if (c) { q.displayLogic = c; applied.push(`Shown only when ${ins.expression}`); } else review.push(ins);
        break;
      }
      default: review.push(ins);
    }
  }
  if (review.length) {
    const lines = review.map((r) => `[from paste — review] ${r.raw}`);
    const have = q.notes ?? "";
    const fresh = lines.filter((l) => !have.includes(l));
    if (fresh.length) q.notes = [have.trim(), ...fresh].filter(Boolean).join("\n");
  }
  return { applied, review };
}
const plainLabel = (q: Question, i: number) => String(q.options?.[i]?.label ?? "").replace(/<[^>]*>/g, "").trim();

/* ------------------------------------------------------------ several questions pasted into one */

const esc = (t: string) => t.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CHOICE_TYPES = new Set(["single_select", "multi_select", "dropdown", "multi_dropdown", "ranking", "image_select"]);

export interface PastedQuestionsResult {
  /** ids of the questions the paste filled or created, in order (the first is the one pasted into) */
  questionIds: string[];
  applied: string[];
  review: PasteInstruction[];
}

/**
 * A paste of several questions into ONE question's text: the first fills the question pasted into, the others are
 * added straight after it, in order, each with its own options and its own notes applied. `create` makes the new
 * question (the caller owns naming and ids): "single" / "multi" when options came with it, "open" when none did.
 * Mutates `def`; one call is one undo step for the caller.
 */
export function insertPastedQuestions(def: SurveyDefinition, targetId: string, blocks: PastedQuestion[], create: (kind: "single" | "multi" | "open", def: SurveyDefinition) => Question): PastedQuestionsResult {
  const out: PastedQuestionsResult = { questionIds: [], applied: [], review: [] };
  const target = def.questions.find((q) => q.id === targetId);
  if (!target || !blocks.length) return out;
  const page = listPages(def.flow as unknown[]).find((p) => (p.node as { questionIds: string[] }).questionIds.includes(targetId));
  const pageId = page ? (page.node as { id: string }).id : undefined;
  let at = page ? (page.node as { questionIds: string[] }).questionIds.indexOf(targetId) : -1;
  blocks.forEach((b, i) => {
    let q: Question;
    if (i === 0) q = target;
    else {
      const kind = !b.options.length ? "open" : b.instructions.some((x) => x.kind === "multi") ? "multi" : "single";
      q = create(kind, def);
      addQuestion(def, q, pageId ? { pageId, index: ++at } : {});
      q = def.questions.find((x) => x.id === q.id) ?? q;
    }
    q.text = esc(b.text);
    const notes = [...b.instructions];
    if (b.options.length) {
      if (CHOICE_TYPES.has(q.type)) {
        q.options = b.options.map((label, k) => ({ code: k + 1, label: esc(label), flags: [] })) as Question["options"];
        notes.push(...b.optionInstructions.map((x) => ({ ...x.instruction, line: x.option })));
      } else {
        out.review.push({ raw: `${b.options.length} answer options were pasted with “${b.text.slice(0, 60)}”, but this question type has no option list: ${b.options.join(" | ")}`, kind: "unknown" });
        q.notes = [q.notes?.trim(), `[from paste — review] options not added: ${b.options.join(" | ")}`].filter(Boolean).join("\n");
      }
    }
    const r = applyPasteInstructions(def, q, notes.filter((x) => x.kind !== "single" && x.kind !== "multi" || i === 0));
    /* on the question pasted INTO, "single / multi response" is a note about a type the person already chose */
    for (const a of r.applied) out.applied.push(`${q.code}: ${a}`);
    out.review.push(...r.review);
    out.questionIds.push(q.id);
  });
  return out;
}
