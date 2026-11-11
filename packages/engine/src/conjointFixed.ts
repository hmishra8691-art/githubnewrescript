/**
 * FIXED (CUSTOM) ALTERNATIVES IN A CHOICE-BASED CONJOINT (2026-11-10).
 *
 * A CBC task shows concepts built by the experimental design. Many studies also need an alternative that is the SAME in
 * every task and is not designed: "My current product", "Keep what I have now", a named competitor at its real
 * specification, or "Another product (please specify)". None of these is the None option ("I would not choose any")
 * and none is a level of an attribute.
 *
 *   design          configured on the design (`fixedAlternatives`), one line each:
 *                       My current product
 *                       Competitor X | Brand: X; Price: $12
 *                       Another product [specify]
 *                   A fixed alternative is added to every task after the designed concepts (before None) as a row with
 *                   `fixed_option` = its number (1, 2, …). It is NOT part of the experimental design: it is added after
 *                   the design is generated and measured, so level balance, overlap and D-efficiency are those of the
 *                   designed concepts alone.
 *   questionnaire   shown under its own label, after the designed concepts, never shuffled among them; attributes it
 *                   does not specify show "—". With `[specify]`, choosing it opens a text box.
 *   answer          the chosen `alt`, as for any alternative; the typed text under `<task>_other`
 *   data            `<VAR>_T<n>` (the alternative) and `<VAR>_T<n>_OTHER` (the text). The text is the respondent's own
 *                   words: it is never turned into an attribute level and never enters the model.
 *   analysis        each fixed alternative gets its own constant (an alternative-specific constant) on top of the
 *                   part-worths of any levels it specifies. An alternative with no levels is its constant alone.
 */
export interface FixedAlternative { label: string; levels: Record<string, string>; specify: boolean }

export const FIXED_OTHER_SUFFIX = "_other";
export const fixedOtherKey = (task: string | number): string => `${task}${FIXED_OTHER_SUFFIX}`;
export const isFixedOtherKey = (k: string): boolean => k.endsWith(FIXED_OTHER_SUFFIX);
export const MAX_FIXED_ALTERNATIVES = 4;

/** "Label", "Label [specify]", "Label | Attr: Level; Attr: Level" or { label, levels?, specify? } → fixed alternatives */
export function parseFixedAlternatives(v: unknown): FixedAlternative[] {
  if (!Array.isArray(v)) return [];
  const out: FixedAlternative[] = [];
  for (const x of v) {
    if (typeof x === "string") {
      const [head, ...rest] = x.split("|");
      let label = head.trim();
      if (!label) continue;
      const specify = /\[\s*(?:specify|other|text)\s*\]/i.test(label);
      label = label.replace(/\[\s*(?:specify|other|text)\s*\]/gi, "").trim();
      const levels: Record<string, string> = {};
      for (const part of rest.join("|").split(/\s*;\s*/)) {
        const m = /^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/.exec(part);
        if (m) levels[m[1]] = m[2];
      }
      if (label) out.push({ label, levels, specify });
    } else if (x && typeof x === "object") {
      const o = x as { label?: unknown; levels?: unknown; specify?: unknown };
      const label = String(o.label ?? "").trim();
      if (!label) continue;
      const levels: Record<string, string> = {};
      if (o.levels && typeof o.levels === "object" && !Array.isArray(o.levels)) for (const [k, val] of Object.entries(o.levels as Record<string, unknown>)) if (String(val ?? "").trim()) levels[k] = String(val).trim();
      out.push({ label, levels, specify: o.specify === true });
    }
  }
  return out;
}

export function fixedAlternativesOf(config: unknown): FixedAlternative[] {
  return parseFixedAlternatives((config as { fixedAlternatives?: unknown } | null | undefined)?.fixedAlternatives);
}

/** the fixed alternative a design row is (null for a designed concept or the None row) */
export function fixedAlternativeOfRow(config: unknown, row: Record<string, unknown>): (FixedAlternative & { index: number }) | null {
  const k = Number(row.fixed_option);
  if (!Number.isInteger(k) || k < 1) return null;
  const f = fixedAlternativesOf(config)[k - 1];
  return f ? { ...f, index: k } : { label: `Fixed alternative ${k}`, levels: {}, specify: false, index: k };
}
