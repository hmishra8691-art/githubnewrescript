import type { Option } from "@rescript/schema";
import { nextCode } from "./renumber.js";
import { stripHtmlText } from "./html.js";
import { cleanPastedText, type PasteInstruction } from "./pasteClean.js";

/**
 * Pasting an option list into a question that already has options.
 *
 * The rule that matters: an option's CODE is its identity. Logic, piping,
 * masks, punch rules and stored answers all refer to options by code, so a
 * paste must never turn "the option coded 3" into a different option by
 * accident. Hence two explicit modes and a merge that keeps identity:
 *
 *   replace  (default)  the pasted list IS the new list, in pasted order. A
 *                       pasted line that names an existing option — by code
 *                       (`code<TAB>label`) or, failing that, by identical
 *                       label — KEEPS that option: same code, same flags,
 *                       image, logic and metadata, only the label follows the
 *                       paste. Lines that match nothing become new options
 *                       with fresh codes. Existing options the paste does not
 *                       mention are removed, and the caller is told how many.
 *   append              the existing list stays exactly as it is; every
 *                       pasted line is added after it. A pasted code that
 *                       collides with an existing one gets a fresh code — a
 *                       duplicate code is never written.
 *
 * `parsePastedOptions` is the line parser both modes share; `optionsToPaste`
 * prints a list back in the same `code<TAB>label` form so the paste box can
 * open pre-filled with what is there now.
 */

export type PasteMode = "replace" | "append";

export interface PastePlan {
  options: Option[];
  /** existing options kept (identity preserved) */
  kept: number;
  /** brand-new options */
  added: number;
  /** existing options dropped (replace mode only) */
  removed: number;
  /** codes of the removed options — logic that names them is now dangling */
  removedCodes: (string | number)[];
}

/**
 * Parse a pasted option list. Every line goes through the paste engine (pasteClean.ts): numbering, bullets,
 * invisible characters and spreadsheet quotes are removed, survey syntax is kept, and a programmer note written on
 * an option's line is taken out of its label — "(SPECIFY)" and "[ANCHOR]" set that option's flag here; the rest
 * (`pastedOptionNotes`) are for the question. `code<TAB>label` lines keep their code.
 */
export function parsePastedOptions(text: string, startCode: number): Option[] {
  let n = startCode;
  const out: Option[] = [];
  for (const raw of text.replace(/\r\n?|[\u2028\u2029]/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const tab = line.split("\t");
    const coded = tab.length >= 2 && tab[0].trim() && !/^\s*(?:[\u2022\u25E6\u25AA\u00B7\uF000-\uF8FF]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s*$/.test(tab[0]);
    const body = coded ? tab.slice(1).join(" ") : line;
    const c = cleanPastedText(body, "option");
    const label = c.text.replace(/\n+/g, " ").trim();
    /* a line that was only a note ("[RANDOMIZE]") is not an option */
    if (!label && c.instructions.length) continue;
    const flags: string[] = [];
    for (const ins of c.instructions) { if (ins.kind === "other_specify") flags.push("other_specify"); if (ins.kind === "anchor") flags.push("anchor_bottom"); }
    out.push({ code: coded ? tab[0].trim() : String(n++), label: label || line.trim(), flags } as unknown as Option);
  }
  return out;
}

/** the notes of a pasted option list that are about the QUESTION or need its type: randomize, exclusive, a condition … (`line` = the option's place in the parsed list) */
export function pastedOptionNotes(text: string): PasteInstruction[] {
  const notes: PasteInstruction[] = [];
  let k = -1;
  for (const raw of text.replace(/\r\n?|[\u2028\u2029]/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const tab = raw.split("\t");
    const coded = tab.length >= 2 && tab[0].trim() && !/^\s*(?:[\u2022\u25E6\u25AA\u00B7\uF000-\uF8FF]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s*$/.test(tab[0]);
    const c = cleanPastedText(coded ? tab.slice(1).join(" ") : raw, "option");
    const isOption = !!c.text.trim() || !c.instructions.length;
    if (isOption) k++;
    for (const ins of c.instructions) if (ins.kind !== "other_specify" && ins.kind !== "anchor") notes.push({ ...ins, line: isOption ? k : -1 });
  }
  return notes;
}

/** Did this pasted line carry its own code (`code<TAB>label`)? */
function explicitCodes(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const tab = raw.split("\t");
    /* "1.<TAB>Apple" is Word's numbering followed by a tab, not a code the person chose */
    if (tab.length >= 2 && tab[0].trim() && !/^\s*(?:[\u2022\u25E6\u25AA\u00B7\uF000-\uF8FF]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s*$/.test(tab[0])) out.add(tab[0].trim());
  }
  return out;
}

const norm = (s: string) => stripHtmlText(s).replace(/\s+/g, " ").trim().toLowerCase();

/*
 * A PLACEHOLDER OPTION (Error.xlsx item 1, 2026-11-17): an option nobody has written yet — an empty label, or the
 * "Option n" a new question starts with, still coded n, with no flags, image or logic. It has no identity to
 * protect: no answer, condition or quota can name it yet. Treating it as a real option is what made a paste into a
 * new question number 2, 3, 4… — the starter's code 1 counted as taken while its row was being overwritten.
 */
export function isPlaceholderOption(o: Option): boolean {
  const label = stripHtmlText(String(o.label ?? "")).trim();
  const flags = ((o as { flags?: unknown[] }).flags ?? []).length;
  const extra = o as unknown as Record<string, unknown>;
  if (flags || extra.image || extra.imageUrl || extra.visibleIf || extra.mask || extra.labelExpression || extra.logic) return false;
  return label === "" || new RegExp(`^option\\s*${String(o.code).replace(/[^\w]/g, "")}$`, "i").test(label);
}

/** every option is still a placeholder: the question's list has not been written yet */
const allPlaceholders = (options: readonly Option[]) => options.length > 0 && options.every(isPlaceholderOption);

/**
 * A multi-line paste into ONE option's label field (the Studio's inline paste). The first pasted line goes into
 * that row, the rest are inserted after it.
 *
 *  - a list that is still all placeholders is replaced by the paste, numbered from 1 (or by the codes the paste
 *    spells, `code<TAB>label`);
 *  - otherwise the row keeps its own code when it was a placeholder (it is the slot being filled), every new row
 *    gets a code no other option has, and existing options never change code.
 *
 * Returns null when the text holds no option. Ids are the caller's to mint (`id` is absent on new options).
 */
export function pasteIntoOption(options: readonly Option[], index: number, text: string): { options: Option[]; focus: number } | null {
  const explicit = explicitCodes(text);
  if (allPlaceholders(options)) {
    const parsed = parsePastedOptions(text, 1);
    if (!parsed.length) return null;
    const used = new Set(parsed.filter((p) => explicit.has(String(p.code))).map((p) => String(p.code)));
    let n = 1;
    const fresh = () => { while (used.has(String(n))) n++; const c = String(n++); used.add(c); return c; };
    const out = parsed.map((p, k) => {
      const code = explicit.has(String(p.code)) ? String(p.code) : fresh();
      /* the first row keeps the placeholder's id, so focus and selection stay on it */
      return (k === 0 && options[0] ? { ...options[0], ...p, code } : { ...p, code }) as Option;
    });
    return { options: out, focus: out.length - 1 };
  }
  const parsed = parsePastedOptions(text, 1);
  if (!parsed.length) return null;
  const row = options[index];
  if (!row) return null;
  const used = new Set(options.map((o) => String(o.code)));
  const ownCode = String(row.code);
  const firstExplicit = explicit.has(String(parsed[0].code)) && (String(parsed[0].code) === ownCode || !used.has(String(parsed[0].code)));
  const firstCode = firstExplicit ? String(parsed[0].code) : ownCode;
  if (firstCode !== ownCode) { used.delete(ownCode); used.add(firstCode); }
  let n = Number(nextCode([...options])) || 1;
  const fresh = () => { while (used.has(String(n))) n++; const c = String(n++); used.add(c); return c; };
  const rest = parsed.slice(1).map((p) => {
    const c = String(p.code);
    const code = explicit.has(c) && !used.has(c) ? (used.add(c), c) : fresh();
    return { ...p, code } as Option;
  });
  const next = [...options];
  next[index] = { ...row, label: parsed[0].label, code: isPlaceholderOption(row) ? firstCode : row.code, flags: [...new Set([...(((row as { flags?: string[] }).flags) ?? []), ...(((parsed[0] as { flags?: string[] }).flags) ?? [])])] } as Option;
  next.splice(index + 1, 0, ...rest);
  return { options: next, focus: index + parsed.length - 1 };
}

export function planPaste(existingIn: Option[], text: string, mode: PasteMode): PastePlan {
  /* appending to a list that is still only placeholders starts the real list: the placeholders go, numbering from 1 */
  const fresh0 = mode === "append" && allPlaceholders(existingIn);
  const existing = fresh0 ? [] : existingIn;
  const highWater = Number(nextCode(existing)) || 1;
  const parsed = parsePastedOptions(text, highWater);
  if (parsed.length === 0) return { options: existing, kept: existing.length, added: 0, removed: 0, removedCodes: [] };

  const byCode = new Map(existing.map((o) => [String(o.code), o]));
  const byLabel = new Map<string, Option>();
  for (const o of existing) if (!byLabel.has(norm(o.label))) byLabel.set(norm(o.label), o);
  const explicit = explicitCodes(text);

  if (mode === "append") {
    const used = new Set(existing.map((o) => String(o.code)));
    const out = [...existing];
    let n = highWater;
    const fresh = () => { while (used.has(String(n))) n++; const c = String(n++); used.add(c); return c; };
    for (const p of parsed) {
      const code = used.has(String(p.code)) ? fresh() : String(p.code);
      used.add(code);
      out.push({ ...p, code });
    }
    return { options: out, kept: existing.length, added: parsed.length, removed: fresh0 ? existingIn.length : 0, removedCodes: fresh0 ? existingIn.map((o) => o.code) : [] };
  }

  /*
   * Replace runs in two passes. The FIRST decides which existing options the
   * paste keeps (by explicit code, else by identical label) without assigning
   * anything; the SECOND numbers what is left.
   *
   * Two passes rather than one because a fresh code must skip the codes of
   * KEPT options and only those. The single-pass version skipped every code
   * in the old list, including the ones the paste was removing — which is the
   * other half of "numbering is starting from 2 instead of 1": with a starter
   * option coded 1 being replaced, 1 was still treated as taken.
   */
  const matches: (Option | undefined)[] = [];
  const keptIds = new Set<Option>();
  for (const p of parsed) {
    const codeStr = String(p.code);
    let match: Option | undefined;
    if (explicit.has(codeStr) && byCode.has(codeStr)) match = byCode.get(codeStr);
    if (!match) match = byLabel.get(norm(p.label));
    if (match && keptIds.has(match)) match = undefined; // one line per existing option
    if (match) keptIds.add(match);
    matches.push(match);
  }

  /* the codes that survive this paste — the only ones a new option must avoid */
  const usedCodes = new Set<string>([...keptIds].map((o) => String(o.code)));
  const out: Option[] = [];
  /*
   * WHERE THE NUMBERING STARTS.
   *
   * "When options are pasted directly into the question, the option numbering
   * is starting from 2 instead of 1 … the first option always starts at 1 and
   * subsequent options increment sequentially (1, 2, 3, 4…)."
   *
   * Numbering began at `nextCode(existing)` — one past the highest code in the
   * old list — for both modes. For a paste that KEEPS some of the old options
   * that is the only safe choice: a removed option's code must not be handed
   * to a different option, or every condition, quota and stored answer naming
   * that code silently changes meaning (the rule this module opens with).
   *
   * But a replace that matches NOTHING is not an edit of the old list, it is
   * a new list — which is the case the report is about: a question sitting on
   * its starter "Option 1" coded 1, replaced wholesale, began at 2 and left
   * nothing coded 1. With no option kept there is no identity to protect, so
   * the fresh list numbers from 1.
   */
  let n = mode === "replace" && keptIds.size === 0 ? 1 : highWater;
  const fresh = () => { while (usedCodes.has(String(n))) n++; const c = String(n++); usedCodes.add(c); return c; };

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const match = matches[i];
    if (match) {
      out.push({ ...match, label: p.label || match.label });
      continue;
    }
    // new option: keep an explicit, non-colliding code; otherwise mint one
    const codeStr = String(p.code);
    const code = explicit.has(codeStr) && !usedCodes.has(codeStr) ? codeStr : fresh();
    usedCodes.add(code);
    out.push({ ...p, code });
  }
  const removed = existing.filter((o) => !keptIds.has(o));
  return { options: out, kept: keptIds.size, added: out.length - keptIds.size, removed: removed.length, removedCodes: removed.map((o) => o.code) };
}

/** The current list as `code<TAB>label` lines — what the paste box opens with. */
export function optionsToPaste(options: Option[]): string {
  return options.map((o) => `${o.code}\t${o.label.replace(/<[^>]*>/g, "")}`).join("\n");
}
