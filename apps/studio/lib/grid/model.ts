import type { Question, SurveyDefinition } from "@rescript/schema";
import { resolveVariant, variantRegistry, variantForLegacyType } from "@rescript/schema";
import {
  listBlocks, conditionSummary, stripHtmlText, objectKey, questionsInFlowOrder,
  type ObjectKey, type ObjectStatusMap, type DependencyIndex, type StatusLevel,
} from "@rescript/engine";

/**
 * THE GRID MODEL — one survey as rows, derived and pure.
 *
 * The Grid environment shows hundreds of questions at once, one row each,
 * with the columns a programmer scans for: where it sits, what it asks, what
 * it offers, what gates it, what it jumps to, whether it is healthy, what it
 * depends on. None of that is stored; all of it is DERIVED from the same
 * definition every other environment edits, here, in functions with no
 * React in them so they are tested directly and cheap to memoise.
 *
 * Two layers, because they cost differently. `buildGridRows` is the cheap
 * layer — a linear pass over the questions — and runs on every edit.
 * `decorateGridRows` adds status and dependency counts from the engine's
 * `objectStatus` and `buildDependencyIndex`, which cost ~100 ms at 600
 * questions; the view computes those against a deferred definition so a
 * keystroke in a cell never waits on them.
 */

export interface GridRow {
  key: ObjectKey;
  id: string;
  code: string;
  variableName: string;
  type: string;
  /** the variant's display name — "Radio buttons", "Slider" — or the raw type */
  typeLabel: string;
  familyLabel: string;
  /** question text, tags stripped, trimmed */
  text: string;
  /** true when the stored text is plain enough to edit in a cell (no markup) */
  plainText: boolean;
  required: boolean;
  blockId: string | null;
  blockTitle: string;
  blockIndex: number;
  pageId: string | null;
  indexInPage: number;
  /** absolute position in flow order; unplaced questions sort last */
  flowIndex: number;
  unplaced: boolean;
  /** "Apple · Bosch · Candy" / "5 rows × 5 columns" / "0–100" */
  options: string;
  optionCount: number;
  display: string;
  skip: string;
  validation: string;
  /* the deferred layer — absent until decorated */
  status: StatusLevel;
  issueCount: number;
  dependsOn: number;
  usedBy: number;
}

/* ------------------------------------------------------------ cheap layer */

/** the few entities a stripped label can still carry */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name] ?? (name.startsWith("#") ? String.fromCharCode(Number(name.slice(1))) || m : m));
}

/** the variant a question resolves to — by id, or by its legacy type when saved without one */
function variantOf(q: Question) {
  return resolveVariant(q.variant ?? undefined)
    ?? (variantForLegacyType(q.type) ? variantRegistry.get(variantForLegacyType(q.type)!) : undefined);
}

function optionsText(q: Question): { text: string; count: number } {
  const opts = q.options ?? [];
  const rows = q.rows ?? [];
  const cols = q.columns ?? [];
  const label = (o: { label?: string; code?: unknown }) => decodeEntities(stripHtmlText(o.label ?? "")) || String(o.code ?? "");
  if (rows.length && (cols.length || opts.length)) {
    return { text: `${rows.length} row${rows.length === 1 ? "" : "s"} × ${(cols.length || opts.length)} column${(cols.length || opts.length) === 1 ? "" : "s"}`, count: rows.length * (cols.length || opts.length) };
  }
  if (opts.length) {
    const shown = opts.slice(0, 6).map(label);
    return { text: shown.join(" · ") + (opts.length > 6 ? ` · +${opts.length - 6}` : ""), count: opts.length };
  }
  if (rows.length) {
    return { text: rows.slice(0, 6).map(label).join(" · ") + (rows.length > 6 ? ` · +${rows.length - 6}` : ""), count: rows.length };
  }
  const st = (q.settings ?? {}) as Record<string, unknown>;
  const lo = st.minValue ?? st.min;
  const hi = st.maxValue ?? st.max;
  if (typeof lo === "number" || typeof hi === "number") return { text: `${lo ?? "…"}–${hi ?? "…"}`, count: 0 };
  if (q.type === "nps") return { text: "0–10", count: 11 };
  return { text: "", count: 0 };
}

function skipText(def: SurveyDefinition, q: Question): string {
  const rules = q.skipLogic ?? [];
  if (!rules.length) return "";
  const byId = new Map(def.questions.map((x) => [x.id, x.code]));
  return rules.map((r) => {
    const t = r.target;
    const where = t.kind === "question" ? (byId.get(t.ref ?? "") ?? t.ref)
      : t.kind === "terminate" ? `end (${t.status ?? "terminated"})`
        : t.kind === "end" ? "end"
          : t.kind === "url" ? "url"
            : `${t.kind} ${t.ref ?? ""}`.trim();
    return `→ ${where} when ${conditionSummary(def, r.when)}`;
  }).join("; ");
}

function validationText(q: Question): string {
  const rules = q.validation ?? [];
  const parts: string[] = [];
  if (q.required) parts.push("required");
  for (const v of rules) {
    const kind = String(v.kind).replace(/_/g, " ");
    parts.push(v.value !== undefined && v.value !== null && v.value !== "" && typeof v.value !== "object" ? `${kind} ${v.value}` : kind);
  }
  return parts.join(", ");
}

export function buildGridRows(def: SurveyDefinition): GridRow[] {
  const placement = new Map<string, { blockId: string; blockTitle: string; blockIndex: number; pageId: string; indexInPage: number }>();
  listBlocks(def.flow as unknown[]).forEach((b, bi) => {
    for (const p of b.pages) {
      p.node.questionIds.forEach((qid, i) => {
        if (!placement.has(qid)) placement.set(qid, { blockId: b.id, blockTitle: b.title ?? `Block ${bi + 1}`, blockIndex: bi, pageId: p.node.id, indexInPage: i });
      });
    }
  });

  // flow order, whatever order the array happens to be in; unplaced questions come last
  return questionsInFlowOrder(def).map((q, i) => {
    const v = variantOf(q);
    const place = placement.get(q.id);
    const text = decodeEntities(stripHtmlText(q.text ?? "")).trim();
    const raw = String(q.text ?? "");
    const opts = optionsText(q);
    return {
      key: objectKey("question", q.id),
      id: q.id,
      code: q.code,
      variableName: q.variableName,
      type: q.type,
      typeLabel: v?.name ?? q.type,
      familyLabel: v?.familyLabel ?? q.type,
      text,
      plainText: !/<[a-z][\s\S]*>/i.test(raw) && !raw.includes("{{"),
      required: !!q.required,
      blockId: place?.blockId ?? null,
      blockTitle: place?.blockTitle ?? "—",
      blockIndex: place?.blockIndex ?? Number.MAX_SAFE_INTEGER,
      pageId: place?.pageId ?? null,
      indexInPage: place?.indexInPage ?? -1,
      flowIndex: i,
      unplaced: !place,
      options: opts.text,
      optionCount: opts.count,
      display: q.displayLogic ? conditionSummary(def, q.displayLogic) : "",
      skip: skipText(def, q),
      validation: validationText(q),
      status: "ok",
      issueCount: 0,
      dependsOn: 0,
      usedBy: 0,
    };
  });
}

/* ------------------------------------------------------------ deferred layer */

export function decorateGridRows(rows: GridRow[], status: ObjectStatusMap, index: DependencyIndex): GridRow[] {
  return rows.map((r) => {
    const st = status.statusOf(r.key);
    const dependsOn = new Set(index.dependsOn(r.key).map((e) => e.to)).size;
    const usedBy = new Set(index.usedBy(r.key).map((e) => e.from)).size;
    if (st.level === r.status && st.issues.length === r.issueCount && dependsOn === r.dependsOn && usedBy === r.usedBy) return r;
    return { ...r, status: st.level, issueCount: st.issues.length, dependsOn, usedBy };
  });
}

/* ------------------------------------------------------------ columns */

export type GridColumnId =
  | "status" | "code" | "type" | "variable" | "text" | "options" | "display" | "skip"
  | "validation" | "required" | "deps" | "block";

export interface GridColumn {
  id: GridColumnId;
  label: string;
  /** px; the text column stretches */
  width: number;
  minWidth: number;
  /** sticks to the left edge while scrolling horizontally */
  frozen?: boolean;
  /** the text column grows to fill */
  grow?: boolean;
  sortable: boolean;
  defaultVisible: boolean;
  align?: "left" | "center" | "right";
  /** inline-editable in the grid */
  editable?: boolean;
  description: string;
}

export const GRID_COLUMNS: readonly GridColumn[] = [
  { id: "status", label: "", width: 34, minWidth: 34, frozen: true, sortable: true, defaultVisible: true, align: "center", description: "Health: a problem, a warning, or nothing to report" },
  { id: "code", label: "ID", width: 92, minWidth: 70, frozen: true, sortable: true, defaultVisible: true, description: "Question code" },
  { id: "type", label: "Type", width: 150, minWidth: 110, sortable: true, defaultVisible: true, editable: true, description: "Question type" },
  { id: "variable", label: "Variable", width: 160, minWidth: 110, sortable: true, defaultVisible: true, editable: true, description: "Exported variable name" },
  { id: "text", label: "Question", width: 360, minWidth: 200, grow: true, sortable: true, defaultVisible: true, editable: true, description: "Question text" },
  { id: "options", label: "Options", width: 240, minWidth: 140, sortable: true, defaultVisible: true, editable: true, description: "Answer options, rows × columns, or range — double-click to edit the list" },
  { id: "display", label: "Display logic", width: 240, minWidth: 140, sortable: true, defaultVisible: true, description: "Shown when…" },
  { id: "skip", label: "Skip logic", width: 200, minWidth: 120, sortable: true, defaultVisible: true, description: "Jumps after this question" },
  { id: "validation", label: "Validation", width: 160, minWidth: 100, sortable: true, defaultVisible: true, description: "Required and validation rules" },
  { id: "required", label: "Req.", width: 56, minWidth: 56, sortable: true, defaultVisible: false, align: "center", editable: true, description: "Required" },
  { id: "deps", label: "Deps", width: 84, minWidth: 70, sortable: true, defaultVisible: true, align: "center", description: "Reads ← / read by →" },
  { id: "block", label: "Block", width: 150, minWidth: 100, sortable: true, defaultVisible: true, editable: true, description: "The block the question sits in" },
];

export const DEFAULT_VISIBLE_COLUMNS: GridColumnId[] = GRID_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);

/* ------------------------------------------------------------ query */

export interface SortSpec { column: GridColumnId; dir: "asc" | "desc" }

export interface GridFilter {
  search: string;
  /** null = any */
  types: string[] | null;
  withLogic: boolean;
  withIssues: boolean;
  /** block id, or null = any */
  block: string | null;
}

export const EMPTY_FILTER: GridFilter = { search: "", types: null, withLogic: false, withIssues: false, block: null };

const STATUS_RANK: Record<StatusLevel, number> = { error: 0, warning: 1, ok: 2 };

function sortValue(r: GridRow, col: GridColumnId): string | number {
  switch (col) {
    case "status": return STATUS_RANK[r.status];
    case "code": return r.flowIndex;               // "sort by ID" is flow order, not alphabetical Q1, Q10, Q2
    case "type": return r.typeLabel.toLowerCase();
    case "variable": return r.variableName.toLowerCase();
    case "text": return r.text.toLowerCase();
    case "options": return r.optionCount;
    case "display": return r.display ? 0 : 1;      // gated first
    case "skip": return r.skip ? 0 : 1;
    case "validation": return r.validation.toLowerCase();
    case "required": return r.required ? 0 : 1;
    case "deps": return -(r.dependsOn + r.usedBy);
    case "block": return r.blockIndex * 10000 + r.indexInPage;
  }
}

export function applyGridQuery(rows: GridRow[], filter: GridFilter, sort: SortSpec | null): GridRow[] {
  const q = filter.search.trim().toLowerCase();
  let out = rows.filter((r) => {
    if (filter.types && !filter.types.includes(r.type)) return false;
    if (filter.withLogic && !r.display && !r.skip) return false;
    if (filter.withIssues && r.status === "ok") return false;
    if (filter.block && r.blockId !== filter.block) return false;
    if (q) {
      const hay = `${r.code} ${r.variableName} ${r.text} ${r.typeLabel} ${r.options} ${r.display} ${r.skip} ${r.blockTitle}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const va = sortValue(a, sort.column);
      const vb = sortValue(b, sort.column);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.flowIndex - b.flowIndex;             // stable: flow order breaks ties
    });
  }
  return out;
}

/** the distinct question types present, for the type filter */
export function typesIn(rows: GridRow[]): { type: string; label: string; count: number }[] {
  const m = new Map<string, { type: string; label: string; count: number }>();
  for (const r of rows) {
    const cur = m.get(r.type) ?? { type: r.type, label: r.familyLabel, count: 0 };
    cur.count++;
    m.set(r.type, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------ windowing */

export type Density = "compact" | "normal" | "comfortable";
export const ROW_HEIGHT: Record<Density, number> = { compact: 28, normal: 36, comfortable: 46 };

/**
 * Which rows to render for a scroll position — the whole of the windowing
 * arithmetic, kept pure so it is tested. `overscan` rows above and below
 * keep fast scrolling from showing blank rows before the next paint.
 */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, total: number, overscan = 8): { start: number; end: number; offsetTop: number; totalHeight: number } {
  const first = Math.min(Math.floor(Math.max(0, scrollTop) / rowHeight), Math.max(0, total - 1));
  const count = Math.ceil(viewportHeight / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + count + overscan);
  return { start, end, offsetTop: start * rowHeight, totalHeight: total * rowHeight };
}
