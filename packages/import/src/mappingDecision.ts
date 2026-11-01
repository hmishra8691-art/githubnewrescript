import type { CanonicalQuestion } from "./canonical.js";

/**
 * MAPPING DECISIONS (import brief §3): for every imported question, how close
 * the Rescript result is to the source — said as one of five classes, never
 * as a silent downgrade.
 *
 *   exact            a native Rescript type/variant with the same behaviour and data shape
 *   components       rebuilt from existing Studio components; something changed (the note says what)
 *   needs_runtime    Rescript has no runtime for it; a placeholder keeps the position (the note says what is missing)
 *   needs_js         only reproducible with custom script; the source code is kept, disabled
 *   unsupported      no equivalent; a placeholder keeps the position and the source is in the report
 *
 * The class is derived from what the adapter and mapper actually did (the
 * canonical kind, its confidence and notes), plus a short table of source
 * types that need a specific explanation. Deriving it — instead of keeping a
 * second type table — means the class cannot drift from the conversion.
 */
export type MappingClass = "exact" | "components" | "needs_runtime" | "needs_js" | "unsupported";

export interface MappingDecision {
  sourceId: string;
  variable: string;
  /** the source's own type words, "MC/SAVR" */
  sourceType: string;
  /** the Rescript kind it became ("single", "matrix_mixed", "unknown") */
  target: string;
  decision: MappingClass;
  note: string;
}

/**
 * Qualtrics types that need a specific sentence. Keyed by "Type" or
 * "Type/Selector"; the more specific key wins.
 */
export const QSF_TYPE_GUIDANCE: Record<string, { decision: MappingClass; note: string }> = {
  Captcha: { decision: "unsupported", note: "Rescript has no CAPTCHA question. Bot screening is done by the quality rules (behaviour, timing, webdriver flag); a placeholder keeps the position." },
  DD: { decision: "needs_runtime", note: "A Qualtrics drill-down (multi-level linked lists). Rescript's dependent-list variant (single.cascade) has two levels; rebuild it there, or as one dropdown per level with option logic." },
  HL: { decision: "unsupported", note: "A Qualtrics text highlighter (respondents mark words in a passage). Rescript has no text-highlighting question; a placeholder keeps the position." },
  GAP: { decision: "components", note: "A Qualtrics gap analysis: two rating columns per row. Rebuilt as a mixed grid would keep both columns; check the column scales." },
  HeatMap: { decision: "components", note: "Imported as a hotspot question; Qualtrics heat-map clicks become hotspot coordinates. Redraw the image regions in Studio." },
  HotSpot: { decision: "components", note: "Imported as a hotspot question. The QSF does not carry the region shapes in a form Rescript can reuse; redraw the regions." },
  PGR: { decision: "components", note: "Imported as a bucket sort (items into groups). The rank inside each group is not recorded." },
  SBS: { decision: "components", note: "Imported as a mixed grid (one column per side-by-side question). Data columns are <variable>_<column>_<row>." },
  Timing: { decision: "components", note: "A Qualtrics page timer. Rescript records page time in its paradata; a minimum submit time or an auto-advance in the source becomes a native page timer." },
  Meta: { decision: "components", note: "Qualtrics browser meta information. Rescript's paradata records browser, OS, device class and screen size for every response; the hidden variable keeps the position in the data map." },
  "Matrix/MaxDiff": { decision: "components", note: "A Qualtrics MaxDiff matrix. Rescript MaxDiff runs from a design; the items were kept as rows — generate the design in Studio." },
};

export function classifyMapping(q: CanonicalQuestion): MappingDecision {
  const [type, sel] = q.sourceType.split("/");
  const guide = QSF_TYPE_GUIDANCE[`${type}/${sel}`] ?? QSF_TYPE_GUIDANCE[type];
  const base = { sourceId: q.sourceId, variable: q.variable, sourceType: q.sourceType, target: q.kind };
  /* a type with its own sentence: the sentence, unless the adapter could not convert it at all */
  if (guide) {
    if (q.kind === "unknown" && guide.decision !== "unsupported" && guide.decision !== "needs_runtime") return { ...base, decision: "unsupported", note: guide.note };
    return { ...base, ...guide };
  }
  if (q.kind === "unknown") return { ...base, decision: "unsupported", note: `${q.sourceType || "This"} question has no Rescript equivalent; a placeholder keeps its position.` };
  /* custom code that carries behaviour the type does not: the type may convert, the behaviour does not until the script is reviewed */
  if (q.custom.some((c) => c.language === "javascript")) {
    const other = q.notes.filter((x) => !/javascript/i.test(x)).pop();
    return { ...base, decision: "needs_js", note: `It carries custom JavaScript that changes its behaviour; the script is kept disabled until it is reviewed.${other ? ` Also: ${other}` : ""}` };
  }
  if (q.confidence === "confirmed") return { ...base, decision: "exact", note: "Native equivalent." };
  return { ...base, decision: "components", note: q.notes[q.notes.length - 1] ?? "Converted with changes; see the question's notes." };
}

export function mappingSummary(ds: MappingDecision[]): Record<MappingClass, number> {
  const out: Record<MappingClass, number> = { exact: 0, components: 0, needs_runtime: 0, needs_js: 0, unsupported: 0 };
  for (const d of ds) out[d.decision]++;
  return out;
}
