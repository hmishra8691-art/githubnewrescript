import { z } from "zod";
import { Condition } from "./conditions.js";
import { ListOperation, OptionLogic } from "./optionLogic.js";
import { OptionMask, PunchRule } from "./setExpression.js";
import { AttentionCheck } from "./quality.js";
import { AiQuestionOverride, SpokenScript } from "./aiConversation.js";

/**
 * Question model.
 *
 * The platform is NOT limited to a fixed set of question types: `type`
 * is an open string resolved against the QuestionTypeRegistry at runtime.
 * The enum below lists the built-in types shipped with the platform.
 */

export const BUILTIN_QUESTION_TYPES = [
  "single_select",
  "multi_select",
  "dropdown",
  "multi_dropdown",
  "numeric",
  "open_text",
  "long_text",
  "numeric_list",
  "text_list",
  "date",
  "time",
  "ranking",
  "slider",
  "nps",
  "matrix_single",
  "matrix_multi",
  "matrix_numeric",
  "matrix_text",
  "matrix_dropdown",
  "image_select",
  "image_ranking",
  "hotspot", // click points on an image — stores coordinates
  "allocation", // constant sum / percentage allocation
  "composite", // custom multi-column question (each column its own response type)
  "custom_table",
  "custom_component", // rendered by a registered plugin renderer
  "hidden", // hidden variable
  "calculated", // calculated variable (expression-driven)
  "embedded_data", // captured from URL / invitation / API
  "html", // display-only content block
  "conjoint_task", // renders tasks from a referenced conjoint design file
  "maxdiff_task", // renders tasks from a referenced maxdiff design file
  // --- added with the 2026-09 variant batch; each owns a response model ---
  "annotation", // marks + strokes on a stimulus image (pins with comments, freehand)
  "media_timeline", // reactions at moments on a video/audio timeline
  "upload", // a file the respondent supplied: {url, name, size, type}, or several
  "repeating_group", // respondent-driven repetition of a field set: array of records
  "experiment", // random arm assignment, stored as a derived value
  /**
   * A place: `{ lat, lng, accuracy?, radiusM?, address? }` (see GeoAnswer).
   * The ONE response model the 2026-09 taxonomy work found genuinely missing.
   * Pin, address search and radius are renderers over this one model
   * (`settings.geoMode`), never three types with three data shapes.
   */
  "geo",
  /**
   * Adaptive CBC: build-your-own → screening (with unacceptable / must-have
   * rules) → choice tournament, built per respondent at interview time from
   * an `acbc` design's configuration (engine acbc.ts). One answer holds the
   * whole transcript.
   */
  "acbc_task",
  /**
   * VIDEO INTERVIEW — a researcher-led qualitative question.
   *
   * The researcher records themselves asking the question; the respondent
   * watches it to the end, answers out loud, and the clip is transcribed.
   * One answer holds all three things (see `InterviewAnswer`): the proof the
   * video was watched, the recording, and the transcript.
   *
   * It is a TYPE rather than a preset of `upload`, and that is a deliberate
   * departure from the taxonomy's usual answer. A "Speech-to-Text Response"
   * was refused as a type precisely because a transcript is a text answer
   * and a second type means a second place for the same data to live. This
   * is a different case: the answer is not a file and is not a string, it is
   * a small record whose parts only mean anything together — a transcript
   * with no clip cannot be re-listened to, a clip with no watch record
   * cannot be trusted as an answer to the question that was asked, and a
   * watch record on its own is telemetry. An `upload` carrying three
   * transcript fields would have been that second place.
   */
  "video_interview",
] as const;
export type BuiltinQuestionType = (typeof BUILTIN_QUESTION_TYPES)[number];

/** Response primitive a column/cell can capture. */
export const ResponseType = z.enum([
  "single",
  "multi",
  "dropdown",
  "multi_dropdown",
  "text",
  "longtext",
  "numeric",
  "date",
  "time",
  "rank",
  "slider",
  "checkbox",
  "none",
]);
export type ResponseType = z.infer<typeof ResponseType>;

/** Field types for form-style list questions (Open Text List / Numeric List).
 *  Each carries built-in input rendering + validation in the engine. */
export const FieldType = z.enum([
  "text",
  "longtext",
  "email",
  "phone",
  "number",
  "decimal",
  "integer",
  "currency",
  "date",
  "time",
  "url",
  "zip",
]);
export type FieldType = z.infer<typeof FieldType>;

export const OptionFlag = z.enum([
  "exclusive", // selecting it clears every other selection
  "other_specify", // shows a text input when selected
  /*
   * RETIRED, AND STILL PARSED. See `RETIRED_OPTION_FLAGS` below: these three
   * were four names for one behaviour, and are folded into `exclusive` on
   * parse. They stay in the enum because every survey definition already in
   * the database may contain them, and a value the parser rejects takes a
   * live survey dark — `SurveyDefinition.safeParse` failing is not a
   * migration, it is an outage.
   */
  "none_of_above",
  "dont_know",
  "refused",
  "anchor_top",
  "anchor_bottom", // excluded from randomization
]);

/**
 * FOUR NAMES FOR ONE BEHAVIOUR.
 *
 * The September 2026 question-type review put it plainly: mark an option
 * "None of the Above", "Don't Know" or "Refused" and it behaves exactly like
 * "Exclusive" — selecting it clears the rest. That was not an oversight in
 * the editor, it was the truth about the engine: `isExclusiveOption` has
 * always treated all four as one thing, and nothing anywhere ever gave them
 * different behaviour.
 *
 * Meanwhile they were read INCONSISTENTLY by everything else. Carry-forward
 * had two different lists of them in two functions, one of which omitted
 * `exclusive` entirely; the AI conversation engine counted only two of the
 * four as "none"; the shape migration kept two and dropped two. Four
 * synonyms, six opinions.
 *
 * So there is one flag now. The three are folded into `exclusive` as a
 * definition is parsed, which means every consumer — renderer, validator,
 * exporter, carry-forward, masking, analytics — sees the same single flag
 * without each having to remember the list. An option that carried two of
 * them does not end up with a duplicate: the fold de-duplicates.
 *
 * What is lost is a label the programmer could see in the editor, and what is
 * gained is that the label can no longer promise behaviour the engine does
 * not have. An option that means "Don't know" says so in its own text, which
 * is what the respondent reads anyway.
 */
export const RETIRED_OPTION_FLAGS = ["none_of_above", "dont_know", "refused"] as const;

/** The three retired flags folded into `exclusive`, order preserved, deduped. */
export function normalizeOptionFlags(flags: readonly string[] | undefined): string[] {
  if (!flags?.length) return [];
  const out: string[] = [];
  for (const f of flags) {
    const mapped = (RETIRED_OPTION_FLAGS as readonly string[]).includes(f) ? "exclusive" : f;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/** `z.array(OptionFlag)` with the retirement applied — used by every flag field. */
const OptionFlags = z
  .array(OptionFlag)
  .default([])
  .transform((fs) => normalizeOptionFlags(fs) as z.infer<typeof OptionFlag>[]);

export const Option = z.object({
  /**
   * Stable internal id (§33). OPTIONAL, and that is not laziness.
   *
   * Every survey definition already in the database was written without one.
   * A required field makes `SurveyDefinition.safeParse` fail on all of them —
   * and the runtime returns null on a parse failure, so a live survey would go
   * dark. Optional means old definitions keep parsing; `ensureElementIds`
   * fills the gaps.
   *
   * The id does NOT replace `code`. Code is the platform's join key: stored
   * answers, export column names, quota cells, List Fill counters and the
   * variable dictionary are all keyed by it, and several of those live outside
   * the definition in tables nothing can rewrite. The id is the thing that
   * survives a code being renumbered — a second name, not a replacement.
   */
  id: z.string().optional(),
  code: z.union([z.string(), z.number()]),
  label: z.string(),
  /** Optional distinct export/analysis value; defaults to code. */
  value: z.union([z.string(), z.number()]).optional(),
  imageUrl: z.string().optional(),
  /**
   * What a screen reader says for this option's image. Defaults to the
   * option's own label, which is right almost always — set it when the
   * picture says something the label does not.
   */
  imageAlt: z.string().optional(),
  flags: OptionFlags,
  /** Show this option only when the condition holds. */
  visibleIf: Condition.optional(),
  /**
   * Option-level logic (req §1–9): always show / always hide, conditional
   * visibility, eligibility, exclusion, prioritisation, randomisation
   * participation and carry forward / back. Absent = "Always Show", which is
   * exactly how every pre-existing option already behaves (req §33).
   */
  logic: OptionLogic.optional(),
  /** Free metadata for custom renderers. */
  meta: z.record(z.any()).optional(),
  /** What the voice says for this option when it differs from the label ("iPhone 15 Pro Max" for "Apple iPhone 15 Pro Max"). The label and code never change. */
  spoken: z.string().optional(),
  /**
   * Carry-forward provenance (P0 dynamic-option fix). When this option was
   * materialized from another question's answer (see `Question.carryForward`),
   * these identify the source unambiguously — by id and code, never by the
   * display label alone, since labels can repeat or be edited independently
   * of identity. Absent for ordinary, non-carried options.
   */
  sourceQuestionId: z.string().optional(),
  sourceCode: z.union([z.string(), z.number()]).optional(),
});
export type Option = z.infer<typeof Option>;

export const ValidationRule = z.object({
  /**
   * Stable internal id (§42). Validation rules were addressed by array index
   * everywhere — `validation.map((x, j) => j === i ? … : x)` — so reordering
   * them silently repointed anything that referred to one, and nothing could
   * refer to one at all.
   */
  id: z.string().optional(),
  kind: z.enum([
    "required",
    "min_value",
    "max_value",
    "min_length",
    "max_length",
    "min_selections",
    "max_selections",
    "sum_equals", // allocation / constant sum
    "sum_max",
    "sum_min",
    "pattern", // regex
    "email",
    "phone",
    "date_min", // value is an ISO date (or a variable name resolving to one)
    "date_max",
    /**
     * Grid totals down a COLUMN, across every visible row — the counterpart of
     * `settings.rowSum`, which totals across a row. `ref` names the column;
     * omitted, every column is held to the same total.
     */
    "column_sum_equals",
    "column_sum_max",
    "column_sum_min",
    "integer",
    "custom_expression", // calc-engine expression that must evaluate truthy
    "custom_script", // id or name of a script in def.scripts; it calls ctx.error()
    /**
     * The Universal Logic Engine's Condition tree, evaluated as the check
     * itself rather than a gate — see `check` below. This is what gives
     * Validation the same visual/expression builder (nested AND/OR/NOT,
     * COUNT, cross-question, matrix-cell, loop sources) already shared by
     * Display Logic, Skip Logic, and Auto Punch, instead of a second,
     * validation-only condition language.
     */
    "condition",
  ]),
  value: z.any().optional(),
  message: z.string().optional(),
  /** Which column a `column_sum_*` rule totals. */
  ref: z.string().optional(),
  /**
   * Whether failing this rule stops the respondent.
   *
   * "error" (the default, and how every rule behaved before this existed)
   * blocks the page. "warning" shows the message and lets them continue — the
   * soft check a researcher wants for "that is unusually high, are you sure?"
   * without making a legitimate answer impossible to give.
   */
  severity: z.enum(["error", "warning"]).optional(),
  /** Only enforce when the condition holds. */
  when: Condition.optional(),
  /**
   * The check itself, for `kind: "condition"` — the condition evaluating
   * TRUE is what makes the rule FAIL (reads as "IF Q5 <= Q6 THEN invalid").
   * Kept as its own field rather than overloading `when`: `when` stays a
   * pure enable/gate on every kind including this one, so a rule can say
   * "only run this cross-question check once Q3 is answered" (when)
   * independently of "fail when Q5 > Q6" (check) — one field can't carry
   * both meanings without changing what `when` means for every other kind.
   */
  check: Condition.optional(),
});
export type ValidationRule = z.infer<typeof ValidationRule>;

/* ====================================================== option groups (§13–30)
 *
 * THE DECISION THAT MAKES THIS SAFE: A GROUP IS A LAYER OVER THE FLAT LIST,
 * NOT A RESTRUCTURING OF IT.
 *
 * `options`, `rows` and `columns` stay exactly what they were — flat arrays,
 * addressed by `code` (options and rows) and `id` (columns). Around sixty call
 * sites across nine packages depend on that: the four exporters, the analytics
 * dataset builder, piping, List Fill, quota cells, validation, auto punch, the
 * variable dictionary, the renderer. Nesting options inside groups would have
 * meant editing every one of them, and any one missed would be a silent
 * wrong-number rather than a crash.
 *
 * So a group holds MEMBER CODES and nothing else owns the options. Every
 * existing consumer keeps reading a flat list and never learns groups exist;
 * only the ORDERING stage — one function in the engine — reads them.
 *
 * This also replaces `Randomization.groups`, which was the same idea done
 * anonymously: a flat array of code-arrays with no id, no name, no order, no
 * logic, and no UI, whose randomization seed was its ARRAY INDEX — so
 * reordering the groups silently re-shuffled respondents already in field.
 * The old field still works and is still honoured; groups take precedence
 * when both are present.
 */

/**
 * How a list is ordered. One vocabulary for groups and for the items inside
 * them, because "alphabetical" means the same thing at both levels — the
 * difference is only the scope it is applied to (§23: sorting within a group
 * must not flatten every option across groups).
 */
export const OptionOrder = z.enum([
  "fixed",         // as declared
  "random",        // seeded shuffle, stable per respondent
  "rotate",        // start position advances per respondent (§21)
  "flip",          // always reversed (§22)
  "flip_random",   // reversed for half of respondents — the old reverse_half
  "alpha_asc",     // A → Z by label
  "alpha_desc",    // Z → A
  "numeric_asc",   // by numeric code
  "numeric_desc",
  "custom",        // by each item's own `order` / declaration order
  "priority",      // by `priority`, highest first
]);
export type OptionOrder = z.infer<typeof OptionOrder>;

export const OptionGroup = z.object({
  /** Stable id (§37). Also the randomization seed key, so reordering groups
   *  no longer re-shuffles respondents who are already in field. */
  id: z.string(),
  name: z.string(),
  /** Which collection this group organises. */
  scope: z.enum(["options", "rows", "columns"]).default("options"),
  /**
   * The members, by option/row `code` or column `id`, in the group's own
   * order. A code appearing in two groups belongs to the first — membership
   * is exclusive, because an option shown twice is a broken question.
   */
  members: z.array(z.union([z.string(), z.number()])).default([]),
  /** Explicit position for `custom` group order. */
  order: z.number().optional(),
  /** Weight for `priority` group order. */
  priority: z.number().optional(),
  /**
   * Group-level display logic (§27). When this fails, every member is hidden —
   * except a member flagged Always Show, which survives, exactly as it
   * survives a mask. See the precedence note in the engine.
   */
  visibleIf: Condition.optional(),
  /**
   * How the items INSIDE this group are ordered. Independent of how the groups
   * themselves are ordered (§18), and overrides the question-level default
   * when set — so one group can be alphabetical while the rest are random.
   */
  itemOrder: OptionOrder.optional(),
  /** Editor state only; the runtime ignores it. */
  collapsed: z.boolean().optional(),
});
export type OptionGroup = z.infer<typeof OptionGroup>;

/**
 * The two independent switches (§18, §30).
 *
 * Independent on purpose: all four combinations are things survey programmers
 * ask for. Fixed groups with random items is the common one — a questionnaire
 * whose sections must stay in order while the items inside them rotate.
 */
export const GroupOrdering = z.object({
  /** How the groups are ordered relative to each other. */
  groupOrder: OptionOrder.default("fixed"),
  /** Default for items within each group; a group may override it. */
  itemOrder: OptionOrder.default("fixed"),
  /**
   * Where items belonging to no group go. They are kept together rather than
   * scattered, because an option that drifts between groups run to run is
   * indistinguishable from a bug.
   */
  ungrouped: z.enum(["last", "first"]).default("last"),
});
export type GroupOrdering = z.infer<typeof GroupOrdering>;

export const Randomization = z.object({
  enabled: z.boolean().default(false),
  scope: z.enum(["options", "rows", "columns"]).default("options"),
  method: z.enum(["shuffle", "rotate", "reverse_half", "none"]).default("shuffle"),
  /** Randomize only within these code groups (blocks stay in place). */
  groups: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
  /** Present only N of the (non-anchored) items — "randomize N from a list". */
  pick: z.number().optional(),
  /**
   * Conditional randomization (req: randomize based on previous answers).
   * The FIRST rule whose condition holds overrides method/pick/groups for
   * this respondent; with no match the base settings above apply.
   */
  rules: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        when: Condition,
        method: z.enum(["shuffle", "rotate", "reverse_half", "none"]).optional(),
        pick: z.number().optional(),
        groups: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
      }),
    )
    .optional(),
});
export type Randomization = z.infer<typeof Randomization>;

/**
 * Previous-question list logic (include / exclude / prioritize / deprioritize /
 * remaining). Rules apply in order to this question's option list, after
 * carry-forward and before sorting/randomization. "displayed" = the options
 * the source question actually showed this respondent, so
 * exclude+displayed = "remaining / not yet seen".
 */
export const ListLogicRule = z.object({
  id: z.string(),
  sourceQuestionId: z.string(),
  action: z.enum(["include", "exclude", "prioritize", "deprioritize"]),
  which: z.enum(["selected", "not_selected", "displayed"]).default("selected"),
  /** Only apply the rule when this condition holds. */
  when: Condition.optional(),
});
export type ListLogicRule = z.infer<typeof ListLogicRule>;

/** Carry-forward / dynamic option pass-through (requirement §4). */
export const CarryForward = z.object({
  sourceQuestionId: z.string(),
  /** Which options travel forward. */
  filter: z
    .enum(["selected", "not_selected", "displayed", "answered_rows", "all"])
    .default("selected"),
  /** Where the carried options land in this question. */
  into: z.enum(["options", "rows", "columns"]).default("options"),
  /** Optionally keep additional statically-defined options too. */
  keepOwn: z.boolean().default(false),
  /** Optional extra filter condition evaluated per option code. */
  where: Condition.optional(),
});
export type CarryForward = z.infer<typeof CarryForward>;

/**
 * Column of a composite / matrix / custom-table question.
 * EVERY column carries its own response type, its own variable name,
 * its own options + codes, its own validation and its own visibility —
 * requirement §3.
 */
export const QuestionColumn = z.object({
  id: z.string(),
  label: z.string(),
  responseType: ResponseType,
  /** Variable naming: `${variableStem}_${rowCode}` (see docs/VARIABLES.md). */
  variableStem: z.string(),
  options: z.array(Option).default([]),
  validation: z.array(ValidationRule).default([]),
  visibleIf: Condition.optional(),
  readOnly: z.boolean().default(false),
  defaultValue: z.any().optional(),
  /** Expression evaluated by the calc engine (makes the cell calculated). */
  expression: z.string().optional(),
  width: z.string().optional(),
  placeholder: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  carryForward: CarryForward.optional(),
  meta: z.record(z.any()).optional(),
  /**
   * Columns share the option-level logic model — same engine, same editor
   * as `Option.logic`/`QuestionRow.logic` (always-show/always-hide,
   * show-when/hide-when). Absent = "Always Show", exactly how every
   * pre-existing column already behaves.
   */
  logic: OptionLogic.optional(),
  /** Mirrors `Option.flags`/`QuestionRow.flags` (e.g. a "Not applicable" column). */
  flags: OptionFlags,
});
export type QuestionColumn = z.infer<typeof QuestionColumn>;

export const QuestionRow = z.object({
  /** Stable internal id (§34). Optional for the same reason as `Option.id`. */
  id: z.string().optional(),
  code: z.union([z.string(), z.number()]),
  label: z.string(),
  visibleIf: Condition.optional(),
  /** Rows share the option-level logic model (same engine, same editor). */
  logic: OptionLogic.optional(),
  flags: OptionFlags,
  /** Form-style list questions: the input type of this row's field. */
  fieldType: FieldType.optional(),
  /** Field-level validation for this row (req §5). */
  validation: z.array(ValidationRule).default([]),
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  meta: z.record(z.any()).optional(),
  /**
   * Carry-forward provenance (P0 dynamic-option fix). When this row was
   * materialized from another question's answer (see `Question.carryForward`),
   * these identify the source unambiguously — by id and code, never by the
   * display label alone. Absent for ordinary, non-carried rows.
   */
  sourceQuestionId: z.string().optional(),
  sourceCode: z.union([z.string(), z.number()]).optional(),
});
export type QuestionRow = z.infer<typeof QuestionRow>;

export const SkipTarget = z.object({
  kind: z.enum(["question", "page", "block", "section", "end", "terminate", "url"]),
  ref: z.string().optional(), // id of target, or URL
  status: z.enum(["complete", "screened", "quota_full", "terminated"]).optional(),
});

export const SkipRule = z.object({
  id: z.string(),
  when: Condition,
  target: SkipTarget,
  label: z.string().optional(),
});
export type SkipRule = z.infer<typeof SkipRule>;

/**
 * FOLLOW-UP PROBE — a dynamic "tell me more" on an open end.
 *
 * ## What it is
 *
 * Configuration on the question being probed, not a question type and not a
 * flow node. When the page holding the question is submitted and its answers
 * are valid, the runtime asks a follow-up — one open-ended question, shown on
 * its own — up to `maxProbes` times, then continues to wherever the flow was
 * already going. The programmed flow is never altered: no page is inserted,
 * no branch is taken, the step index does not move. A probe is an overlay
 * the runtime shows between a page and the next, the way an interstitial
 * warning is.
 *
 * ## Where the wording comes from
 *
 * `prompt` set → a fixed wording, with `{answer}` and ordinary piping
 * available ("You said {answer} — what made you feel that way?"). Works with
 * no AI provider at all; this is the classic conditional follow-up every
 * platform has, under the same mechanism.
 *
 * `prompt` unset → the AI provider writes the follow-up from the answer so
 * far, guided by `instruction` ("find out which feature they mean"). If no
 * provider is configured the probe is skipped and the interview continues
 * — a missing follow-up, never a broken survey.
 *
 * ## What is gated, and by what
 *
 * `when` is an ordinary Condition over the whole response — the same tree
 * display logic, skip logic and quotas use — evaluated after the page is
 * valid; `stopWhen` is evaluated after each probe answer. Nothing here can
 * express anything logic elsewhere cannot, and a probe never reads state
 * that does not exist yet.
 *
 * ## Where the answers land
 *
 * Under the probed question's own variable: `Q5_PROBE_1`, `Q5_PROBE_2`, …
 * hold the answers, `Q5_PROBE_1_Q`, … the exact wording that was asked —
 * necessary when the wording was generated, since the analyst must see the
 * question each respondent actually answered. Declared in the dictionary up
 * front from `maxProbes`, so the export has the same columns before the
 * first respondent and after the last, exactly as loop iterations do.
 */
export const ProbeConfig = z.object({
  /** Ask only when this holds (evaluated after the page is valid). Absent = whenever the question was answered. */
  when: Condition.optional(),
  /** Stop probing once this holds (evaluated after every probe answer). */
  stopWhen: Condition.optional(),
  /** Most follow-ups to ask for this question. */
  maxProbes: z.number().int().min(1).max(5).default(1),
  /** Do not probe an answer shorter than this many words (0 = always). */
  minWords: z.number().int().min(0).default(0),
  /** Fixed wording; `{answer}` pipes the answer. Blank = the AI writes it. */
  prompt: z.string().optional(),
  /** Guidance for the AI when it writes the follow-up. */
  instruction: z.string().optional(),
  /** Must the respondent answer the follow-up? Default no — a probe invites, it does not demand. */
  required: z.boolean().default(false),
});
export type ProbeConfig = z.infer<typeof ProbeConfig>;

/**
 * THE GEO RESPONSE MODEL — what a `geo` question stores.
 *
 * WGS-84 coordinates, an optional accuracy (metres, from device geolocation),
 * an optional radius (metres, `geoMode: "radius"`), and an optional address
 * (from geocoding or typed). Exported as VAR_LAT / VAR_LNG / VAR_ACCURACY_M /
 * VAR_RADIUS_M / VAR_ADDRESS / VAR_CITY / VAR_REGION / VAR_COUNTRY /
 * VAR_POSTAL (engine variables.ts). Distance between two answers is the calc
 * function `distance_km(Q1, Q2)`, not a question type.
 */
export const GeoAddress = z.object({
  formatted: z.string().default(""),
  line1: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  postal: z.string().optional(),
});
export type GeoAddress = z.infer<typeof GeoAddress>;

export const GeoAnswer = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  /** device geolocation accuracy, metres */
  accuracy: z.number().min(0).optional(),
  /** `geoMode: "radius"` — the selected radius, metres */
  radiusM: z.number().min(0).optional(),
  address: GeoAddress.optional(),
  /** how the answer was produced — informational, exported as VAR_SOURCE */
  source: z.enum(["pin", "device", "search", "typed"]).optional(),
});
export type GeoAnswer = z.infer<typeof GeoAnswer>;

/**
 * THE INTERVIEW RESPONSE MODEL — what a `video_interview` question stores.
 *
 * Three things that only mean anything together:
 *
 *   1. `watch` — proof the researcher's video was actually watched. Not a
 *      flag set when Play was pressed: `watchedSeconds` is summed from
 *      playback, so a jump to the end does not count (the same accounting
 *      the watch-time variant uses, for the same reason).
 *   2. `audio` — the respondent's recorded answer, stored like any upload.
 *   3. `transcript` — what they said, and where the text came from.
 *
 * Kept as ONE value rather than three questions because the parts do not
 * survive separation: a transcript with no clip cannot be re-listened to, a
 * clip with no watch record cannot be trusted as an answer to the question
 * that was asked, and a watch record alone is telemetry. Exported as
 * VAR_TRANSCRIPT / VAR_AUDIO_URL / VAR_DURATION_S / VAR_WATCHED_S /
 * VAR_WATCHED_PCT / VAR_VIDEO_COMPLETED / VAR_RETAKES / VAR_TRANSCRIPT_SOURCE
 * (engine variables.ts).
 *
 * Every field is optional because the answer is built up across a page turn
 * and must survive a refresh at any point in that sequence. `interview.ts`
 * in the engine is the one place that decides what a partially-filled record
 * means.
 */
export const InterviewWatch = z.object({
  /** the video was played at least once */
  started: z.boolean().optional(),
  /** seconds SUMMED FROM PLAYBACK — scrubbing forward adds nothing */
  watchedSeconds: z.number().min(0).optional(),
  /** the clip's length, as the browser reported it */
  durationSeconds: z.number().min(0).optional(),
  /** watched ÷ duration, 0–100, capped */
  percent: z.number().min(0).max(100).optional(),
  /** reached the end honestly; the gate that opens the answer area */
  completed: z.boolean().optional(),
  /** how many times they chose to watch it again */
  replays: z.number().int().min(0).optional(),
  /**
   * Forward jumps the player refused or discounted. Zero on an ordinary
   * interview; non-zero is worth a researcher's attention, which is why it
   * is kept rather than silently swallowed.
   */
  seeks: z.number().int().min(0).optional(),
});
export type InterviewWatch = z.infer<typeof InterviewWatch>;

export const InterviewAudio = z.object({
  /** signed URL, as the upload route returns */
  url: z.string().optional(),
  /** storage path, so the object can be found again without the URL */
  path: z.string().optional(),
  mimeType: z.string().optional(),
  bytes: z.number().min(0).optional(),
  durationSeconds: z.number().min(0).optional(),
  recordedAt: z.string().optional(),
  /** how many times they re-recorded before settling on this one */
  retakes: z.number().int().min(0).optional(),
  /**
   * The `media_objects` row for this clip.
   *
   * The url and path above are what the runtime plays; this is what makes the
   * object findable from SQL — so an erasure request can delete it, and a
   * transcript that failed can be re-driven from the stored audio rather than
   * from a recording the respondent no longer has.
   */
  mediaId: z.string().optional(),
});
export type InterviewAudio = z.infer<typeof InterviewAudio>;

export const InterviewTranscript = z.object({
  text: z.string().optional(),
  /** BCP-47, as configured or as the provider reported it */
  language: z.string().optional(),
  /**
   * `provider` — transcribed server-side. `browser` — the respondent's own
   * recogniser. `manual` — typed or corrected by a person. `none` — the clip
   * was kept but nothing transcribed it, which is a normal outcome when no
   * provider is configured and must never block the interview.
   */
  source: z.enum(["provider", "browser", "manual", "none"]).optional(),
  model: z.string().optional(),
  transcribedAt: z.string().optional(),
  /** the provider could not be reached or refused; the clip is still stored */
  failed: z.boolean().optional(),
  /**
   * Where the transcription has got to, mirroring `media_transcripts.status`.
   *
   * `failed` above could only ever say that something went wrong, never that
   * something is still going right — so a clip mid-transcription and a clip
   * nothing would ever transcribe looked identical in the stored answer, and
   * a refresh lost the difference. These five words are the ones the
   * interface shows.
   */
  status: z.enum(["waiting", "processing", "transcribing", "completed", "failed"]).optional(),
  /** why it failed, in a sentence the person reading it can act on */
  error: z.string().optional(),
});
export type InterviewTranscript = z.infer<typeof InterviewTranscript>;

export const InterviewAnswer = z.object({
  watch: InterviewWatch.optional(),
  audio: InterviewAudio.optional(),
  transcript: InterviewTranscript.optional(),
});
export type InterviewAnswer = z.infer<typeof InterviewAnswer>;

/**
 * The researcher's recorded question — the stimulus, not the answer.
 *
 * Lives on `settings.interviewVideo` rather than in `settings.mediaUrl`
 * because a qualitative interview needs the metadata the brief asks for
 * (duration, size, format, when it was recorded, whether it is ready) and a
 * bare URL string carries none of it. `mediaUrl` stays what it is: a
 * stimulus shown above any question.
 */
export const InterviewVideo = z.object({
  url: z.string(),
  /** storage path when we hold the object; absent for an external URL */
  path: z.string().optional(),
  mimeType: z.string().optional(),
  bytes: z.number().min(0).optional(),
  durationSeconds: z.number().min(0).optional(),
  width: z.number().min(0).optional(),
  height: z.number().min(0).optional(),
  recordedAt: z.string().optional(),
  source: z.enum(["recorded", "uploaded", "url"]).default("uploaded"),
  /**
   * `ready` — playable. `processing` — uploaded, not yet confirmed.
   * `failed` — the upload did not complete; the question is not fieldable
   * and the Studio says so rather than letting it reach a respondent.
   */
  status: z.enum(["ready", "processing", "failed"]).default("ready"),
  fileName: z.string().optional(),
  /** the `media_objects` row for the video itself */
  mediaId: z.string().optional(),
  /**
   * The audio-only companion recorded alongside the video.
   *
   * A five-minute 720p take is ~49 MB and speech-to-text services accept 25.
   * Rather than extract audio server-side — which would mean ffmpeg in a
   * serverless function, for a track the browser already has — the recorder
   * captures the microphone twice: once into the video, once on its own at
   * 64 kbps. Five minutes of that is 2.4 MB, and it is what gets transcribed.
   */
  audioMediaId: z.string().optional(),
  /** mirrors `media_transcripts.status` for the question's own recording */
  transcriptStatus: z.enum(["waiting", "processing", "transcribing", "completed", "failed"]).optional(),
  /** the completed transcript, cached here so reading it needs no round trip */
  transcript: z.string().optional(),
  transcriptError: z.string().optional(),
});
export type InterviewVideo = z.infer<typeof InterviewVideo>;

export const Question = z.object({
  id: z.string(), // stable internal id, e.g. "q_age"
  code: z.string(), // display code, e.g. "Q1"
  /** Base variable name; expanded per option/row/column by the dictionary. */
  variableName: z.string(),
  type: z.string(), // open — resolved via QuestionTypeRegistry
  /** Presentation variant id from the variant registry (e.g.
   *  "single_select.buttons"). Absent on legacy questions — every part of
   *  the platform falls back to base-type behaviour, so old surveys are
   *  untouched. The response model is owned by `type`, never by `variant`. */
  variant: z.string().optional(),
  text: z.string().default(""), // supports piping tokens + HTML
  instruction: z.string().optional(),
  description: z.string().optional(),

  options: z.array(Option).default([]),
  rows: z.array(QuestionRow).default([]),
  columns: z.array(QuestionColumn).default([]),

  validation: z.array(ValidationRule).default([]),
  required: z.boolean().default(false),

  settings: z
    .object({
      minSelections: z.number().optional(),
      maxSelections: z.number().optional(),
      /**
       * Choosing an "Other (specify)" option is not an answer until the
       * respondent says what it is; the text is required unless this is set.
       * Off by default because a blank "Other" is unusable data.
       */
      otherSpecifyOptional: z.boolean().optional(),
      minValue: z.number().optional(),
      maxValue: z.number().optional(),
      step: z.number().optional(),
      sumTarget: z.number().optional(), // allocation
      sumUnit: z.string().optional(), // "%", "points", "$"
      listCount: z.number().optional(), // numeric_list / text_list rows
      /** Stimulus image for hotspot / image-based questions. */
      imageUrl: z.string().optional(),
      /** Display options/fields in N columns (1–4). */
      columnsLayout: z.number().optional(),
      /**
       * Ranking behaviour. "click" = rank as many as you like, "all" = every
       * item must be ranked, "top_n" = stop at `maxSelections`. Read by the
       * renderer AND the validator, so the three ranking variants actually
       * differ rather than sharing one tap-to-rank behaviour.
       */
      rankMode: z.enum(["click", "all", "top_n"]).optional(),
      /** Presentation sort, applied before randomization; the programmed
       *  order in `options` is never modified. */
      optionOrder: z
        .enum(["original", "az", "za", "numeric_asc", "numeric_desc"])
        .optional(),
      /**
       * WHETHER THE RESPONDENT GETS A SEARCH BOX OVER THE OPTION LIST.
       *
       * It used to appear by itself the moment a list passed twenty-five
       * options — a hard-coded literal at three call sites that no setting
       * could reach. A question with twenty-four options looked one way and
       * the same question with twenty-six looked another, and the programmer
       * was never asked. The review called that out as a feature arriving
       * uninvited, which is what it was.
       *
       * "auto" is that old behaviour and stays the default, so nothing in
       * field changes; "always" and "never" are the author saying so.
       */
      optionSearch: z.enum(["auto", "always", "never"]).optional(),
      placeholder: z.string().optional(),
      /**
       * Speech input on a text question (`speech_input` capability). The
       * respondent may dictate; the transcript lands in the ordinary text
       * value, so nothing downstream knows or cares that it was spoken.
       * `speechLang` is a BCP-47 tag for the recogniser; unset, the survey's
       * language is used, then the browser's.
       */
      speechInput: z.boolean().optional(),
      speechLang: z.string().optional(),
      /**
       * `geo` questions. `geoMode` picks the renderer over the one response model:
       * "pin" (drop a pin), "address" (search / type an address, geocoded when a
       * provider is configured), "radius" (a pin with a radius). `mapCenter` /
       * `mapZoom` frame the initial map; `allowGeolocation` offers "use my
       * location"; `radiusMinM` / `radiusMaxM` / `radiusDefaultM` bound the radius.
       * `mapTiles` is a slippy-map URL template ({z}/{x}/{y}); blank = the runtime's
       * default (OpenStreetMap — see its tile usage policy before fielding at scale).
       */
      geoMode: z.enum(["pin", "address", "radius"]).optional(),
      mapCenter: z.object({ lat: z.number(), lng: z.number() }).optional(),
      mapZoom: z.number().int().min(1).max(19).optional(),
      allowGeolocation: z.boolean().optional(),
      radiusMinM: z.number().min(0).optional(),
      radiusMaxM: z.number().min(0).optional(),
      radiusDefaultM: z.number().min(0).optional(),
      mapTiles: z.string().optional(),

      /* ---- video_interview. See InterviewAnswer for what is stored. */
      /** The researcher's recorded question. Without it the question cannot field. */
      interviewVideo: InterviewVideo.optional(),
      /**
       * Must the video be watched to the end before the answer area opens?
       * On by default for qualitative work — it is the whole point of the
       * type. Off turns the question into an ordinary prompted voice answer.
       */
      requireWatch: z.boolean().optional(),
      /**
       * May the respondent drag the progress bar? Off by default, and "off"
       * means the handle is not drawn at all rather than drawn and fought
       * with — a control that visibly refuses reads as broken.
       */
      allowSeek: z.boolean().optional(),
      /** May they watch it again once it has finished? */
      allowReplay: z.boolean().optional(),
      /** Show elapsed / remaining while it plays. */
      showProgress: z.boolean().optional(),
      /**
       * Try to start playing on arrival. Browsers refuse unmuted autoplay
       * without a gesture, so this is a preference, never a guarantee: the
       * player falls back to a Play button and the gate is unaffected.
       */
      autoPlayVideo: z.boolean().optional(),

      /** Must they record an answer, or may they move on having only watched? */
      requireAudioAnswer: z.boolean().optional(),
      minAnswerSeconds: z.number().min(0).optional(),
      maxAnswerSeconds: z.number().min(0).optional(),
      /** May recording be paused and resumed, or is it one take? */
      allowAnswerPause: z.boolean().optional(),
      /** How many times they may discard and start again. 0 = one take only. */
      maxRetakes: z.number().int().min(0).optional(),
      /** Offer playback of their own answer before they move on. */
      reviewBeforeSubmit: z.boolean().optional(),

      /** Send the clip for transcription. Off keeps the audio and nothing else. */
      transcribeAnswer: z.boolean().optional(),
      /** BCP-47 hint for the recogniser. Blank = the survey's language. */
      transcriptLanguage: z.string().optional(),
      /**
       * Who sees the transcript. `hidden` — nobody but the researcher;
       * `respondent` — shown back so they can check they were understood;
       * `editable` — shown and correctable, which sets `source: "manual"`.
       */
      transcriptVisibility: z.enum(["hidden", "respondent", "editable"]).optional(),
      /** Keep the recording itself. Off stores only the transcript. */
      saveAnswerAudio: z.boolean().optional(),
      /** Keep the transcript. Off transcribes for nothing, so it also turns transcription off. */
      saveTranscript: z.boolean().optional(),
      readOnly: z.boolean().default(false),
      hidden: z.boolean().default(false),
      defaultValue: z.any().optional(),
      /** Expression for `calculated` questions / piped defaults. */
      expression: z.string().optional(),
      npsLeftLabel: z.string().optional(),
      npsRightLabel: z.string().optional(),
      sliderLeftLabel: z.string().optional(),
      sliderRightLabel: z.string().optional(),
      designRef: z.string().optional(), // conjoint/maxdiff design file id

      /* ---- 2026-09 variant batch. Every field optional; absent = old behaviour. */
      /** Video / audio stimulus URL (video rating, timeline, watch-time). */
      mediaUrl: z.string().optional(),
      /** Respondent must reach the end of the media before answering. */
      requireComplete: z.boolean().optional(),
      /** Timeline reactions: the option set is offered at each tap. */
      timelineMode: z.enum(["tap", "options"]).optional(),
      /** Upload: accepted MIME/extension list, size cap and file count. */
      accept: z.string().optional(),
      maxSizeMb: z.number().optional(),
      maxFiles: z.number().optional(),
      /** Repeating group / dynamic list bounds. */
      minRepeats: z.number().optional(),
      maxRepeats: z.number().optional(),
      /** Annotation / draw-on-image tools offered. */
      tools: z.array(z.enum(["pin", "pen", "highlight"])).optional(),
      /** Pen colour and width for drawing variants. */
      penColor: z.string().optional(),
      penWidth: z.number().optional(),
      /** Timed question: seconds allowed; what happens when they run out. */
      timeLimitSeconds: z.number().optional(),
      onTimeout: z.enum(["lock", "advance"]).optional(),
      /** Attention check: the codes that count as passing, and the consequence. */
      expectedCodes: z.array(z.union([z.string(), z.number()])).optional(),
      onFail: z.enum(["flag", "terminate"]).optional(),
      /** Quiz: show right/wrong after answering; points per correct option. */
      showFeedback: z.boolean().optional(),
      pointsPerCorrect: z.number().optional(),
      /** Chip allocation: value of one chip (sumTarget / chipValue chips). */
      chipValue: z.number().optional(),
      /** Slider stack vs grid for multi-slider matrices. */
      sliderLayout: z.enum(["stack", "grid"]).optional(),
      /** Slider orientation. */
      orientation: z.enum(["horizontal", "vertical"]).optional(),
      /** Calendar: selectable window and the slots offered per day. */
      minDate: z.string().optional(),
      maxDate: z.string().optional(),
      timeSlots: z.array(z.string()).optional(),
      disabledWeekdays: z.array(z.number()).optional(),
      /** Month/year picker window. */
      minYear: z.number().optional(),
      maxYear: z.number().optional(),
      /** Experiment arms; weights default equal. */
      arms: z
        .array(z.object({
          code: z.union([z.string(), z.number()]),
          label: z.string(),
          weight: z.number().optional(),
          html: z.string().optional(),
          mediaUrl: z.string().optional(),
        }))
        .optional(),
      /**
       * Adaptive question: the first alternative whose condition holds
       * replaces text / instruction / options. None matching = the question
       * as authored, so an adaptive question with no alternatives is ordinary.
       */
      adaptive: z
        .array(z.object({
          label: z.string().optional(),
          when: Condition,
          text: z.string().optional(),
          instruction: z.string().optional(),
          options: z.array(Option).optional(),
          minValue: z.number().optional(),
          maxValue: z.number().optional(),
        }))
        .optional(),
      /** Swipe: which option each direction commits. */
      swipeDirections: z
        .object({
          left: z.union([z.string(), z.number()]).optional(),
          right: z.union([z.string(), z.number()]).optional(),
          up: z.union([z.string(), z.number()]).optional(),
          down: z.union([z.string(), z.number()]).optional(),
        })
        .optional(),
      /** Chat presentation: delay between bubbles in ms. */
      chatDelayMs: z.number().optional(),
      /** Tournament ranking: stop after the top N are settled. */
      tournamentTopN: z.number().optional(),
      /** Region selection: allow several regions. */
      multiRegion: z.boolean().optional(),
      /** Range pair (numeric range / dual slider): enforce from <= to. */
      rangePair: z.boolean().optional(),
      /**
       * Constant-sum grid: each ROW of a cell question must total
       * `sumTarget` across its columns (Constant-Sum Matrix). Set on the
       * question, not inferred from the variant id, so any composite /
       * custom_table can opt in.
       */
      rowSum: z.boolean().optional(),
      /**
       * What assistive technology is told about this question.
       *
       * `altText` describes the stimulus — the image or video under the
       * question text. Without it a stimulus is announced as nothing at all:
       * `SafeImage` defaults to `alt=""`, which is correct for decoration and
       * wrong for the thing the question is about. It is authored per
       * question because only the programmer knows whether the picture
       * carries the meaning or merely decorates it.
       */
      accessibility: z
        .object({
          ariaLabel: z.string().optional(),
          describedBy: z.string().optional(),
          altText: z.string().optional(),
          /** the stimulus is decorative — announce nothing, deliberately */
          decorative: z.boolean().optional(),
        })
        .optional(),
    })
    .default({}),

  randomization: Randomization.optional(),
  /**
   * Hierarchical groups over the flat option / row / column lists (§13–30).
   *
   * Empty by default, so every existing question is unchanged and every
   * existing consumer of `options` keeps working — see the note above
   * `OptionGroup`.
   */
  optionGroups: z.array(OptionGroup).default([]),
  /** How groups, and items within groups, are ordered (§18). */
  groupOrdering: GroupOrdering.optional(),
  carryForward: CarryForward.optional(),
  /** Previous-question list operations, applied in order (req §12–13). */
  listLogic: z.array(ListLogicRule).default([]),
  /**
   * Reusable list-processing pipeline (intersection / union / difference /
   * remaining / dedupe / filter / sort / randomize), applied in order after
   * `listLogic`. Empty on every existing question, so the pipeline is a no-op
   * until a programmer configures it.
   */
  optionPipeline: z.array(ListOperation).default([]),
  /**
   * Visual masking: a NESTED set expression over other questions' answers,
   * plus what to do with the result (reqs §1–§13).
   *
   * The pipeline above is a sequence, so it cannot express
   * `A UNION (B INTERSECTION C)` — every step applies to what the last step
   * produced. A mask is a tree, so brackets have somewhere to live. It runs
   * BEFORE the pipeline, and both are absent on every existing question.
   */
  mask: OptionMask.optional(),
  /**
   * The same mask, applied to this question's ROWS instead of its options
   * (matrix/grid/composite questions). Same `OptionMask`/`SetExpr` type,
   * same evaluator, same visual builder — a row is just a different target
   * dimension for the identical engine, not a second one (universal masking
   * brief, §17/§19/§22/§43). Absent on every existing question.
   */
  rowMask: OptionMask.optional(),
  /**
   * The same mask again, applied to this question's COLUMNS. Columns are
   * addressed by `id` rather than `code` (see `QuestionColumn`), so the
   * engine adapts them the same way it already does for column grouping/
   * randomization — `{...column, code: column.id}` — before running the
   * identical `applyMask` used for options and rows (§18–§20, §43).
   */
  columnMask: OptionMask.optional(),
  /**
   * Auto-selection: tick options in THIS question from other answers
   * (reqs §14–§19). The rule lives on the question being filled, so it only
   * ever reads state that already exists.
   */
  punches: z.array(PunchRule).default([]),

  /**
   * Response-quality role. An attention check is an ordinary question that the
   * quality engine also grades: the answer is compared with `expected` and a
   * miss becomes an explained flag (`@rescript/quality`, category "attention").
   */
  attentionCheck: AttentionCheck.optional(),

  /**
   * A FOLLOW-UP PROBE on an open end — "could you say more about that?" —
   * asked after the page is submitted, up to `maxProbes` times, without
   * touching the programmed flow (see `ProbeConfig`).
   */
  probe: ProbeConfig.optional(),

  /**
   * AI CONVERSATIONAL SURVEY — per-question overrides of the survey's
   * interviewer (`branding.aiConversation`), and what the voice says for this
   * question when it differs from what is shown. See schema aiConversation.ts.
   */
  ai: AiQuestionOverride.optional(),
  spoken: SpokenScript.optional(),

  displayLogic: Condition.optional(),
  skipLogic: z.array(SkipRule).default([]),

  customJs: z.string().optional(),
  customCss: z.string().optional(),
  customHtml: z.string().optional(),

  notes: z.string().optional(),
  meta: z.record(z.any()).optional(),
});
export type Question = z.infer<typeof Question>;
