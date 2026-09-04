import { z } from "zod";
import { Condition } from "./conditions.js";
import { Question } from "./question.js";
import { FlowNode, LogicFlow, EmbeddedDataType } from "./flow.js";
import { QualityConfig } from "./quality.js";

/** Named display-logic rules that can target anything (requirement §6). */
export const DisplayRule = z.object({
  id: z.string(),
  label: z.string().optional(),
  target: z.object({
    kind: z.enum(["question", "page", "section", "block", "option", "row", "column"]),
    ref: z.string(), // question/page/... id
    subRef: z.string().optional(), // option code / row code / column id
  }),
  action: z.enum(["show", "hide"]).default("show"),
  when: Condition,
});
export type DisplayRule = z.infer<typeof DisplayRule>;

/** Calculation definitions (requirement §14). Expressions use the calc DSL:
 *  e.g. "Q1 + Q2 + Q3", "pct(SCORE, 200)", "countif(Q5_*, '>', 3)". */
export const Calculation = z.object({
  id: z.string(),
  targetVariable: z.string(),
  label: z.string().optional(),
  expression: z.string(),
  /** When to (re)compute. */
  trigger: z.enum(["on_change", "on_page_submit", "on_complete"]).default("on_page_submit"),
  when: Condition.optional(),
  dataType: z.enum(["numeric", "text", "boolean"]).default("numeric"),
  notes: z.string().optional(),
});
export type Calculation = z.infer<typeof Calculation>;

/** Quotas (requirement §15). */
export const QuotaCell = z.object({
  id: z.string(),
  label: z.string(),
  when: Condition,
  limit: z.number(),
  limitType: z.enum(["count", "percent"]).default("count"),
});

export const Quota = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(["hard", "soft"]).default("hard"),
  /** Multi-dimensional quotas: cells are the cross-cells (e.g. Male×18-24). */
  cells: z.array(QuotaCell),
  /** Base for percent limits. */
  targetTotal: z.number().optional(),
  onFull: z
    .object({
      kind: z.enum(["terminate", "redirect", "flag", "warn"]).default("terminate"),
      url: z.string().optional(),
      message: z.string().optional(),
    })
    .default({ kind: "terminate" }),
  countStatus: z.array(z.enum(["complete", "in_progress"])).default(["complete"]),
});
export type Quota = z.infer<typeof Quota>;

/** Custom scripts (requirement §13). Executed by the sandboxed script host. */
export const CustomScript = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["survey", "page", "question"]).default("survey"),
  ref: z.string().optional(), // page/question id when scoped
  event: z
    .enum(["on_load", "on_change", "on_submit", "on_validate", "on_complete"])
    .default("on_load"),
  code: z.string(),
  enabled: z.boolean().default(true),
  notes: z.string().optional(),
});
export type CustomScript = z.infer<typeof CustomScript>;

/** Branding / theming (requirement §19). */
export const Branding = z.object({
  themeId: z.string().optional(),
  logoUrl: z.string().optional(),
  logoPosition: z.enum(["left", "center", "right"]).default("left"),
  colors: z
    .object({
      primary: z.string().default("#2563eb"),
      secondary: z.string().default("#0f172a"),
      background: z.string().default("#f8fafc"),
      surface: z.string().default("#ffffff"),
      text: z.string().default("#0f172a"),
      subtleText: z.string().default("#64748b"),
      border: z.string().default("#e2e8f0"),
      error: z.string().default("#dc2626"),
    })
    .default({}),
  typography: z
    .object({
      fontFamily: z.string().default("Inter, system-ui, sans-serif"),
      baseSize: z.string().default("16px"),
      headingWeight: z.number().default(650),
    })
    .default({}),
  layout: z
    .object({
      maxWidth: z.string().default("760px"),
      cardStyle: z.enum(["flat", "card", "line"]).default("card"),
      radius: z.string().default("12px"),
      spacing: z.enum(["compact", "regular", "relaxed"]).default("regular"),
      progressBar: z.enum(["top", "bottom", "none"]).default("top"),
      progressStyle: z.enum(["bar", "steps", "percent"]).default("bar"),
      /**
       * Survey-wide default for whether block names reach respondents. `true`
       * keeps what every existing survey did; a block can override it either
       * way with its own `showTitle`.
       */
      showBlockTitles: z.boolean().default(true),
    })
    .default({}),
  buttons: z
    .object({
      style: z.enum(["solid", "outline", "pill"]).default("solid"),
      nextLabel: z.string().default("Next"),
      backLabel: z.string().default("Back"),
      submitLabel: z.string().default("Submit"),
      showBack: z.boolean().default(true),
    })
    .default({}),
  headerHtml: z.string().optional(),
  footerHtml: z.string().optional(),
  customCss: z.string().optional(),
  customJs: z.string().optional(),
});
export type Branding = z.infer<typeof Branding>;

/** Reference to a generated research design file (requirements §16–18). */
export const DesignReference = z.object({
  id: z.string(),
  kind: z.string(), // "conjoint" | "maxdiff" | custom generator key
  name: z.string(),
  version: z.number().default(1),
  seed: z.number().optional(),
  /** Generator configuration — shape owned by the generator plugin. */
  config: z.record(z.any()),
  /** Inline generated design (rows) or storage pointer. */
  file: z
    .object({
      format: z.enum(["json", "csv"]).default("json"),
      columns: z.array(z.string()).default([]),
      rows: z.array(z.record(z.any())).default([]),
      storagePath: z.string().optional(),
      generatedAt: z.string().optional(),
    })
    .optional(),
});
export type DesignReference = z.infer<typeof DesignReference>;

/** Variable dictionary entry (requirement §9) — generated, stored for export. */
export const VariableDef = z.object({
  name: z.string(),
  label: z.string(),
  questionId: z.string().optional(),
  questionCode: z.string().optional(),
  questionText: z.string().optional(),
  dataType: z.enum(["numeric", "text", "date", "time", "boolean"]),
  responseType: z.string(),
  valueCodes: z.array(z.union([z.string(), z.number()])).default([]),
  valueLabels: z.record(z.string()).default({}),
  pageId: z.string().optional(),
  sectionId: z.string().optional(),
  derived: z.boolean().default(false),
  hidden: z.boolean().default(false),
  sourceQuestion: z.string().optional(),
  rowCode: z.string().optional(),
  columnId: z.string().optional(),
  optionCode: z.string().optional(),
  notes: z.string().optional(),
});
export type VariableDef = z.infer<typeof VariableDef>;

export const DeploymentConfig = z.object({
  clientSlug: z.string().default("client"),
  studySlug: z.string().default("study-001"),
  customDomain: z.string().optional(),
  access: z
    .object({
      mode: z.enum(["open", "password", "unique_links", "invitation"]).default("open"),
      password: z.string().optional(),
      allowRetake: z.boolean().default(false),
      captureAnonymous: z.boolean().default(true),
    })
    .default({}),
  languages: z.array(z.string()).default(["en"]),
  activeFrom: z.string().optional(),
  activeUntil: z.string().optional(),
});
export type DeploymentConfig = z.infer<typeof DeploymentConfig>;

/**
 * THE survey definition — the single JSON document that fully describes a
 * survey (requirement §11 / §31). The runtime interprets exactly this.
 */
export const SurveyDefinition = z.object({
  meta: z.object({
    id: z.string(),
    code: z.string().default("SURVEY_001"),
    title: z.string(),
    description: z.string().optional(),
    version: z.string().default("1.0"),
    status: z.enum(["draft", "testing", "live", "closed"]).default("draft"),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    schemaVersion: z.literal(1).default(1),
  }),
  branding: Branding.default({}),
  questions: z.array(Question).default([]),
  flow: z.array(FlowNode).default([]),
  logicFlow: LogicFlow.default({ nodes: [], edges: [] }),
  displayRules: z.array(DisplayRule).default([]),
  calculations: z.array(Calculation).default([]),
  quotas: z.array(Quota).default([]),
  scripts: z.array(CustomScript).default([]),
  designs: z.array(DesignReference).default([]),
  /** Generated dictionary (kept in the JSON so exports reflect exact state). */
  variables: z.array(VariableDef).default([]),
  embeddedData: z
    .array(z.object({
      name: z.string(),
      label: z.string().optional(),
      source: z.string().optional(),
      /** Declared type; absent = string, which is the historical behaviour. */
      dataType: EmbeddedDataType.optional(),
      defaultValue: z.string().optional(),
    }))
    .default([]),
  deployment: DeploymentConfig.default({}),
  /** Response quality & fraud detection settings (`@rescript/quality`). */
  quality: QualityConfig.default({}),
  meta_extensions: z.record(z.any()).optional(),
});
export type SurveyDefinition = z.infer<typeof SurveyDefinition>;

export function parseSurvey(json: unknown): SurveyDefinition {
  return SurveyDefinition.parse(json);
}

export function safeParseSurvey(json: unknown) {
  return SurveyDefinition.safeParse(json);
}
