import type { SurveyDefinition, Question } from "@rescript/schema";
import { flowOutline, blockSize, type BlockRef } from "@rescript/engine";

/**
 * What an export contains.
 *
 * One configuration drives BOTH the Word document and the JSON file, so the
 * two can never disagree about what the survey is — they are two renderings
 * of the same reading of the same definition. Nothing here re-describes the
 * survey; `surveyOutline()` walks `definition.flow` exactly as the Studio and
 * the runtime do.
 */
export interface ExportFields {
  /* question information */
  questionId: boolean;
  questionText: boolean;
  questionType: boolean;
  options: boolean;
  validation: boolean;
  required: boolean;
  /* logic information */
  displayLogic: boolean;
  skipLogic: boolean;
  branchLogic: boolean;
  optionLogic: boolean;
  piping: boolean;
  randomization: boolean;
  /* survey structure */
  blockName: boolean;
  pageBreaks: boolean;
  blockOrder: boolean;
  flowElements: boolean;
  embeddedData: boolean;
}

export const ALL_FIELDS: (keyof ExportFields)[] = [
  "questionId", "questionText", "questionType", "options", "validation", "required",
  "displayLogic", "skipLogic", "branchLogic", "optionLogic", "piping", "randomization",
  "blockName", "pageBreaks", "blockOrder", "flowElements", "embeddedData",
];

export const FIELD_LABELS: Record<keyof ExportFields, string> = {
  questionId: "Question ID",
  questionText: "Question text",
  questionType: "Question type",
  options: "Options / answer choices",
  validation: "Validation rules",
  required: "Required / optional",
  displayLogic: "Display logic",
  skipLogic: "Skip logic",
  branchLogic: "Branch logic",
  optionLogic: "Option-level logic",
  piping: "Piping",
  randomization: "Randomization",
  blockName: "Block name",
  pageBreaks: "Page breaks",
  blockOrder: "Block order",
  flowElements: "Survey flow elements",
  embeddedData: "Embedded data",
};

export const FIELD_GROUPS: { title: string; fields: (keyof ExportFields)[] }[] = [
  { title: "Question information", fields: ["questionId", "questionText", "questionType", "options", "validation", "required"] },
  { title: "Logic information", fields: ["displayLogic", "skipLogic", "branchLogic", "optionLogic", "piping", "randomization"] },
  { title: "Survey structure", fields: ["blockName", "pageBreaks", "blockOrder", "flowElements", "embeddedData"] },
];

const only = (on: (keyof ExportFields)[]): ExportFields =>
  Object.fromEntries(ALL_FIELDS.map((f) => [f, on.includes(f)])) as unknown as ExportFields;

/**
 * Presets. "Basic" is what a client reviews; "spec" is what another
 * programmer needs to rebuild the survey; "full" is everything there is.
 */
export const EXPORT_PRESETS = {
  basic: only(["questionId", "questionText", "questionType", "options", "blockName", "blockOrder"]),
  // Everything another programmer needs to rebuild the survey — including
  // page breaks and option-level logic, which change what a respondent sees.
  // It is deliberately a PROPER subset of "full": if the two were identical,
  // offering both would be a lie. What full adds is the required/optional
  // flag, which a spec reader infers from the validation rules anyway.
  spec: only([
    "questionId", "questionText", "questionType", "options",
    "validation", "displayLogic", "skipLogic", "branchLogic", "optionLogic",
    "piping", "randomization",
    "blockName", "pageBreaks", "blockOrder", "flowElements", "embeddedData",
  ]),
  full: only(ALL_FIELDS),
} satisfies Record<string, ExportFields>;

export type PresetName = keyof typeof EXPORT_PRESETS;

export const PRESET_LABELS: Record<PresetName, { label: string; hint: string }> = {
  basic: { label: "Basic questionnaire", hint: "block, id, text, type and options — for client review" },
  spec: { label: "Programming specification", hint: "everything a programmer needs to rebuild it" },
  full: { label: "Full export", hint: "every field — the specification plus the required/optional flag" },
};

/** Which preset a selection corresponds to, or null when it is custom. */
export function matchPreset(f: ExportFields): PresetName | null {
  for (const [name, preset] of Object.entries(EXPORT_PRESETS) as [PresetName, ExportFields][]) {
    if (ALL_FIELDS.every((k) => preset[k] === f[k])) return name;
  }
  return null;
}

/* ------------------------------------------------------------- outline */

export interface OutlinePage {
  index: number;
  title?: string;
  questions: Question[];
  /** Ids listed on the page that no longer exist in `questions`. */
  missing: string[];
}

export interface OutlineBlock {
  kind: "block";
  /** 1-based position among blocks, in survey order. */
  number: number;
  id: string;
  title?: string;
  pages: OutlinePage[];
  questionCount: number;
}

export interface OutlineGroup {
  kind: "group";
  id: string;
  title?: string;
  children: OutlineEntry[];
}

export interface OutlineElement {
  kind: "element";
  id: string;
  type: string;
  /** The node itself. Callers must scrub it before writing it out. */
  node: any;
  /** One line a human can read. */
  summary: string;
  /**
   * What is INSIDE this element — a randomizer's or loop's children, and a
   * branch's arms. Without this, every block inside a branch is missing from
   * the exports while the Studio still shows it, which is the same survey
   * being described two different ways.
   */
  children?: OutlineEntry[];
  branches?: { id: string; label?: string; when: any; children: OutlineEntry[] }[];
  otherwise?: OutlineEntry[];
}

export type OutlineEntry = OutlineBlock | OutlineGroup | OutlineElement;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", times: "×", deg: "°", euro: "€", pound: "£",
};

/**
 * Question text is stored as the rich-text editor's innerHTML, so a typed "&"
 * is really "&amp;". Stripping tags alone would put "R&amp;D" in front of a
 * client — entities have to be decoded, not just tolerated.
 */
const text = (html: string) =>
  String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

export function elementSummary(node: any, def: SurveyDefinition): string {
  switch (node?.type) {
    case "branch": {
      const n = node.branches?.length ?? 0;
      return `${n} branch${n === 1 ? "" : "es"}${node.otherwise?.length ? " + otherwise" : ""}`;
    }
    case "randomizer":
      return node.show != null
        ? `show ${node.show} of ${node.children?.length ?? 0}, random order`
        : `${node.children?.length ?? 0} items in random order`;
    case "loop": {
      const src = node.source;
      const over = src?.kind === "question"
        ? (def.questions.find((q) => q.id === src.questionId)?.code ?? src.questionId)
        : src?.kind === "static" ? `${src.items?.length ?? 0} static items`
        : "a design file";
      return `loop over ${over} as {{${node.loopVar}}}`;
    }
    case "embedded_data":
      return (node.fields ?? []).map((f: any) => `${f.name} (${f.source})`).join(", ") || "no fields";
    case "quota_check":
      return `${(node.quotaIds ?? []).length} quota(s) → ${node.onFull?.kind ?? "?"} when full`;
    case "redirect":
      return node.url ?? "";
    case "end":
      return `${node.status}${node.message ? ` — “${text(node.message)}”` : ""}`;
    default:
      return node?.type ?? "";
  }
}

/**
 * The survey as blocks, groups and flow elements — the same reading the
 * Studio's Survey Flow shows, resolved against the question list so an
 * exporter never has to walk the flow itself.
 */
export function surveyOutline(def: SurveyDefinition): OutlineEntry[] {
  let blockNo = 0;
  const byId = new Map(def.questions.map((q) => [q.id, q]));

  const toBlock = (b: BlockRef): OutlineBlock => ({
    kind: "block",
    number: ++blockNo,
    id: b.id,
    title: b.title,
    questionCount: blockSize(b),
    pages: b.pages.map((p, i) => ({
      index: i + 1,
      title: p.node.title,
      questions: p.node.questionIds.map((id) => byId.get(id)).filter(Boolean) as Question[],
      missing: p.node.questionIds.filter((id) => !byId.has(id)),
    })),
  });

  const walk = (nodes: any[]): OutlineEntry[] =>
    flowOutline(nodes).map((e): OutlineEntry => {
      if (e.kind === "block") return toBlock(e.block);
      if (e.kind === "group") {
        return {
          kind: "group",
          id: e.node.id,
          title: e.node.title,
          // recurse rather than using e.blocks, so an element nested in a
          // group (a branch, say) keeps its own contents
          children: walk(e.node.children ?? []),
        };
      }
      const n = e.node;
      const el: OutlineElement = {
        kind: "element",
        id: n.id,
        type: n.type,
        node: n,
        summary: elementSummary(n, def),
      };
      // A branch arm or a loop body can hold whole blocks. They are part of
      // the survey and must be documented where they sit.
      if (Array.isArray(n.children) && n.children.length) el.children = walk(n.children);
      if (Array.isArray(n.branches)) {
        el.branches = n.branches.map((b: any) => ({
          id: b.id, label: b.label, when: b.when, children: walk(b.children ?? []),
        }));
      }
      if (Array.isArray(n.otherwise) && n.otherwise.length) el.otherwise = walk(n.otherwise);
      return el;
    });

  return walk(def.flow as any[]);
}

/** Flatten an outline to its blocks, in order, groups included. */
export function outlineBlocks(entries: OutlineEntry[]): OutlineBlock[] {
  return entries.flatMap((e) => {
    if (e.kind === "block") return [e];
    if (e.kind === "group") return outlineBlocks(e.children);
    return [
      ...outlineBlocks(e.children ?? []),
      ...(e.branches ?? []).flatMap((b) => outlineBlocks(b.children)),
      ...outlineBlocks(e.otherwise ?? []),
    ];
  });
}

/**
 * Strip from a raw flow node anything the export was not asked to include.
 *
 * The JSON export writes element nodes verbatim, and those nodes carry
 * conditions (`when`, `visibleIf`). Unticking "Branch logic" has to actually
 * remove them, or the box is decoration.
 */
export function scrubNode(node: any, fields: ExportFields): any {
  const drop = new Set<string>();
  if (!fields.branchLogic) { drop.add("when"); drop.add("visibleIf"); }
  if (drop.size === 0) return node;
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).filter(([k]) => !drop.has(k)).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(node);
}

export const plainText = text;
