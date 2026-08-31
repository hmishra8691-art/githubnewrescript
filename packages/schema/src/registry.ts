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
    type: "number" | "text" | "boolean" | "select" | "list" | "attributes";
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
