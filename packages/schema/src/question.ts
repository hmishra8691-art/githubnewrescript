import { z } from "zod";
import { Condition } from "./conditions.js";
import { ListOperation, OptionLogic } from "./optionLogic.js";
import { OptionMask, PunchRule } from "./setExpression.js";
import { AttentionCheck } from "./quality.js";

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
  "exclusive", // "None of the above" behaviour
  "other_specify", // shows a text input when selected
  "none_of_above",
  "dont_know",
  "refused",
  "anchor_top",
  "anchor_bottom", // excluded from randomization
]);

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
  flags: z.array(OptionFlag).default([]),
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
  flags: z.array(OptionFlag).default([]),
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
      placeholder: z.string().optional(),
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

  displayLogic: Condition.optional(),
  skipLogic: z.array(SkipRule).default([]),

  customJs: z.string().optional(),
  customCss: z.string().optional(),
  customHtml: z.string().optional(),

  notes: z.string().optional(),
  meta: z.record(z.any()).optional(),
});
export type Question = z.infer<typeof Question>;
