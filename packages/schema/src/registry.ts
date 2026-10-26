/**
 * Plugin registries (requirement §30).
 *
 * The platform is extended — never rewritten — by registering:
 *   - question type plugins  (new question kinds + renderers + variable mappers)
 *   - design generator plugins (conjoint, maxdiff, TURF, pricing, …)
 *   - export plugins
 *   - theme plugins
 *
 * The runtime and Studio both consult these registries, so adding a plugin
 * makes it available end-to-end without touching the core engine.
 */
import type { Question, Option } from "./question.js";
import type { VariableDef, DesignReference } from "./survey.js";

export interface QuestionTypePlugin {
  /** Unique type key, e.g. "heatmap_click". */
  type: string;
  label: string;
  category: "choice" | "text" | "numeric" | "matrix" | "media" | "special" | "custom";
  /** Which structural features the editor should expose. */
  features: {
    options?: boolean;
    rows?: boolean;
    columns?: boolean;
    numericBounds?: boolean;
    sum?: boolean;
    design?: boolean;
  };
  /** Produce the dictionary variables for a configured question. */
  variables(q: Question): VariableDef[];
  /** Default configuration when the programmer inserts one. */
  create(partial?: Partial<Question>): Question;
  /** Validate an answer value; return error messages. */
  validateAnswer?(q: Question, value: unknown): string[];
}

export interface DesignGeneratorPlugin<C = Record<string, unknown>> {
  kind: string; // "conjoint" | "maxdiff" | "custom" | future...
  label: string;
  description?: string;
  /** JSON-schema-ish field descriptors so the Studio can render a config form. */
  configFields: {
    name: string;
    label: string;
    /**
     * How the Studio edits this field. `prohibitions` is a pairs editor over
     * the design's own attributes and levels — it exists because a
     * constraint cannot be expressed as a number, a list or a piece of text,
     * and a plugin interface with no way to say "these two may not co-occur"
     * is why no generator in the platform had prohibitions.
     */
    /* `itemPairs` (MaxDiff): pairs of entries from the `items` list that may never share a task */
    type: "number" | "text" | "boolean" | "select" | "list" | "attributes" | "prohibitions" | "itemPairs";
    default?: unknown;
    options?: string[];
    help?: string;
  }[];
  /** Deterministic generation from config + seed. */
  generate(config: C, seed: number): {
    columns: string[];
    rows: Record<string, unknown>[];
    summary?: Record<string, unknown>;
  };
  validateConfig?(config: C): string[];
  /**
   * WHETHER A GENERATED DESIGN IS SOUND, measured on the rows the survey
   * actually holds (2026-10-26).
   *
   * The generators have always measured this — `measureMaxDiffDesign` and
   * `measureConjointDesign` read the rows themselves, and the Studio's
   * Designs panel shows the numbers. Nothing ever stopped an unsound design
   * being fielded: the publish gate only checked that a question's
   * `designRef` pointed at a design the survey holds, not that the design
   * was any good. A MaxDiff with an item nobody is ever shown, or a CBC
   * whose rows break the researcher's own prohibitions, passed and went to
   * field, and surfaced as unusable utilities after the sample was paid for.
   *
   * This is the seam that fixes it. The engine's `runQualityCheck` asks the
   * registry, so the rule lives with the generator that owns the method and
   * the engine never imports `@rescript/designs` (dependency-boundaries R3).
   * A plugin that does not implement it contributes no design rules, exactly
   * as before.
   *
   * `level` is a judgement about the STUDY, not about tidiness:
   *   "error"    no amount of sample can rescue this — an item or level that
   *              is never shown has no utility to estimate, and rows that
   *              break a prohibition are not the design the researcher asked
   *              for. These refuse a publish.
   *   "warning"  the design is usable and imperfect: show-count spread,
   *              pair co-occurrence, positional skew, efficiency. Said with
   *              the real numbers so the researcher can judge, never
   *              blocking — a gate people learn to override is not a gate.
   */
  inspect?(design: DesignReference): DesignQualityIssue[];
}

/** One thing worth saying about a stored design, in the publish gate's terms. */
export interface DesignQualityIssue {
  level: "error" | "warning";
  /** the researcher's sentence; carries the measured numbers, never a code */
  message: string;
}

export interface ExportPlugin {
  key: string;
  label: string;
  extension: string;
  mimeType: string;
}

export class Registry<T extends { [k: string]: any }> {
  private items = new Map<string, T>();
  constructor(private keyField: keyof T) {}
  register(item: T): void {
    this.items.set(String(item[this.keyField]), item);
  }
  get(key: string): T | undefined {
    return this.items.get(key);
  }
  all(): T[] {
    return [...this.items.values()];
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
}

export const questionTypeRegistry = new Registry<QuestionTypePlugin>("type");
export const designGeneratorRegistry = new Registry<DesignGeneratorPlugin>("kind");
export const exportRegistry = new Registry<ExportPlugin>("key");

export type { DesignReference };
