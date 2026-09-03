import { Registry } from "./registry.js";

/**
 * Question Family → Variant architecture.
 *
 * A VARIANT is a presentation + capability profile layered over one of the
 * canonical base types (`Question.type`). Many variants share one response
 * model (Radio, Dropdown, Button Select and Card Select all produce
 * `single_choice`), so reporting, logic, piping, exports and the variable
 * dictionary never fragment across hundreds of visual treatments.
 *
 * `status: "stable"` variants are fully implemented end to end.
 * `status: "planned"` variants are registered so the taxonomy, picker and
 * future implementations live in ONE place — the picker shows them greyed
 * out, and implementing one later means filling in renderer/capabilities
 * here plus a renderer component, never touching the core.
 */

export type ResponseModel =
  | "single_choice" // one coded value
  | "multiple_choice" // set of coded values
  | "text"
  | "numeric"
  | "fields" // labeled typed fields keyed by row code
  | "per_row" // matrix: value per row
  | "cells" // composite: row × column cells
  | "rank_order" // ordered codes
  | "allocation" // code → number, summing rules
  | "tasks" // design-file driven (conjoint / maxdiff)
  | "coordinates" // clicked points on a stimulus image
  | "derived" // hidden / calculated
  | "media" // uploads, recordings
  | "none"; // display-only

export type VariantCapability =
  | "options"
  | "rows"
  | "columns"
  | "fields" // labeled typed list fields
  | "search"
  | "exclusive_options"
  | "min_max_selections"
  | "numeric_bounds"
  | "scale_labels" // left/right end labels
  | "sum"
  | "sorting"
  | "randomization"
  | "layout_columns"
  | "carry_forward"
  | "list_logic"
  | "other_specify"
  | "images"
  | "design_ref"
  | "expression";

export interface QuestionVariantDef {
  id: string; // "<family>.<key>"
  family: string;
  familyLabel: string;
  name: string;
  description: string;
  /** canonical base type this variant stores as (owns the response model) */
  baseType: string;
  /** runtime renderer key; undefined = base type's default renderer */
  renderer?: string;
  responseModel: ResponseModel;
  capabilities: VariantCapability[];
  /** ValidationRule kinds the editor offers for this variant */
  validations: string[];
  /** applied on creation / conversion (merged into the question) */
  defaults?: {
    settings?: Record<string, unknown>;
    options?: { code: string | number; label: string; flags?: string[]; imageUrl?: string; meta?: Record<string, unknown> }[];
    rows?: Record<string, unknown>[];
    validation?: { kind: string; value?: unknown; message?: string }[];
    instruction?: string;
  };
  status: "stable" | "planned";
  mobile: boolean;
  /**
   * This variant is a duplicate of another one and has been retired from the
   * picker. It stays registered so surveys that already reference the id keep
   * resolving to the right renderer, response model and capabilities — only
   * the authoring UI hides it, and the switcher offers the survivor instead.
   */
  supersededBy?: string;
}

export const variantRegistry = new Registry<QuestionVariantDef>("id");

/** Variants a programmer may choose today: stable, and not retired. */
export function isSelectableVariant(v: QuestionVariantDef): boolean {
  return v.status === "stable" && !v.supersededBy;
}

/**
 * Follow a retired variant to the one that replaced it.
 * Loops and dangling pointers resolve to the original rather than throwing.
 */
export function resolveVariant(id: string | undefined): QuestionVariantDef | undefined {
  let cur = id ? variantRegistry.get(id) : undefined;
  const seen = new Set<string>();
  while (cur?.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = variantRegistry.get(cur.supersededBy) ?? cur;
    if (!cur.supersededBy) break;
  }
  return cur;
}

/* ------------------------------------------------------------------ helpers */

const CAP_SINGLE: VariantCapability[] = [
  "options", "sorting", "randomization", "layout_columns",
  "carry_forward", "list_logic", "other_specify",
];
const VAL_SINGLE = ["required", "custom_expression"];

const CAP_MULTI: VariantCapability[] = [...CAP_SINGLE, "exclusive_options", "min_max_selections"];
const VAL_MULTI = ["required", "min_selections", "max_selections", "custom_expression"];

const VAL_TEXT = ["required", "min_length", "max_length", "pattern", "email", "custom_expression"];
const VAL_NUM = ["required", "min_value", "max_value", "integer", "custom_expression"];

interface Fam {
  family: string;
  familyLabel: string;
}

function stable(
  f: Fam,
  key: string,
  name: string,
  description: string,
  def: Omit<Partial<QuestionVariantDef>, "id" | "family" | "familyLabel" | "name" | "description" | "status"> &
    Pick<QuestionVariantDef, "baseType" | "responseModel">,
): QuestionVariantDef {
  return {
    id: `${f.family}.${key}`,
    ...f,
    name,
    description,
    capabilities: [],
    validations: ["required"],
    mobile: true,
    status: "stable",
    ...def,
  };
}

function planned(f: Fam, names: [string, string][]): QuestionVariantDef[] {
  return names.map(([name, description]) => ({
    id: `${f.family}.${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`,
    ...f,
    name,
    description,
    baseType: "custom_component",
    responseModel: "none" as ResponseModel,
    capabilities: [],
    validations: [],
    status: "planned" as const,
    mobile: true,
  }));
}

/* ------------------------------------------------------------------ catalog */

const F = {
  single: { family: "single_select", familyLabel: "Single Select" },
  multi: { family: "multi_select", familyLabel: "Multi Select" },
  text: { family: "text", familyLabel: "Text / Open End" },
  numeric: { family: "numeric", familyLabel: "Numeric" },
  list: { family: "list", familyLabel: "List / Form Fields" },
  matrix: { family: "matrix", familyLabel: "Grid / Matrix" },
  ranking: { family: "ranking", familyLabel: "Ranking" },
  slider: { family: "slider", familyLabel: "Slider / Rating" },
  image: { family: "image", familyLabel: "Image" },
  media: { family: "media", familyLabel: "Video / Audio" },
  dragdrop: { family: "dragdrop", familyLabel: "Drag & Drop" },
  swipe: { family: "swipe", familyLabel: "Swipe / Gesture" },
  carousel: { family: "carousel", familyLabel: "Carousel" },
  card: { family: "card", familyLabel: "Cards" },
  comparison: { family: "comparison", familyLabel: "Comparison" },
  conjoint: { family: "conjoint", familyLabel: "Conjoint / Choice Modeling" },
  allocation: { family: "allocation", familyLabel: "Constant Sum / Allocation" },
  hotspot: { family: "hotspot", familyLabel: "Hotspot / Heatmap" },
  location: { family: "location", familyLabel: "Location / Map" },
  datetime: { family: "datetime", familyLabel: "Date / Time" },
  upload: { family: "upload", familyLabel: "File / Media Upload" },
  form: { family: "form", familyLabel: "Custom Form" },
  dynamic: { family: "dynamic", familyLabel: "Dynamic / Adaptive" },
  calculated: { family: "calculated", familyLabel: "Calculated / Derived" },
  gamified: { family: "gamified", familyLabel: "Gamified / Assessment" },
  experimental: { family: "experimental", familyLabel: "Experimental / Behavioral" },
  ai: { family: "ai", familyLabel: "AI-Enabled" },
  conversational: { family: "conversational", familyLabel: "Conversational" },
  content: { family: "content", familyLabel: "Content / Hidden" },
} as const;

export const QUESTION_VARIANTS: QuestionVariantDef[] = [
  /* ------------------------------------------------------- SINGLE SELECT */
  stable(F.single, "radio", "Radio Button", "Classic vertical (or multi-column) radio list.", {
    baseType: "single_select", responseModel: "single_choice",
    capabilities: CAP_SINGLE, validations: VAL_SINGLE,
  }),
  stable(F.single, "dropdown", "Dropdown", "Compact native select for medium lists.", {
    baseType: "dropdown", responseModel: "single_choice",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: VAL_SINGLE,
  }),
  stable(F.single, "searchable_dropdown", "Searchable Dropdown", "Type-to-filter dropdown for long lists (autocomplete/combobox behaviour).", {
    baseType: "dropdown", renderer: "searchable_single", responseModel: "single_choice",
    capabilities: ["options", "search", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: VAL_SINGLE,
  }),
  stable(F.single, "buttons", "Button Select", "Large tap-friendly buttons — one per option.", {
    baseType: "single_select", renderer: "buttons", responseModel: "single_choice",
    capabilities: CAP_SINGLE, validations: VAL_SINGLE,
  }),
  stable(F.single, "cards", "Card Select", "Cards with a title and description per option.", {
    baseType: "single_select", renderer: "cards", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
  }),
  stable(F.single, "tiles", "Tile Select", "Compact card grid; set 2–4 columns in Layout.", {
    baseType: "single_select", renderer: "cards", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
    defaults: { settings: { columnsLayout: 3 } },
  }),
  stable(F.single, "image", "Image Select", "Pick one image from a grid.", {
    baseType: "image_select", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
    defaults: { settings: { maxSelections: 1 } },
  }),
  // Retired duplicates — the rating scales live in the Slider / Rating family.
  // Kept registered so existing surveys keep rendering; hidden from the picker.
  stable(F.single, "stars", "Star Rating", "1–N stars stored as a numeric score.", {
    baseType: "numeric", renderer: "stars", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 1, maxValue: 5 } },
    supersededBy: "slider.stars",
  }),
  stable(F.single, "emoji", "Emoji / Smiley Rating", "Five-point emoji scale stored as 1–5.", {
    baseType: "numeric", renderer: "emoji", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 1, maxValue: 5 } },
    supersededBy: "slider.emoji",
  }),
  stable(F.single, "likelihood", "Likelihood Scale (1–7)", "Numbered scale with end labels.", {
    baseType: "nps", responseModel: "numeric",
    capabilities: ["numeric_bounds", "scale_labels"], validations: ["required"],
    defaults: { settings: { minValue: 1, maxValue: 7, npsLeftLabel: "Not at all likely", npsRightLabel: "Extremely likely" } },
  }),
  stable(F.single, "nps", "NPS (0–10)", "Standard Net Promoter Score scale.", {
    baseType: "nps", responseModel: "numeric",
    capabilities: ["scale_labels"], validations: ["required"],
  }),
  stable(F.single, "slider", "Slider Selection", "Continuous slider between two anchors.", {
    baseType: "slider", responseModel: "numeric",
    capabilities: ["numeric_bounds", "scale_labels"], validations: VAL_NUM,
    supersededBy: "slider.single",
  }),
  stable(F.single, "discrete_slider", "Discrete Slider", "Slider snapping to whole steps.", {
    baseType: "slider", responseModel: "numeric",
    capabilities: ["numeric_bounds", "scale_labels"], validations: VAL_NUM,
    defaults: { settings: { step: 1 } },
    supersededBy: "slider.discrete",
  }),
  stable(F.single, "carousel", "Single-Item Carousel", "One option at a time; browse with ‹ › and select.", {
    baseType: "single_select", renderer: "carousel", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
    supersededBy: "carousel.single",
  }),
  stable(F.single, "icon_select", "Icon Select", "Pick one option shown as an icon — an emoji, short text or image per option.", {
    baseType: "single_select", renderer: "icons", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
    defaults: {
      options: [
        { code: 1, label: "Home", meta: { icon: "🏠" } },
        { code: 2, label: "Work", meta: { icon: "💼" } },
        { code: 3, label: "Travel", meta: { icon: "✈️" } },
      ],
      settings: { columnsLayout: 3 },
    },
  }),
  stable(F.single, "list_select", "List Select", "Selectable list rows with a description, badge and right-hand figure per option.", {
    baseType: "single_select", renderer: "listrows", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
  }),
  stable(F.single, "heart_rating", "Heart Rating", "1–N hearts stored as a score.", {
    baseType: "numeric", renderer: "hearts", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 1, maxValue: 5 } },
  }),
  stable(F.single, "product_choice", "Product Choice", "Rich product cards — image, description, price, badge — pick one.", {
    baseType: "single_select", renderer: "richcards", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
    defaults: { settings: { columnsLayout: 3 } },
  }),
  stable(F.single, "statement_choice", "Statement Choice", "Full-width statements — choose the one you agree with most.", {
    baseType: "single_select", renderer: "statements", responseModel: "single_choice",
    capabilities: CAP_SINGLE, validations: VAL_SINGLE,
    defaults: { instruction: "Which statement comes closest to your view?" },
  }),
  stable(F.single, "pairwise_choice", "Pairwise Choice", "A vs B forced choice between exactly two options.", {
    baseType: "single_select", renderer: "pairwise", responseModel: "single_choice",
    capabilities: ["options", "images", "randomization", "carry_forward"], validations: VAL_SINGLE,
    defaults: { options: [{ code: 1, label: "Option A" }, { code: 2, label: "Option B" }] },
  }),

  /* -------------------------------------------------------- MULTI SELECT */
  stable(F.multi, "checkbox", "Checkbox", "Classic checkbox list with exclusive-option support.", {
    baseType: "multi_select", responseModel: "multiple_choice",
    capabilities: CAP_MULTI, validations: VAL_MULTI,
  }),
  stable(F.multi, "dropdown", "Multi-Select Dropdown", "Searchable chip dropdown: select all, clear all, min/max, exclusives.", {
    baseType: "multi_dropdown", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "search"], validations: VAL_MULTI,
  }),
  stable(F.multi, "searchable", "Searchable Multi-Select", "Same as Multi-Select Dropdown (search built in).", {
    baseType: "multi_dropdown", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "search"], validations: VAL_MULTI,
  }),
  stable(F.multi, "buttons", "Button Multi-Select", "Toggleable buttons; exclusives clear the rest.", {
    baseType: "multi_select", renderer: "buttons", responseModel: "multiple_choice",
    capabilities: CAP_MULTI, validations: VAL_MULTI,
  }),
  stable(F.multi, "cards", "Card Multi-Select", "Select any number of option cards.", {
    baseType: "multi_select", renderer: "cards", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
  }),
  stable(F.multi, "image", "Image Multi-Select / Image Grid", "Pick several images from a grid.", {
    baseType: "image_select", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
    defaults: { settings: { maxSelections: 99 } },
  }),
  stable(F.multi, "top_n", "Pick Exactly N", "A multi-select that accepts exactly N answers — \"choose your 3 favourites\". Set N with min/max selections.", {
    baseType: "multi_select", responseModel: "multiple_choice",
    capabilities: CAP_MULTI, validations: VAL_MULTI,
    defaults: { settings: { minSelections: 3, maxSelections: 3 }, instruction: "Please select exactly 3." },
  }),
  stable(F.multi, "icon_multi_select", "Icon Multi-Select", "Select any number of icons.", {
    baseType: "multi_select", renderer: "icons", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
    defaults: { settings: { columnsLayout: 4 } },
  }),
  stable(F.multi, "list_multi_select", "List Multi-Select", "Selectable list rows with a description, badge and right-hand figure.", {
    baseType: "multi_select", renderer: "listrows", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
  }),
  stable(F.multi, "multi_item_carousel", "Multi-Item Carousel", "Browse one card at a time and select as many as apply.", {
    baseType: "multi_select", renderer: "multicarousel", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
  }),
  stable(F.multi, "product_multi_select", "Product Multi-Select", "Rich product cards — select several.", {
    baseType: "multi_select", renderer: "richcards", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
    defaults: { settings: { columnsLayout: 3 } },
  }),

  /* ----------------------------------------------------------------- TEXT */
  stable(F.text, "single_line", "Single-Line Text", "One-line open end.", {
    baseType: "open_text", responseModel: "text", validations: VAL_TEXT,
  }),
  stable(F.text, "multi_line", "Multi-Line Text", "Paragraph answer.", {
    baseType: "long_text", responseModel: "text", validations: VAL_TEXT,
  }),
  stable(F.text, "essay", "Essay / Long Text", "Long-form answer with a minimum length.", {
    baseType: "long_text", responseModel: "text", validations: VAL_TEXT,
    // the threshold has to be in the message: a respondent who types a
    // sentence and is refused with "write a few sentences" has no idea why.
    defaults: { validation: [{ kind: "min_length", value: 100, message: "Please write at least 100 characters." }] },
  }),
  stable(F.text, "email", "Email", "Validated email address.", {
    baseType: "open_text", responseModel: "text",
    validations: ["required", "email", "min_length", "max_length", "pattern"],
    defaults: { validation: [{ kind: "email" }], settings: { placeholder: "name@example.com" } },
  }),
  stable(F.text, "phone", "Phone Number", "Validated phone number.", {
    baseType: "open_text", responseModel: "text",
    validations: ["required", "pattern", "min_length", "max_length"],
    defaults: {
      validation: [{ kind: "pattern", value: "^\\+?[0-9()\\-\\.\\s]{7,20}$", message: "Please enter a valid phone number." }],
      settings: { placeholder: "+1 555 123 4567" },
    },
  }),
  stable(F.text, "url", "URL", "Validated web address.", {
    baseType: "open_text", responseModel: "text",
    validations: ["required", "pattern"],
    defaults: { validation: [{ kind: "pattern", value: "^(https?:\\/\\/)?[\\w.-]+\\.[A-Za-z]{2,}(\\/\\S*)?$", message: "Please enter a valid URL." }] },
  }),
  stable(F.text, "zip", "ZIP / Postal Code", "Validated postal code.", {
    baseType: "open_text", responseModel: "text",
    validations: ["required", "pattern"],
    defaults: { validation: [{ kind: "pattern", value: "^[A-Za-z0-9][A-Za-z0-9\\- ]{2,9}$", message: "Please enter a valid postal code." }] },
  }),
  stable(F.text, "regex", "Masked / Regex Text", "Free text constrained by a custom pattern.", {
    baseType: "open_text", responseModel: "text",
    validations: ["required", "pattern", "min_length", "max_length"],
    defaults: { validation: [{ kind: "pattern", value: "", message: "Invalid format." }] },
  }),
  stable(F.text, "name", "Name (First / Last)", "Two labeled name fields.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
    defaults: {
      rows: [
        { code: "first", label: "First Name", fieldType: "text", required: true, flags: [], validation: [] },
        { code: "last", label: "Last Name", fieldType: "text", required: true, flags: [], validation: [] },
      ],
    },
  }),
  stable(F.text, "address", "Address", "Street / city / state / ZIP field set.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
    defaults: {
      rows: [
        { code: "street", label: "Street Address", fieldType: "text", required: true, flags: [], validation: [] },
        { code: "city", label: "City", fieldType: "text", required: true, flags: [], validation: [] },
        { code: "state", label: "State / Region", fieldType: "text", required: false, flags: [], validation: [] },
        { code: "zip", label: "ZIP / Postal Code", fieldType: "zip", required: true, flags: [], validation: [] },
      ],
    },
  }),
  stable(F.text, "company", "Company Name", "Single company field.", {
    baseType: "open_text", responseModel: "text", validations: VAL_TEXT,
    defaults: { settings: { placeholder: "Company name" } },
  }),
  ...planned(F.text, [["Rich Text", "Formatted-text answer."]]),

  /* -------------------------------------------------------------- NUMERIC */
  stable(F.numeric, "open", "Numeric Open End", "Any number.", {
    baseType: "numeric", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
  }),
  stable(F.numeric, "integer", "Integer", "Whole numbers only.", {
    baseType: "numeric", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { validation: [{ kind: "integer" }] },
  }),
  stable(F.numeric, "currency", "Currency", "Monetary amount (0 or more).", {
    baseType: "numeric", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 0, placeholder: "0.00" } },
  }),
  stable(F.numeric, "percentage", "Percentage", "0–100 value.", {
    baseType: "numeric", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 0, maxValue: 100 } },
  }),
  stable(F.numeric, "quantity", "Quantity", "Non-negative whole number.", {
    baseType: "numeric", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 0 }, validation: [{ kind: "integer" }] },
  }),
  stable(F.numeric, "slider", "Number Slider", "Numeric input as a slider.", {
    baseType: "slider", responseModel: "numeric",
    capabilities: ["numeric_bounds", "scale_labels"], validations: VAL_NUM,
    supersededBy: "slider.single",
  }),
  stable(F.numeric, "percentage_slider", "Percentage Slider", "0–100 slider.", {
    baseType: "slider", responseModel: "numeric",
    capabilities: ["scale_labels"], validations: ["required"],
    defaults: { settings: { minValue: 0, maxValue: 100, sliderRightLabel: "100%" } },
  }),
  ...planned(F.numeric, [["Numeric Range", "A from–to pair of numbers."]]),

  /* ----------------------------------------------------------------- LIST */
  stable(F.list, "text_list", "Open Text List", "Labeled text fields, one variable per row.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
  }),
  stable(F.list, "numeric_list", "Numeric List", "Labeled numeric fields.", {
    baseType: "numeric_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
  }),
  stable(F.list, "mixed", "Multi-Field List / Custom Form", "Rows mixing text, email, currency, date… any field type per row.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
  }),
  stable(F.list, "ranking", "Ranking List", "Tap-to-rank ordered list.", {
    supersededBy: "ranking.click",
    baseType: "ranking", responseModel: "rank_order",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: ["required", "min_selections", "max_selections"],
  }),
  stable(F.list, "carry_forward", "Carry-Forward List", "Options pulled from an earlier question's selections.", {
    baseType: "multi_select", responseModel: "multiple_choice",
    capabilities: CAP_MULTI, validations: VAL_MULTI,
    defaults: { instruction: "Configure the source under Carry-forward in the right panel." },
  }),
  stable(F.list, "dynamic_list", "Dynamic List", "Respondent adds rows as needed.", {
    baseType: "repeating_group", renderer: "dynamiclist", responseModel: "fields",
    capabilities: ["fields"], validations: ["required"],
    defaults: {
      // one field per entry: the list is a column of single values
      rows: [{ code: "item", label: "Item", fieldType: "text", required: true }],
      settings: { minRepeats: 1, maxRepeats: 10 },
    },
  }),
  stable(F.list, "editable_table", "Editable Table", "Spreadsheet-style entry grid.", {
    baseType: "custom_table", renderer: "spreadsheet", responseModel: "cells",
    capabilities: ["rows", "columns"], validations: ["required"],
    defaults: {
      rows: [1, 2, 3].map((n) => ({ code: String(n), label: `Row ${n}` })),
      instruction: "Tab or the arrow keys move between cells; Enter moves down.",
    },
  }),

  /* --------------------------------------------------------------- MATRIX */
  stable(F.matrix, "single", "Single-Select Matrix", "One answer per row.", {
    baseType: "matrix_single", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
  }),
  stable(F.matrix, "multi", "Multi-Select Matrix", "Multiple answers per row, exclusive-aware.", {
    baseType: "matrix_multi", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward", "exclusive_options"],
    validations: ["required", "min_selections", "max_selections"],
  }),
  stable(F.matrix, "likert", "Likert Matrix", "Agreement scale preset (5-point).", {
    baseType: "matrix_single", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: {
      options: [
        { code: 1, label: "Strongly disagree" }, { code: 2, label: "Disagree" },
        { code: 3, label: "Neither agree nor disagree" },
        { code: 4, label: "Agree" }, { code: 5, label: "Strongly agree" },
      ],
    },
  }),
  stable(F.matrix, "rating", "Rating Matrix (1–5)", "Numbered rating columns.", {
    baseType: "matrix_single", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: {
      options: [1, 2, 3, 4, 5].map((n) => ({ code: n, label: String(n) })),
    },
  }),
  stable(F.matrix, "numeric", "Numeric Matrix", "A number per row.", {
    baseType: "matrix_numeric", responseModel: "per_row",
    capabilities: ["rows", "randomization", "carry_forward", "numeric_bounds"],
    validations: ["required", "min_value", "max_value"],
  }),
  stable(F.matrix, "text", "Text Matrix", "A text answer per row.", {
    baseType: "matrix_text", responseModel: "per_row",
    capabilities: ["rows", "randomization", "carry_forward"], validations: ["required"],
  }),
  stable(F.matrix, "dropdown", "Dropdown Matrix", "A dropdown per row.", {
    baseType: "matrix_dropdown", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"], validations: ["required"],
  }),
  stable(F.matrix, "mixed", "Mixed-Type Matrix (Composite)", "Each column its own response type, variable and validation.", {
    baseType: "composite", responseModel: "cells",
    capabilities: ["rows", "columns", "randomization", "carry_forward"], validations: ["required"],
  }),
  stable(F.matrix, "random_rows", "Matrix with Randomized Rows", "Single-select matrix, rows shuffled per respondent.", {
    baseType: "matrix_single", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"], validations: ["required"],
    defaults: { settings: {} },
  }),
  stable(F.matrix, "semantic", "Semantic Differential", "Opposing adjectives at each end — write rows as \"Cheap | Expensive\".", {
    baseType: "matrix_single", renderer: "semantic", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: {
      options: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ code: n, label: String(n) })),
      instruction: "For each pair, pick the point closest to your view.",
    },
  }),
  stable(F.matrix, "slider_matrix", "Slider Matrix", "A slider per row.", {
    baseType: "matrix_numeric", renderer: "slidermatrix", responseModel: "per_row",
    capabilities: ["rows", "numeric_bounds", "scale_labels", "randomization", "carry_forward"],
    validations: ["required", "min_value", "max_value"],
    defaults: { settings: { sliderLayout: "grid", minValue: 0, maxValue: 100, step: 1 } },
  }),
  stable(F.matrix, "star_matrix", "Star Rating Matrix", "Stars per row.", {
    baseType: "matrix_numeric", renderer: "starmatrix", responseModel: "per_row",
    capabilities: ["rows", "numeric_bounds", "randomization", "carry_forward"],
    validations: ["required", "min_value", "max_value"],
    defaults: { settings: { minValue: 1, maxValue: 5 } },
  }),
  /**
   * Each ROW spreads `settings.sumTarget` across the COLUMNS — "split 100
   * points between the brands, for every attribute". The cells are an
   * ordinary composite, so variables, piping and the CSV layout are the ones
   * the Mixed-Type Matrix already exports; `settings.rowSum` is what tells
   * the validator to hold each row to the target (see validate.ts).
   */
  stable(F.matrix, "constant_sum", "Constant-Sum Matrix", "Allocations across a grid.", {
    baseType: "composite", renderer: "summatrix", responseModel: "cells",
    capabilities: ["rows", "columns", "sum", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: {
      // composite is not row-driven, so this variant brings its own rows
      rows: [1, 2, 3].map((n) => ({ code: String(n), label: `Attribute ${n}` })),
      settings: { rowSum: true, sumTarget: 100 },
      instruction: "Split the total across the columns — every row must reach the target.",
    },
  }),
  stable(F.matrix, "dragdrop_matrix", "Drag-and-Drop Matrix", "Drag answers into a grid.", {
    baseType: "matrix_single", renderer: "dragmatrix", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: { instruction: "Drag each item into a column — or tap the item, then the column." },
  }),

  /* -------------------------------------------------------------- RANKING */
  // The three ranking variants differ by `settings.rankMode`, which the
  // renderer and the validator both read — without it they were three labels
  // over one identical tap-to-rank behaviour.
  stable(F.ranking, "click", "Click-to-Rank", "Tap items in order; rank as many as you like.", {
    baseType: "ranking", responseModel: "rank_order",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: ["required", "min_selections", "max_selections"],
    defaults: { settings: { rankMode: "click" } },
  }),
  stable(F.ranking, "rank_all", "Rank All Items", "Every item must receive a rank.", {
    baseType: "ranking", responseModel: "rank_order",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: ["required"],
    defaults: { settings: { rankMode: "all" }, instruction: "Please rank every item." },
  }),
  stable(F.ranking, "top_n", "Rank Top N", "Respondents rank only their best N items and leave the rest unranked — \"rank your top 3 of 10\".", {
    baseType: "ranking", responseModel: "rank_order",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic", "min_max_selections"],
    validations: ["required", "min_selections", "max_selections"],
    defaults: { settings: { rankMode: "top_n", maxSelections: 3 }, instruction: "Rank your top 3." },
  }),
  stable(F.ranking, "image", "Image Ranking", "Rank images by tapping them in order.", {
    baseType: "image_ranking", responseModel: "rank_order",
    capabilities: ["options", "images", "randomization", "carry_forward"], validations: ["required"],
  }),
  stable(F.ranking, "best_worst", "Best–Worst (MaxDiff)", "Best/worst tasks from a generated MaxDiff design.", {
    baseType: "maxdiff_task", responseModel: "tasks",
    capabilities: ["design_ref"], validations: [],
  }),
  stable(F.ranking, "drag", "Drag-and-Drop Ranking", "Drag items into order (arrow buttons on touch).", {
    baseType: "ranking", renderer: "dragrank", responseModel: "rank_order",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: ["required"],
  }),
  ...planned(F.ranking, [
    ["Pairwise / Tournament Ranking", "Repeated A-vs-B duels."],
    ["Bucket Ranking", "Drag items into ranked buckets."],
  ]),

  /* ---------------------------------------------------------------- SLIDER */
  stable(F.slider, "single", "Single Slider", "One continuous slider.", {
    baseType: "slider", responseModel: "numeric",
    capabilities: ["numeric_bounds", "scale_labels"], validations: VAL_NUM,
  }),
  stable(F.slider, "discrete", "Discrete Slider", "Slider snapping to whole steps.", {
    baseType: "slider", responseModel: "numeric",
    capabilities: ["numeric_bounds", "scale_labels"], validations: VAL_NUM,
    defaults: { settings: { step: 1 } },
  }),
  stable(F.slider, "stars", "Star Rating", "1–N stars stored as a numeric score.", {
    baseType: "numeric", renderer: "stars", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 1, maxValue: 5 } },
  }),
  stable(F.slider, "emoji", "Emoji / Smiley Rating", "Emoji scale; the face count follows min–max.", {
    baseType: "numeric", renderer: "emoji", responseModel: "numeric",
    capabilities: ["numeric_bounds"], validations: VAL_NUM,
    defaults: { settings: { minValue: 1, maxValue: 5 } },
  }),
  ...planned(F.slider, [
    ["Dual / Range Slider", "Two handles selecting a range."],
    ["Vertical Slider", "Vertical orientation."],
    ["Multi-Attribute Slider", "Several sliders in one question."],
    ["Allocation Slider", "Sliders that must total 100."],
  ]),

  /* ---------------------------------------------------------------- IMAGE */
  stable(F.image, "choice", "Image Choice", "Pick one image.", {
    baseType: "image_select", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
    defaults: { settings: { maxSelections: 1 } },
  }),
  stable(F.image, "grid", "Image Grid (Multi)", "Pick several images.", {
    baseType: "image_select", responseModel: "multiple_choice",
    capabilities: [...CAP_MULTI, "images"], validations: VAL_MULTI,
    defaults: { settings: { maxSelections: 99 } },
  }),
  stable(F.image, "ranking", "Image Ranking", "Rank images in order.", {
    baseType: "image_ranking", responseModel: "rank_order",
    capabilities: ["options", "images", "randomization"], validations: ["required"],
  }),
  stable(F.image, "hotspot", "Image Hotspot / Click Points", "Respondents click up to N points on a stimulus image; X/Y coordinates are captured.", {
    baseType: "hotspot", renderer: "hotspotclick", responseModel: "coordinates",
    capabilities: ["min_max_selections"], validations: ["required", "min_selections", "max_selections"],
    defaults: { settings: { maxSelections: 1 }, instruction: "Click on the image." },
  }),
  stable(F.image, "comparison", "Image Comparison (Side-by-Side)", "Two or more large images side by side — pick one.", {
    baseType: "single_select", renderer: "compare", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
  }),
  stable(F.image, "categorization", "Image Categorization / Buckets", "Assign each item to a bucket (stored like matrix rows).", {
    baseType: "matrix_single", renderer: "categorize", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward", "images"],
    validations: ["required"],
    defaults: {
      options: [
        { code: "keep", label: "Keep" }, { code: "unsure", label: "Unsure" }, { code: "drop", label: "Drop" },
      ],
      instruction: "Assign each item to a category.",
    },
  }),
  ...planned(F.image, [
    ["Image Annotation / Markup", "Draw or comment on an image."],
  ]),

  /* -------------------------------------------------- PLANNED-ONLY FAMILIES */
  ...planned(F.media, [
    ["Video Rating", "Rate after watching a clip."],
    ["Video Hotspot / Annotation", "React on the video timeline."],
    ["Video Watch-Time Tracking", "Capture how long respondents watch."],
    ["Audio Recording / Voice Response", "Record a spoken answer."],
    ["Speech-to-Text Response", "Transcribed voice answer."],
  ]),
  stable(F.dragdrop, "ranking", "Drag-and-Drop Ranking", "Drag items into order.", {
    baseType: "ranking", renderer: "dragrank", responseModel: "rank_order",
    capabilities: ["options", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: ["required"],
  }),
  ...planned(F.dragdrop, [
    ["Drag into Buckets / Categorization", "Sort items into named buckets."],
    ["Drag onto Scale", "Place items along a scale."],
    ["Drag-and-Drop Allocation", "Distribute chips across items."],
  ]),
  stable(F.swipe, "tinder", "Tinder-Style Swipe", "Card deck: swipe right = like, left = dislike (buttons too). One judgement per item.", {
    baseType: "matrix_single", renderer: "swipe", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: {
      options: [
        { code: 0, label: "👎 Dislike" },
        { code: 1, label: "👍 Like" },
      ],
      instruction: "Swipe right to like, left to dislike — or use the buttons.",
    },
  }),
  stable(F.swipe, "statement", "Statement Swipe", "Swipe through statements, agreeing or disagreeing.", {
    baseType: "matrix_single", renderer: "swipe", responseModel: "per_row",
    capabilities: ["rows", "options", "randomization", "carry_forward"],
    validations: ["required"],
    defaults: {
      options: [
        { code: 0, label: "✗ Disagree" },
        { code: 1, label: "✓ Agree" },
      ],
      instruction: "Swipe right if you agree, left if you disagree.",
    },
  }),
  ...planned(F.swipe, [
    ["Swipe-to-Rate / Rank / Categorize", "Gesture-driven judgements."],
    ["Four-Direction Swipe", "Up/down/left/right buckets."],
  ]),
  stable(F.carousel, "single", "Single-Item Carousel", "Browse options one card at a time and select one.", {
    baseType: "single_select", renderer: "carousel", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
  }),
  ...planned(F.carousel, [
    ["Carousel + Choice / Slider / Text", "Judge each carousel item."],
    ["Comparison Carousel", "Browse and compare."],
  ]),
  ...planned(F.card, [
    ["Profile / Product / Statement Cards", "Rich selectable cards."],
    ["Expandable / Flip Cards", "Cards revealing detail."],
    ["Sortable / Swipeable Cards", "Gesture-driven card decks."],
  ]),
  stable(F.comparison, "side_by_side", "Side-by-Side Comparison", "Large option cards/images side by side — pick one.", {
    baseType: "single_select", renderer: "compare", responseModel: "single_choice",
    capabilities: [...CAP_SINGLE, "images"], validations: VAL_SINGLE,
  }),
  ...planned(F.comparison, [
    ["Pairwise / Tournament Comparison", "Repeated A-vs-B duels."],
    ["Multi-Item / Attribute Comparison", "Compare across attributes."],
  ]),

  /* -------------------------------------------------------------- CONJOINT */
  stable(F.conjoint, "cbc", "Choice-Based Conjoint (CBC)", "Tasks from a generated conjoint design (Design Generators tab).", {
    baseType: "conjoint_task", responseModel: "tasks",
    capabilities: ["design_ref"], validations: [],
  }),
  stable(F.conjoint, "maxdiff", "MaxDiff", "Best/worst tasks from a generated MaxDiff design.", {
    baseType: "maxdiff_task", responseModel: "tasks",
    capabilities: ["design_ref"], validations: [],
  }),
  ...planned(F.conjoint, [
    ["Adaptive CBC (ACBC)", "Adaptive conjoint tasks."],
    ["Menu-Based Conjoint", "Configure-your-own menu tasks."],
    ["Pricing / Configurator Choice", "Price-focused choice tasks."],
  ]),

  /* ------------------------------------------------------------ ALLOCATION */
  stable(F.allocation, "constant_sum", "Constant Sum", "Values must total the target.", {
    baseType: "allocation", responseModel: "allocation",
    capabilities: ["options", "sum", "sorting", "randomization", "carry_forward", "list_logic"],
    validations: ["required", "sum_equals", "sum_max", "sum_min"],
  }),
  stable(F.allocation, "budget", "Budget Allocation", "Distribute a budget (currency).", {
    baseType: "allocation", responseModel: "allocation",
    capabilities: ["options", "sum", "carry_forward", "list_logic"],
    validations: ["required", "sum_equals", "sum_max", "sum_min"],
    defaults: { settings: { sumTarget: 100, sumUnit: " $" } },
  }),
  stable(F.allocation, "percentage", "Percentage Allocation", "Percentages totalling 100.", {
    baseType: "allocation", responseModel: "allocation",
    capabilities: ["options", "sum", "carry_forward", "list_logic"],
    validations: ["required", "sum_equals"],
    defaults: { settings: { sumTarget: 100, sumUnit: " %" } },
  }),
  stable(F.allocation, "points", "Point Allocation", "Distribute N points.", {
    baseType: "allocation", responseModel: "allocation",
    capabilities: ["options", "sum", "carry_forward", "list_logic"],
    validations: ["required", "sum_equals", "sum_max"],
    defaults: { settings: { sumTarget: 100, sumUnit: " pts" } },
  }),
  ...planned(F.allocation, [
    ["Slider Allocation", "Sliders constrained to a total."],
    ["Drag Allocation", "Drag chips onto items."],
  ]),

  stable(F.hotspot, "click", "Image Hotspot / Click Heatmap", "Click up to N points on an image; coordinates recorded as percentages.", {
    baseType: "hotspot", renderer: "hotspotclick", responseModel: "coordinates",
    capabilities: ["min_max_selections"], validations: ["required", "min_selections", "max_selections"],
    defaults: { settings: { maxSelections: 1 }, instruction: "Click on the image." },
  }),
  ...planned(F.hotspot, [
    ["Region / Area Selection", "Select predefined regions."],
    ["Draw-on-Image", "Free-form marking."],
  ]),
  ...planned(F.location, [
    ["Location Picker / Map Pin", "Drop a pin on a map."],
    ["Address Search", "Geocoded address entry."],
    ["Radius / Distance Selection", "Select an area around a point."],
  ]),

  /* --------------------------------------------------------------- DATE */
  stable(F.datetime, "date", "Date Picker", "Single date.", {
    baseType: "date", responseModel: "text", validations: ["required"],
  }),
  stable(F.datetime, "time", "Time Picker", "Single time of day.", {
    baseType: "time", responseModel: "text", validations: ["required"],
  }),
  stable(F.datetime, "date_range", "Date Range", "From and to dates as two fields.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields"], validations: ["required"],
    defaults: {
      rows: [
        { code: "from", label: "From", fieldType: "date", required: true, flags: [], validation: [] },
        { code: "to", label: "To", fieldType: "date", required: true, flags: [], validation: [] },
      ],
    },
  }),
  ...planned(F.datetime, [
    ["Calendar / Appointment Selection", "Pick slots on a calendar."],
    ["Month / Year Picker", "Coarse date entry."],
  ]),

  ...planned(F.upload, [
    ["File / Document Upload", "Attach a file."],
    ["Photo / Camera Capture", "Take a photo in-survey."],
    ["Signature Capture", "Draw a signature."],
  ]),

  /* ----------------------------------------------------------------- FORM */
  stable(F.form, "custom", "Custom Form", "Any mix of labeled, typed, validated fields.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
  }),
  stable(F.form, "contact", "Contact Form", "Name, email, phone preset.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
    defaults: {
      rows: [
        { code: "name", label: "Full Name", fieldType: "text", required: true, flags: [], validation: [] },
        { code: "email", label: "Email Address", fieldType: "email", required: true, flags: [], validation: [] },
        { code: "phone", label: "Phone Number", fieldType: "phone", required: false, flags: [], validation: [] },
      ],
    },
  }),
  stable(F.form, "repeating", "Repeating / Nested Form", "Respondent-driven repetition.", {
    baseType: "repeating_group", renderer: "repeatform", responseModel: "fields",
    capabilities: ["fields"], validations: ["required"],
    defaults: {
      rows: [
        { code: "name", label: "Name", fieldType: "text", required: true },
        { code: "email", label: "Email", fieldType: "email" },
        { code: "relationship", label: "Relationship", fieldType: "text" },
      ],
      settings: { minRepeats: 1, maxRepeats: 5 },
    },
  }),
  /**
   * An ordinary field list whose ROWS carry `visibleIf` — the runtime
   * re-evaluates row visibility on every answer change, so a field appears
   * and disappears live as an earlier question is answered. No renderer of
   * its own: the condition is the whole feature.
   */
  stable(F.form, "conditional", "Conditional Form", "Fields appearing per earlier answers.", {
    baseType: "text_list", responseModel: "fields",
    capabilities: ["fields", "layout_columns"], validations: ["required"],
    defaults: {
      rows: [
        { code: "employed", label: "Are you employed?", fieldType: "text" },
        { code: "employer", label: "Employer", fieldType: "text" },
      ],
      instruction: "Add a Show-when condition on any field in its ⑂ logic — it appears only when the condition holds.",
    },
  }),

  /* -------------------------------------------------------------- DYNAMIC */
  stable(F.dynamic, "previous_answer", "Previous-Answer-Driven Options", "Options carried from an earlier question (include/exclude/prioritize).", {
    baseType: "multi_select", responseModel: "multiple_choice",
    capabilities: CAP_MULTI, validations: VAL_MULTI,
    defaults: { instruction: "Configure Carry-forward and List logic in the right panel." },
  }),
  ...planned(F.dynamic, [
    ["Adaptive Question / Scale", "Content adapting mid-survey."],
    ["Respondent-Specific Options", "Options from embedded data or APIs."],
  ]),

  /* ----------------------------------------------------------- CALCULATED */
  stable(F.calculated, "value", "Calculated Value", "Expression-driven derived variable (calc DSL).", {
    baseType: "calculated", responseModel: "derived",
    capabilities: ["expression"], validations: [],
  }),
  stable(F.calculated, "hidden", "Hidden Variable", "Invisible variable set by URL, scripts or piping.", {
    baseType: "hidden", responseModel: "derived",
    capabilities: [], validations: [],
  }),
  stable(F.calculated, "score", "Respondent Score", "Weighted score preset (edit the expression).", {
    baseType: "calculated", responseModel: "derived",
    capabilities: ["expression"], validations: [],
    defaults: { settings: { expression: "weighted(Q1, 0.5, Q2, 0.5)" } },
  }),

  ...planned(F.gamified, [
    ["Quiz / Knowledge Test", "Scored right/wrong questions."],
    ["Timed Question / Reaction Test", "Response-time capture."],
    ["Matching / Puzzle / Memory", "Game-mechanic tasks."],
  ]),
  ...planned(F.experimental, [
    ["Attention Check", "Trap question with expected answer."],
    ["Reaction-Time / Implicit Association", "Millisecond-timed stimulus response."],
    ["A/B / Multivariate Experiment", "Random treatment assignment."],
    ["Random Stimulus", "Randomly assigned stimulus display."],
  ]),
  ...planned(F.ai, [
    ["AI Open-End Classification", "Auto-code open ends into themes."],
    ["AI Sentiment Analysis", "Score open-end sentiment."],
    ["AI Follow-Up / Dynamic Probe", "Model-generated follow-up questions."],
    ["AI Conversational Survey", "Interview-style adaptive flow."],
    ["AI Quality Check", "Flag low-quality responses."],
  ]),
  ...planned(F.conversational, [
    ["Chat-Based Question", "One-at-a-time chat presentation."],
    ["Voice Survey", "Spoken question and answer."],
    ["Adaptive Conversation", "Dynamic follow-ups in a chat flow."],
  ]),

  /* --------------------------------------------------------------- CONTENT */
  stable(F.content, "html", "Text / HTML Block", "Display-only content with piping.", {
    baseType: "html", responseModel: "none", capabilities: [], validations: [],
  }),
  stable(F.content, "embedded", "Embedded Data Field", "Captured from the URL or panel.", {
    baseType: "embedded_data", responseModel: "derived", capabilities: [], validations: [],
  }),
];

/**
 * Row-based question types are unusable with zero rows: a matrix renders an
 * empty grid, and a swipe deck reports "0 cards judged" because its cards ARE
 * its rows. Nothing in the catalog declared starter rows, so every one of them
 * was born broken. Rather than repeat a `defaults.rows` block on a dozen
 * entries, seed any stable row-driven variant that doesn't bring its own.
 */
const ROW_DRIVEN_BASE_TYPES = [
  "matrix_single",
  "matrix_multi",
  "matrix_numeric",
  "matrix_text",
  "matrix_dropdown",
];

/**
 * Numeric codes, so the seeded rows and anything the programmer adds after
 * them form one consistent 1..N sequence (and stay re-sequenceable). A mixed
 * list like r1, r2, r3, 4 is exactly the confusion this batch was reported for.
 */
function starterRows(v: QuestionVariantDef): { code: string; label: string }[] {
  const noun = v.renderer === "swipe" ? "Card" : "Statement";
  return [1, 2, 3].map((n) => ({ code: String(n), label: `${noun} ${n}` }));
}

for (const v of QUESTION_VARIANTS) {
  if (
    v.status === "stable" &&
    ROW_DRIVEN_BASE_TYPES.includes(v.baseType) &&
    !v.defaults?.rows
  ) {
    v.defaults = { ...(v.defaults ?? {}), rows: starterRows(v) };
  }
  if (!variantRegistry.has(v.id)) variantRegistry.register(v);
}

/* ------------------------------------------------------------- utilities */

export function variantFamilies(): { family: string; familyLabel: string; stable: number; planned: number }[] {
  const map = new Map<string, { family: string; familyLabel: string; stable: number; planned: number }>();
  for (const v of QUESTION_VARIANTS) {
    const e = map.get(v.family) ?? { family: v.family, familyLabel: v.familyLabel, stable: 0, planned: 0 };
    e[v.status === "stable" ? "stable" : "planned"]++;
    map.set(v.family, e);
  }
  return [...map.values()];
}

export function variantsOf(family: string): QuestionVariantDef[] {
  return QUESTION_VARIANTS.filter((v) => v.family === family);
}

/** Response model of a base type — the ground truth for conversion safety. */
export function responseModelOf(baseType: string): ResponseModel {
  switch (baseType) {
    case "single_select": case "dropdown": return "single_choice";
    case "multi_select": case "multi_dropdown": return "multiple_choice";
    case "image_select": return "multiple_choice"; // stored as array
    case "numeric": case "slider": case "nps": return "numeric";
    case "open_text": case "long_text": case "date": case "time": return "text";
    case "text_list": case "numeric_list": return "fields";
    case "matrix_single": case "matrix_multi": case "matrix_numeric":
    case "matrix_text": case "matrix_dropdown": return "per_row";
    case "composite": case "custom_table": return "cells";
    case "ranking": case "image_ranking": return "rank_order";
    case "allocation": return "allocation";
    case "conjoint_task": case "maxdiff_task": return "tasks";
    case "hotspot": case "annotation": case "media_timeline": return "coordinates";
    case "upload": return "media";
    case "repeating_group": return "fields";
    case "hidden": case "calculated": case "embedded_data": case "experiment": return "derived";
    case "html": return "none";
    default: return "none";
  }
}

/** Default variant id for a legacy question that has none stored.
 *  Prefers the variant with the base type's default renderer, so a plain
 *  numeric question infers as "Numeric Open End", never as "Star Rating". */
export function variantForLegacyType(baseType: string): string | undefined {
  const candidates = QUESTION_VARIANTS.filter(
    (v) => v.status === "stable" && v.baseType === baseType,
  );
  return (candidates.find((v) => !v.renderer) ?? candidates[0])?.id;
}

/** Is switching between these variants non-destructive for collected data,
 *  logic and exports? Same response model = safe. */
export function isSafeConversion(
  from: QuestionVariantDef | undefined,
  to: QuestionVariantDef,
  fromBaseType: string,
): boolean {
  const fromModel = from?.responseModel ?? responseModelOf(fromBaseType);
  return fromModel === to.responseModel;
}
