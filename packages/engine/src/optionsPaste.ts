import type { Option } from "@rescript/schema";
import { nextCode } from "./renumber.js";

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

/** Parse pasted option lists: strips numbering (1. / 1) ), bullets (- * •) and supports "code<TAB>label" lines. */
export function parsePastedOptions(text: string, startCode: number): Option[] {
  let n = startCode;
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .map((line) => {
      const tab = line.split("\t");
      if (tab.length >= 2 && tab[0].trim()) {
        const code = tab[0].trim();
        return { code, label: tab.slice(1).join(" ").trim(), flags: [] as any[] } as Option;
      }
      const cleaned = line.trim().replace(/^\s*(\d{1,4}[.)]|[-*•‣▪])\s+/, "").trim();
      return { code: String(n++), label: cleaned || line.trim(), flags: [] as any[] } as Option;
    });
}

/** Did this pasted line carry its own code (`code<TAB>label`)? */
function explicitCodes(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const tab = raw.split("\t");
    if (tab.length >= 2 && tab[0].trim()) out.add(tab[0].trim());
  }
  return out;
}

const norm = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export function planPaste(existing: Option[], text: string, mode: PasteMode): PastePlan {
  const start = Number(nextCode(existing)) || 1;
  const parsed = parsePastedOptions(text, start);
  if (parsed.length === 0) return { options: existing, kept: existing.length, added: 0, removed: 0, removedCodes: [] };

  const byCode = new Map(existing.map((o) => [String(o.code), o]));
  const byLabel = new Map<string, Option>();
  for (const o of existing) if (!byLabel.has(norm(o.label))) byLabel.set(norm(o.label), o);
  const explicit = explicitCodes(text);

  if (mode === "append") {
    const used = new Set(existing.map((o) => String(o.code)));
    const out = [...existing];
    let n = start;
    const fresh = () => { while (used.has(String(n))) n++; const c = String(n++); used.add(c); return c; };
    for (const p of parsed) {
      const code = used.has(String(p.code)) ? fresh() : String(p.code);
      used.add(code);
      out.push({ ...p, code });
    }
    return { options: out, kept: existing.length, added: parsed.length, removed: 0, removedCodes: [] };
  }

  // replace: keep identity where a line names an existing option
  const usedCodes = new Set<string>();
  const out: Option[] = [];
  const keptIds = new Set<Option>();
  let n = start;
  const fresh = () => { while (usedCodes.has(String(n)) || byCode.has(String(n))) n++; return String(n++); };

  for (const p of parsed) {
    const codeStr = String(p.code);
    let match: Option | undefined;
    if (explicit.has(codeStr) && byCode.has(codeStr)) match = byCode.get(codeStr);
    if (!match) match = byLabel.get(norm(p.label));
    if (match && !keptIds.has(match)) {
      keptIds.add(match);
      usedCodes.add(String(match.code));
      out.push({ ...match, label: p.label || match.label });
      continue;
    }
    // new option: keep an explicit, non-colliding code; otherwise mint one
    const code = explicit.has(codeStr) && !usedCodes.has(codeStr) && !byCode.has(codeStr) ? codeStr : fresh();
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
