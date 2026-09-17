/**
 * WHAT EACH QUESTION SHAPE ACTUALLY OWNS — and what changing a type must do.
 *
 * ## The problem this table exists to end
 *
 * A question's type used to be a label. Changing it wrote `q.type` and
 * `q.variant` and left everything else exactly where it was, so a question
 * that had been a 5-point matrix and was now an open end still carried five
 * rows, an option scale, a row mask, a randomization scoped to rows and a
 * `minSelections` of 2. Nothing displayed them, so the change looked clean —
 * but the things that read the schema rather than the screen did not agree:
 *
 *   · `gridAxes` calls any question with rows a grid, so the open end was
 *     still offered a per-row answer shape to export and to punch into;
 *   · Row / Column masking appeared in the properties panel purely because
 *     `rows.length > 0`, on a question that has no rows;
 *   · `validate.ts` skipped `required` for a flat question carrying rows,
 *     because a grid decides "answered" per row;
 *   · the Logic Builder offered the stale option codes as the right-hand
 *     side of a comparison against a value that can never be a code again.
 *
 * Every one of those is the same bug: several places each decided, from a
 * different field, what shape a question has. So there is now ONE declaration
 * of what a shape owns, and one function that moves a question from one shape
 * to another — and both live here, where a new response model is a new row in
 * a table rather than a hunt through thirty call sites.
 *
 * ## The rule the table encodes
 *
 * A field belongs to a question if the response model in force can read it.
 * Everything else is either transformed into something the new shape *can*
 * read, or removed — deliberately, named, and shown to the person making the
 * change before it happens. Nothing is silently retained.
 *
 * ## Where "keep" wins
 *
 * Where a field is genuinely ambiguous the table keeps it. Removal has to be
 * certain: a dropped option list cannot be reconstructed from a survey
 * definition, and a programmer can always delete a setting that survived.
 * So `derived` owns options (a hidden variable is the usual target of an auto
 * punch, and the punch needs codes to write), `coordinates` owns them
 * (timeline reactions offer a list at each tap), and the universal group
 * below is generous rather than minimal.
 */

import type { Question, ResponseModel, QuestionVariantDef } from "@rescript/schema";
import {
  effectiveResponseModel, responseModelOf, allowedValidationKinds,
  resolveVariant, variantForLegacyType,
} from "@rescript/schema";

/** The three list-valued fields a question can have. */
export type QuestionAxis = "options" | "rows" | "columns";
export const QUESTION_AXES: readonly QuestionAxis[] = ["options", "rows", "columns"];

/** The mask field that guards each axis. */
export const AXIS_MASK: Record<QuestionAxis, "mask" | "rowMask" | "columnMask"> = {
  options: "mask", rows: "rowMask", columns: "columnMask",
};

/** Human words for an axis, for the change list a person reads. */
const AXIS_LABEL: Record<QuestionAxis, string> = { options: "Options", rows: "Rows", columns: "Columns" };
/** The name of the FEATURE over an axis, which is singular: "Row masking". */
const AXIS_FEATURE: Record<QuestionAxis, string> = { options: "Option", rows: "Row", columns: "Column" };

/* ------------------------------------------------------------------ settings */

/**
 * Settings grouped by the thing they configure, so a response model declares
 * "numeric bounds" rather than re-listing `minValue`, `maxValue`, `step`
 * — and adding `stepLabel` tomorrow is one edit, not seventeen.
 */
const SETTING_GROUPS = {
  selection_count: ["minSelections", "maxSelections"],
  other_specify: ["otherSpecifyOptional"],
  numeric_bounds: ["minValue", "maxValue", "step"],
  scale_labels: ["npsLeftLabel", "npsRightLabel", "sliderLeftLabel", "sliderRightLabel"],
  sum: ["sumTarget", "sumUnit", "chipValue"],
  row_sum: ["rowSum"],
  list_length: ["listCount", "minRepeats", "maxRepeats"],
  rank: ["rankMode", "tournamentTopN"],
  geo: ["geoMode", "mapCenter", "mapZoom", "allowGeolocation",
        "radiusMinM", "radiusMaxM", "radiusDefaultM", "mapTiles", "multiRegion"],
  upload: ["accept", "maxSizeMb", "maxFiles"],
  drawing: ["tools", "penColor", "penWidth"],
  timeline: ["timelineMode"],
  date_window: ["minDate", "maxDate", "timeSlots", "disabledWeekdays", "minYear", "maxYear"],
  speech: ["speechInput", "speechLang"],
  derived: ["expression", "arms"],
  option_order: ["optionOrder"],
  layout_columns: ["columnsLayout"],
  slider_layout: ["sliderLayout", "orientation"],
  swipe: ["swipeDirections"],
  quiz: ["showFeedback", "pointsPerCorrect"],
  attention_codes: ["expectedCodes", "onFail"],
  range_pair: ["rangePair"],
  design_ref: ["designRef"],
  placeholder: ["placeholder"],
  interview_video: ["interviewVideo", "requireWatch", "allowSeek", "allowReplay",
                    "showProgress", "autoPlayVideo"],
  interview_answer: ["requireAudioAnswer", "minAnswerSeconds", "maxAnswerSeconds",
                     "allowAnswerPause", "maxRetakes", "reviewBeforeSubmit"],
  interview_transcript: ["transcribeAnswer", "transcriptLanguage", "transcriptVisibility",
                         "saveAnswerAudio", "saveTranscript"],
} as const;

type SettingGroup = keyof typeof SETTING_GROUPS;

/**
 * Settings every shape reads, whatever it is: presentation, stimulus,
 * accessibility, timing, and the two fields that make a question a question.
 * These survive every conversion because every renderer honours them.
 */
const UNIVERSAL_SETTINGS: readonly string[] = [
  "readOnly", "hidden", "defaultValue",
  "imageUrl", "mediaUrl", "requireComplete",
  "timeLimitSeconds", "onTimeout", "chatDelayMs",
  "accessibility", "adaptive",
];

/** Human words for a setting, for the change list. */
const SETTING_LABEL: Record<string, string> = {
  minSelections: "Minimum selections", maxSelections: "Maximum selections",
  otherSpecifyOptional: "Other-specify optional",
  minValue: "Minimum value", maxValue: "Maximum value", step: "Step",
  npsLeftLabel: "Left-end label", npsRightLabel: "Right-end label",
  sliderLeftLabel: "Left-end label", sliderRightLabel: "Right-end label",
  sumTarget: "Sum target", sumUnit: "Sum unit", chipValue: "Chip value", rowSum: "Per-row sum",
  listCount: "Number of fields", minRepeats: "Minimum repeats", maxRepeats: "Maximum repeats",
  rankMode: "Ranking mode", tournamentTopN: "Tournament top N",
  interviewVideo: "The researcher's video", requireWatch: "Require complete playback",
  allowSeek: "Allow seeking", allowReplay: "Allow replay", showProgress: "Show progress",
  autoPlayVideo: "Auto-play",
  requireAudioAnswer: "Audio response required", minAnswerSeconds: "Minimum recording length",
  maxAnswerSeconds: "Maximum recording length", allowAnswerPause: "Allow pause",
  maxRetakes: "Maximum re-records", reviewBeforeSubmit: "Play back before submitting",
  transcribeAnswer: "Automatic transcription", transcriptLanguage: "Transcript language",
  transcriptVisibility: "Transcript visibility", saveAnswerAudio: "Save original audio",
  saveTranscript: "Save transcript",
  geoMode: "Map mode", mapCenter: "Map centre", mapZoom: "Map zoom",
  allowGeolocation: "Use my location", radiusMinM: "Minimum radius",
  radiusMaxM: "Maximum radius", radiusDefaultM: "Default radius", mapTiles: "Map tiles",
  multiRegion: "Several regions",
  accept: "Accepted file types", maxSizeMb: "Maximum file size", maxFiles: "Maximum files",
  tools: "Drawing tools", penColor: "Pen colour", penWidth: "Pen width",
  timelineMode: "Timeline mode",
  minDate: "Earliest date", maxDate: "Latest date", timeSlots: "Time slots",
  disabledWeekdays: "Disabled weekdays", minYear: "Earliest year", maxYear: "Latest year",
  speechInput: "Speech input", speechLang: "Speech language",
  expression: "Expression", arms: "Experiment arms",
  optionOrder: "Option sort", columnsLayout: "Layout columns",
  sliderLayout: "Slider layout", orientation: "Orientation",
  swipeDirections: "Swipe directions",
  showFeedback: "Show feedback", pointsPerCorrect: "Points per correct",
  expectedCodes: "Expected codes", onFail: "On failure",
  rangePair: "Range pair", designRef: "Design file", placeholder: "Placeholder",
};

/* ------------------------------------------------------------------- the table */

export interface ShapeSpec {
  /** The list-valued fields this shape reads. */
  axes: readonly QuestionAxis[];
  /** The setting groups this shape reads, beyond the universal ones. */
  groups: readonly SettingGroup[];
  /** Plain words for the shape, used in the confirmation a person reads. */
  label: string;
}

/**
 * THE ONE TABLE. A response model reads exactly these axes and these setting
 * groups; every other field on the question is not its business.
 */
export const SHAPES: Record<ResponseModel, ShapeSpec> = {
  single_choice: {
    label: "one choice",
    axes: ["options"],
    groups: ["other_specify", "option_order", "layout_columns", "quiz", "attention_codes", "swipe"],
  },
  multiple_choice: {
    label: "several choices",
    axes: ["options"],
    groups: ["selection_count", "other_specify", "option_order", "layout_columns", "quiz", "attention_codes", "swipe"],
  },
  text: {
    label: "text",
    axes: [],
    groups: ["speech", "date_window", "placeholder"],
  },
  numeric: {
    label: "a number",
    axes: [],
    groups: ["numeric_bounds", "scale_labels", "range_pair", "slider_layout", "placeholder"],
  },
  fields: {
    label: "a list of fields",
    axes: ["rows"],
    groups: ["list_length", "numeric_bounds", "layout_columns", "placeholder"],
  },
  per_row: {
    label: "one answer per row",
    /*
     * `columns` is here because the platform genuinely supports a per-row
     * scale written as `columns[0].options` as well as on `q.options` —
     * `gridScaleOptions` resolves both, and a question authored the second
     * way renders correctly. A shape must own every spelling the runtime
     * honours, or the migration removes working configuration.
     */
    axes: ["options", "rows", "columns"],
    groups: ["selection_count", "other_specify", "numeric_bounds", "scale_labels",
             "option_order", "slider_layout", "layout_columns", "row_sum", "swipe"],
  },
  cells: {
    label: "a value per cell",
    /* a constant-sum grid totals each ROW against `sumTarget` — `rowSum` is
       the switch, `sum` is the target it is measured against */
    axes: ["rows", "columns"],
    groups: ["row_sum", "sum", "layout_columns", "placeholder"],
  },
  rank_order: {
    label: "a ranked order",
    axes: ["options"],
    groups: ["rank", "selection_count", "option_order", "layout_columns"],
  },
  allocation: {
    label: "an allocation",
    axes: ["options"],
    groups: ["sum", "numeric_bounds", "option_order", "layout_columns"],
  },
  tasks: {
    label: "choice tasks",
    axes: ["options"],
    groups: ["design_ref", "selection_count"],
  },
  coordinates: {
    label: "points on a stimulus",
    axes: ["options"],
    groups: ["drawing", "timeline", "selection_count"],
  },
  geo: { label: "a place", axes: [], groups: ["geo"] },
  derived: { label: "a derived value", axes: ["options"], groups: ["derived", "placeholder"] },
  media: { label: "an uploaded file", axes: [], groups: ["upload"] },
  /*
   * A recorded interview: the watch record, the clip and the transcript, as
   * one value. No axes — there is nothing to choose from — and three setting
   * groups, because the researcher's video, the spoken answer and the
   * transcript are configured independently of one another.
   */
  interview: {
    label: "a recorded interview answer",
    axes: [],
    groups: ["interview_video", "interview_answer", "interview_transcript", "speech"],
  },
  none: { label: "nothing (display only)", axes: [], groups: [] },
};

/** The shape in force for a question — variant first, then base type. */
export function shapeOf(q: { type: string; variant?: string | null }): ShapeSpec {
  return SHAPES[effectiveResponseModel(q)] ?? SHAPES.none;
}

/** Does this shape read this list? The one question `gridAxes`, the properties
 *  panel and the validator must all ask instead of counting array entries. */
export function shapeHasAxis(q: { type: string; variant?: string | null }, axis: QuestionAxis): boolean {
  return shapeOf(q).axes.includes(axis);
}

/** Every setting key the shape reads. */
export function settingsOf(model: ResponseModel): Set<string> {
  const spec = SHAPES[model] ?? SHAPES.none;
  const keys = new Set<string>(UNIVERSAL_SETTINGS);
  for (const g of spec.groups) for (const k of SETTING_GROUPS[g]) keys.add(k);
  return keys;
}

/* --------------------------------------------------------------- the migration */

export type ChangeKind = "transformed" | "removed" | "reset";

export interface MigrationChange {
  kind: ChangeKind;
  /** Dotted path of the field, e.g. `settings.minSelections`. */
  field: string;
  /** What a person is told, e.g. "3 options became 3 rows". */
  detail: string;
}

export interface TypeMigration {
  /** The migrated question. The input is never mutated. */
  q: Question;
  from: { type: string; variant?: string; model: ResponseModel; label: string };
  to: { type: string; variant?: string; model: ResponseModel; label: string };
  /** Same response model both sides — nothing structural moves. */
  safe: boolean;
  /** Everything that is not simply carried across, in reading order. */
  changes: MigrationChange[];
  /** Fields carried across unchanged that a person might expect to lose. */
  kept: string[];
}

/**
 * Where a list goes when the new shape has no room for it.
 *
 * `options` and `rows` are the same kind of thing — a flat list of codes with
 * labels — so one becomes the other without inventing anything: a
 * single-select converted to a text list keeps its five options as its five
 * fields, codes and labels intact, instead of asking the programmer to retype
 * them. That is the whole donation table, deliberately.
 *
 * `columns` is not on it, because a column is not a code: it carries its own
 * response type, its own variable stem, its own option list and its own
 * validation, none of which can be guessed from an option. The one honest
 * conversion involving columns is the scale of a matrix, and it is handled on
 * its own below — a per-row scale IS a single column, so it becomes one, and
 * a single column carrying a scale becomes one again on the way back.
 */
const DONOR: Record<QuestionAxis, readonly QuestionAxis[]> = {
  rows: ["options"],
  options: ["rows"],
  columns: [],
};

function label(axis: QuestionAxis) { return AXIS_LABEL[axis].toLowerCase(); }

/* ------------------------------------------------ which variant is in force */

/**
 * THE TARGET OF A TYPE CHANGE IS A VARIANT, WHETHER OR NOT THE CALLER NAMED ONE.
 *
 * `q.variant` is not a label either: it decides the response model
 * (`effectiveResponseModel`), the renderer, the capabilities the properties
 * panel offers, the validation kinds that are allowed, and the placeholder the
 * respondent reads. So a question carrying a variant that does not belong to
 * its type is not a cosmetic inconsistency — it is a question whose shape two
 * different readers will answer differently.
 *
 * That is what used to happen. The only line that touched the variant was
 *
 *     if ("id" in to && to.id) q.variant = to.id;
 *
 * so every caller that changed the BASE TYPE without naming a variant — an
 * import, a fixture, `staleFields`, the carousel config — left the old variant
 * in place. `open_text` + `text.email` became `numeric` + `text.email`: a
 * numeric question whose effective response model is still text, offering the
 * email validators and the `name@example.com` placeholder.
 *
 * It also meant the two things that ARE gated on the variant — the allowed
 * validation kinds and the capability-gated settings — were skipped entirely
 * on those paths, because the caller passed no `validations` and no
 * `capabilities`. `staleFields` takes exactly that path, so the lint whose job
 * is to find stale configuration could never see either of them.
 *
 * So the target is resolved here instead of trusted:
 *
 *   · a named variant wins (following `supersededBy`);
 *   · otherwise the CURRENT variant is kept if it belongs to the new base type
 *     — changing a preset's base type to its own base type is not a change;
 *   · otherwise the base type's default variant;
 *   · and only a base type with no variant at all leaves `variant` unset.
 */
interface ResolvedTarget {
  baseType: string;
  variant?: QuestionVariantDef;
  capabilities?: readonly string[];
  validations?: readonly string[];
  responseModel?: ResponseModel;
  /** the variant was guessed for a question that had none — see below */
  invented: boolean;
}

function resolveTarget(
  from: { type: string; variant?: string | null },
  to: QuestionVariantDef | { baseType: string; id?: string; capabilities?: readonly string[]; validations?: readonly string[]; responseModel?: ResponseModel },
): ResolvedTarget {
  const named = "id" in to && to.id ? resolveVariant(to.id) : undefined;
  /* a named variant is only the target if it stores as the type being asked
     for; `{ baseType: "numeric", id: "text.email" }` names an impossibility */
  const exact = named && named.baseType === to.baseType ? named : undefined;
  const current = resolveVariant(from.variant ?? undefined);
  const kept = !exact && current?.baseType === to.baseType ? current : undefined;
  const fallback = !exact && !kept ? resolveVariant(variantForLegacyType(to.baseType)) : undefined;
  const variant = exact ?? kept ?? fallback;
  return {
    baseType: to.baseType,
    variant,
    /*
     * The question never had a variant and nobody named one, so this is the
     * registry's best guess at what a legacy question of this base type
     * probably is — not a fact about the question. Capability-gated pruning is
     * skipped on a guess (see `invented` at the call site): `image_select`
     * backs both a single-choice and a multiple-choice variant, and picking
     * the wrong one would delete a `maxSelections` the question is using.
     */
    invented: !exact && !kept && !from.variant,
    /* an explicitly passed list still wins: a caller describing a variant this
       registry has never heard of knows more about it than the registry does */
    capabilities: ("capabilities" in to && to.capabilities) || variant?.capabilities,
    validations: ("validations" in to && to.validations) || variant?.validations,
    responseModel: ("responseModel" in to && to.responseModel) || variant?.responseModel,
  };
}

/** Structural equality, ignoring `id` and keys explicitly set to undefined —
 *  a rule stored on a question carries an id that a variant's default has not. */
function sameValue(a: unknown, b: unknown): boolean {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        if (k === "id") continue;
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) continue;
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** A matrix's shared scale, written as the one column a cell grid needs. */
function scaleAsColumn(q: Question, model: ResponseModel): any {
  const responseType =
    model === "per_row" && q.type === "matrix_multi" ? "multi"
    : model === "per_row" && q.type === "matrix_numeric" ? "numeric"
    : model === "per_row" && q.type === "matrix_text" ? "text"
    : model === "per_row" && q.type === "matrix_dropdown" ? "dropdown"
    : "single";
  return {
    id: `${q.id}_c1`,
    label: q.text?.slice(0, 60) || "Response",
    responseType,
    variableStem: q.variableName || q.code || "C1",
    options: (q.options ?? []).map((o) => ({ ...o })),
    validation: [],
  };
}

/**
 * Move a question from its current shape to `to`, deciding for every field
 * whether it is preserved, transformed, removed or reset.
 *
 * Returns the new question and the complete list of what changed, so the
 * caller can show it BEFORE applying — which is the whole point: a type
 * change that quietly drops a mask and a randomization is indistinguishable
 * from one that drops nothing, and the programmer finds out in fieldwork.
 *
 * `to` is a variant when the switcher has one (it carries capabilities the
 * base type does not), and a bare base type when something else — an import,
 * a fixture, an older definition — changes the type directly.
 */
export function migrateQuestionType(
  input: Question,
  to: QuestionVariantDef | { baseType: string; id?: string; capabilities?: readonly string[]; validations?: readonly string[]; responseModel?: ResponseModel },
): TypeMigration {
  const q: Question = JSON.parse(JSON.stringify(input));
  const fromVariant = resolveVariant(input.variant ?? undefined);
  const target = resolveTarget(input, to);
  const fromModel = effectiveResponseModel(input);
  const toModel = target.responseModel || responseModelOf(target.baseType);
  const fromSpec = SHAPES[fromModel] ?? SHAPES.none;
  const toSpec = SHAPES[toModel] ?? SHAPES.none;
  const caps = new Set<string>(target.capabilities ?? []);
  /*
   * Only prune against capabilities and validation kinds when they are KNOWN.
   * A guessed variant (`invented`) is authority enough to decide what a
   * question BECOMES — a type change is a deliberate act and the old settings
   * belong to the old type — but not to sit in judgement on a question nobody
   * is changing, which is the case `staleFields` walks into for every legacy
   * question in every survey written before variants existed.
   */
  const judge = !target.invented || input.type !== target.baseType;
  const hasCaps = caps.size > 0 && judge;
  const changes: MigrationChange[] = [];
  const kept: string[] = [];
  const add = (kind: ChangeKind, field: string, detail: string) => changes.push({ kind, field, detail });

  q.type = target.baseType;
  if (target.variant) {
    if (target.variant.id !== input.variant) q.variant = target.variant.id;
  } else if (q.variant) {
    /* nothing in the registry stores as this base type, so the variant on the
       question cannot be right whatever it was */
    delete (q as { variant?: string | null }).variant;
  }
  /*
   * A variant REPLACED by another is not reported: the dialog's own heading
   * already says what the question is becoming, and whatever the old variant
   * had configured is reported below, field by field, where it means
   * something. A variant DROPPED with nothing to put in its place is reported,
   * because it is the renderer the respondent met a moment ago going away with
   * no successor named.
   */
  if (fromVariant && !target.variant) {
    add("removed", "variant", `${fromVariant.name} — ${target.baseType} has no variant of its own`);
  }

  /* ------------------------------------------------------- 1. the three lists */

  const has = (axis: QuestionAxis) => ((q as any)[axis] as unknown[] | undefined)?.length ? true : false;
  const present = QUESTION_AXES.filter((a) => fromSpec.axes.includes(a) && has(a));
  const wanted = toSpec.axes;
  /** old axis → new axis, for everything that names an axis (masks, scopes). */
  const moved = new Map<QuestionAxis, QuestionAxis>();
  const spent = new Set<QuestionAxis>();

  for (const axis of wanted) {
    /*
     * The scale of a per-row grid IS the one column a cell grid needs, so it
     * becomes one — but only when the question has no columns of its own.
     * A per-row grid that already keeps its scale on `columns[0].options`
     * simply keeps that column.
     */
    if (axis === "columns" && toModel !== fromModel && !has("columns") && fromModel === "per_row"
      && present.includes("options") && !spent.has("options")) {
      spent.add("options");
      moved.set("options", "columns");
      const n = (q.options ?? []).length;
      q.columns = [scaleAsColumn(q, fromModel)] as any;
      q.options = [];
      add("transformed", "columns",
        `the ${n}-point scale became one column holding the same ${n} points`);
      continue;
    }
    if (fromSpec.axes.includes(axis)) { if (has(axis)) kept.push(AXIS_LABEL[axis]); continue; }

    /* the matrix scale ⇄ the one column of a cell grid */
    if (axis === "columns" && present.includes("options") && !spent.has("options")) {
      spent.add("options");
      moved.set("options", "columns");
      const n = (q.options ?? []).length;
      q.columns = [scaleAsColumn(q, fromModel)] as any;
      q.options = [];
      add("transformed", "columns",
        `the ${n}-point scale became one column holding the same ${n} points`);
      continue;
    }
    if (axis === "options" && present.includes("columns") && !spent.has("columns")) {
      const cols = (q.columns ?? []) as any[];
      const only = cols.length === 1 ? cols[0] : null;
      if (only?.options?.length) {
        spent.add("columns");
        moved.set("columns", "options");
        q.options = only.options.map((o: any) => ({ ...o }));
        q.columns = [];
        add("transformed", "options",
          `the single column's ${only.options.length} points became the shared scale`);
        continue;
      }
    }

    const donor = DONOR[axis].find((d) => present.includes(d) && !wanted.includes(d) && !spent.has(d));
    if (!donor) continue;
    spent.add(donor);
    moved.set(donor, axis);
    const items = ((q as any)[donor] as any[]) ?? [];
    (q as any)[axis] = items.map((it) => ({ ...it }));
    (q as any)[donor] = [];
    add("transformed", axis,
      `${items.length} ${label(donor)} became ${items.length} ${label(axis)} — the codes and labels are unchanged`);
  }

  for (const axis of QUESTION_AXES) {
    if (toSpec.axes.includes(axis) || spent.has(axis)) continue;
    const items = ((q as any)[axis] as any[] | undefined) ?? [];
    if (items.length) add("removed", axis, `${items.length} ${label(axis)} — ${toSpec.label} has none`);
    (q as any)[axis] = [];
  }

  /* ------------------------------------------------------------- 2. the masks */

  for (const axis of QUESTION_AXES) {
    const field = AXIS_MASK[axis];
    const mask = (q as any)[field];
    if (!mask) continue;
    const dest = moved.get(axis);
    if (dest) {
      (q as any)[AXIS_MASK[dest]] = mask;
      delete (q as any)[field];
      add("transformed", AXIS_MASK[dest], `${AXIS_FEATURE[axis]} masking now masks the ${label(dest)}`);
    } else if (!toSpec.axes.includes(axis)) {
      delete (q as any)[field];
      add("removed", field, `${AXIS_FEATURE[axis]} masking — there are no ${label(axis)} to mask`);
    } else kept.push(`${AXIS_FEATURE[axis]} masking`);
  }

  /* ------------------------------------------- 3. things scoped to a named axis */

  if (q.randomization) {
    const scope = (q.randomization.scope ?? "options") as QuestionAxis;
    const dest = moved.get(scope);
    if (dest) {
      q.randomization = { ...q.randomization, scope: dest };
      add("transformed", "randomization.scope", `Randomization now shuffles the ${label(dest)}`);
    } else if (!toSpec.axes.includes(scope)) {
      delete (q as any).randomization;
      add("removed", "randomization", `Randomization of the ${label(scope)} — there are none`);
    } else kept.push("Randomization");
  }

  if (q.optionGroups?.length) {
    const before = q.optionGroups.length;
    q.optionGroups = q.optionGroups
      .map((g) => {
        const scope = (g.scope ?? "options") as QuestionAxis;
        const dest = moved.get(scope);
        return dest ? { ...g, scope: dest } : g;
      })
      .filter((g) => toSpec.axes.includes((g.scope ?? "options") as QuestionAxis));
    if (q.optionGroups.length !== before) {
      add("removed", "optionGroups", `${before - q.optionGroups.length} option group(s) over lists this type has not`);
    }
    if (!q.optionGroups.length) delete (q as any).groupOrdering;
  }

  if (q.carryForward) {
    const into = (q.carryForward.into ?? "options") as QuestionAxis;
    const dest = moved.get(into);
    if (dest) {
      q.carryForward = { ...q.carryForward, into: dest };
      add("transformed", "carryForward.into", `Carry-forward now fills the ${label(dest)}`);
    } else if (!toSpec.axes.includes(into)) {
      delete (q as any).carryForward;
      add("removed", "carryForward", `Carry-forward into the ${label(into)} — there are none`);
    } else kept.push("Carry-forward");
  }

  /* ----------------------------- 4. option-list machinery, which needs options */

  const optionsSurvive = toSpec.axes.includes("options");
  if (!optionsSurvive) {
    if (q.listLogic?.length) {
      add("removed", "listLogic", `${q.listLogic.length} list logic rule(s) — they build an option list`);
      q.listLogic = [];
    }
    if (q.optionPipeline?.length) {
      add("removed", "optionPipeline", `${q.optionPipeline.length} list operation(s) — they build an option list`);
      q.optionPipeline = [];
    }
  } else {
    if (q.listLogic?.length) kept.push("List logic");
    if (q.optionPipeline?.length) kept.push("List operations");
  }

  /* A punch writes codes into a code-bearing list. With no list, there is
     nowhere for it to write — and a punch that silently does nothing is the
     kind of dead configuration this pass exists to stop. */
  /*
   * …and "has an axis" is not the same as "has codes". A single-select that
   * becomes a cell grid still HAS an axis (its columns), but its options were
   * emptied a moment ago, so a punch that wrote option codes now writes them
   * nowhere. `PunchRule.ignoreUnmatched` defaults to true, so it does that
   * silently — the derived variable simply stops being written, and the quota
   * or the terminate that reads it starts behaving differently with nothing
   * anywhere to say why.
   */
  const codesLeft = !!(q.options?.length || q.rows?.length);
  if (q.punches?.length && (!toSpec.axes.length || !codesLeft)) {
    add("removed", "punches", `${q.punches.length} auto-punch rule(s) — ${toSpec.label} holds no codes to punch`);
    q.punches = [];
  } else if (q.punches?.length) kept.push("Auto punch");

  /* An attention check is judged against expected CODES. */
  if (q.attentionCheck && !optionsSurvive) {
    delete (q as any).attentionCheck;
    add("removed", "attentionCheck", "Attention check — it is judged against option codes");
  } else if (q.attentionCheck) kept.push("Attention check");

  /* ---------------------------------------------------------- 5. the settings */

  const allowed = settingsOf(toModel);
  const s = (q.settings ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (s[key] === undefined) continue;
    if (!allowed.has(key)) {
      delete s[key];
      add("removed", `settings.${key}`, `${SETTING_LABEL[key] ?? key} — ${toSpec.label} does not use it`);
      continue;
    }
    /*
     * A variant may withhold a capability its response model would otherwise
     * allow — a single-select preset with no "Other, specify", a ranking
     * preset with no top-N. The table decides the shape; the variant decides
     * what it exposes, and a setting no control can reach is dead weight.
     */
    if (hasCaps) {
      if ((key === "minSelections" || key === "maxSelections") && !caps.has("min_max_selections")) {
        delete s[key];
        add("removed", `settings.${key}`, `${SETTING_LABEL[key]} — this type does not offer it`);
        continue;
      }
      if (key === "otherSpecifyOptional" && !caps.has("other_specify")) {
        delete s[key];
        add("removed", `settings.${key}`, "Other-specify — this type does not offer it");
        continue;
      }
    }
  }
  q.settings = s as Question["settings"];

  /* --------------------------------------------------------- 6. option flags */

  if (optionsSurvive && hasCaps && !caps.has("exclusive_options")) {
    /*
     * `exclusive_options` governs the MULTI-SELECT idea — "tick this and
     * nothing else" — and that is `exclusive` and `none_of_above`. "Don't
     * know" and "Refused" are answer codes, not selection rules: every choice
     * question in survey research carries them, including the single-selects
     * and dropdowns that have no exclusivity to configure, and deleting them
     * on a type change would quietly change what the data can say.
     */
    const SPECIAL = ["exclusive"];
    let hit = 0;
    q.options = (q.options ?? []).map((o) => {
      const flags = (o.flags ?? []).filter((f) => !SPECIAL.includes(f));
      if (flags.length !== (o.flags ?? []).length) hit++;
      return { ...o, flags };
    });
    if (hit) add("reset", "options[].flags", `Exclusive / None-of-the-above on ${hit} option(s) — this type does not offer them`);
  }

  /* ---------------------------------------------------------- 7. validation */

  const before = q.validation ?? [];
  if (before.length) {
    /* `target.validations` is resolved rather than taken on trust, so this
       runs on the paths that pass a bare base type too — `staleFields` among
       them, which is the one whose whole job is to find rules like these */
    const kinds = target.validations && judge
      ? allowedValidationKinds(target.validations, target.validations)
      : null;
    const survivors = kinds ? before.filter((r) => kinds.includes(r.kind)) : before;
    if (survivors.length !== before.length) {
      const gone = before.filter((r) => !survivors.includes(r));
      add("reset", "validation",
        `${gone.length} validation rule(s) — ${gone.map((r) => r.kind).join(", ")}`);
    } else if (before.length) kept.push("Validation");
    q.validation = survivors;
  }

  /* --------------------------------- 8. configuration the OLD variant seeded */

  /**
   * A PRESET'S DEFAULTS BELONG TO THE PRESET, NOT TO THE PROGRAMMER.
   *
   * Every variant may carry `defaults` — Email seeds a `name@example.com`
   * placeholder and an `email` rule, Phone seeds `+1 555 123 4567` and a
   * pattern rule with the message "Please enter a valid phone number." They are
   * applied on creation and on conversion, and from that moment they were
   * indistinguishable from something a person had typed.
   *
   * So switching Email → Phone produced a question with the EMAIL placeholder
   * and the PHONE error message, which is the screenshot this pass started
   * from. The email rule was dropped (Phone does not allow `email`), the phone
   * rule was seeded in its place — and `applyVariantDefaults` would not replace
   * `settings.placeholder`, because a value that is already set is treated as
   * the programmer's intent. It was the previous preset's intent.
   *
   * Nothing here can tell those apart in general, but it does not have to: a
   * value that is still EXACTLY what the old variant seeded has not been
   * touched since, and a value that differs has. The first kind is re-derived
   * from the new variant; the second kind is left alone, which is why a
   * hand-written placeholder survives a preset change and a stale one does not.
   */
  if (fromVariant && target.variant && fromVariant.id !== target.variant.id) {
    const od = fromVariant.defaults;
    const nd = target.variant.defaults;

    if (od?.settings) {
      const cur = (q.settings ?? {}) as Record<string, unknown>;
      for (const [k, seeded] of Object.entries(od.settings)) {
        if (!(k in cur) || !sameValue(cur[k], seeded)) continue;
        const next = nd?.settings?.[k];
        if (next === undefined) {
          delete cur[k];
          add("removed", `settings.${k}`,
            `${SETTING_LABEL[k] ?? k} — it came from ${fromVariant.name} and ${target.variant.name} does not set it`);
        } else if (!sameValue(next, seeded)) {
          cur[k] = next;
          add("transformed", `settings.${k}`,
            `${SETTING_LABEL[k] ?? k} is now ${target.variant.name}'s`);
        }
      }
      q.settings = cur as Question["settings"];
    }

    /*
     * The same rule for validation, and it is the other half of the screenshot:
     * Phone's `pattern` rule is a kind Email also allows, so the kind filter
     * above has no reason to drop it — but nobody wrote it, Phone did.
     */
    if (od?.validation?.length && q.validation?.length) {
      const nextRules = nd?.validation ?? [];
      const survivors = q.validation.filter((r) =>
        !od.validation!.some((seeded) => sameValue(r, seeded))
        || nextRules.some((seeded) => sameValue(r, seeded)));
      if (survivors.length !== q.validation.length) {
        const gone = q.validation.length - survivors.length;
        q.validation = survivors as Question["validation"];
        add("removed", "validation",
          `${gone} validation rule(s) that ${fromVariant.name} had set up`);
      }
    }
    /* …and then the new variant's own rules land, so the question is left
       configured as the type it now is rather than merely stripped of the
       type it was */
    if (nd?.validation?.length && !(q.validation ?? []).length) {
      q.validation = nd.validation.map((r) => ({ ...r })) as Question["validation"];
      add("transformed", "validation", `${target.variant.name}'s own validation`);
    }

    for (const field of ["instruction", "text"] as const) {
      const seeded = od?.[field];
      if (seeded === undefined || !sameValue(q[field], seeded)) continue;
      const next = nd?.[field];
      if (next === undefined) {
        (q as Record<string, unknown>)[field] = "";
        add("removed", field, `The ${field} came from ${fromVariant.name}`);
      } else if (next !== seeded) {
        (q as Record<string, unknown>)[field] = next;
        add("transformed", field, `The ${field} is now ${target.variant.name}'s`);
      }
    }
  }

  /* `required` is meaningful for every shape that takes an answer; a
     display-only block cannot be required, and leaving it set is exactly the
     stale flag that makes a page impossible to submit. */
  if (toModel === "none" && q.required) {
    q.required = false;
    add("reset", "required", "Required — a display-only block takes no answer");
  }

  return {
    q,
    from: { type: input.type, variant: input.variant ?? undefined, model: fromModel, label: fromSpec.label },
    to: { type: target.baseType, variant: target.variant?.id, model: toModel, label: toSpec.label },
    safe: fromModel === toModel,
    changes,
    kept: [...new Set(kept)],
  };
}

/**
 * The same decision applied to a question nobody is changing right now:
 * what does this question carry that its CURRENT type cannot read?
 *
 * This is how a definition written before type changes migrated properly is
 * found and reported — the survey lints it, the Studio offers to clean it,
 * and nothing is removed without being shown. A question in good order
 * returns an empty list.
 */
export function staleFields(q: Question): MigrationChange[] {
  const model = effectiveResponseModel(q);
  return migrateQuestionType(q, {
    baseType: q.type,
    id: q.variant ?? undefined,
    responseModel: model,
  }).changes;
}
