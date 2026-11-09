/**
 * Generic custom design generator.
 *
 * Lets programmers define arbitrary design files column by column:
 *   - sequence      1..rows per version
 *   - random_int    uniform integer in [min, max]
 *   - random_level  frequency-balanced pick from a fixed level list
 *   - constant      a fixed value
 *   - block         ceil(rowIndex / blockSize)
 *   - expression    free-text passthrough (stored verbatim so downstream
 *                   tooling / scripts can evaluate it)
 *
 * Deterministic given (config, seed).
 */
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { mulberry32, subSeed } from "@rescript/engine";

export type CustomColumnKind =
  | "sequence"
  | "random_int"
  | "random_level"
  | "constant"
  | "block"
  | "expression";

export interface CustomColumnSpec {
  name: string;
  kind: CustomColumnKind;
  min?: number;
  max?: number;
  levels?: string[];
  value?: unknown;
  blockSize?: number;
  /** For kind "expression": free text passed through verbatim. */
  expression?: string;
}

export interface CustomDesignConfig {
  rows: number;
  columnsSpec: CustomColumnSpec[];
  versions?: number;
}

/**
 * A column written as one line (2026-11-09, so the Studio's list field can edit it):
 *   "Cell: random_level A | B | C"   "Score: random_int 1-5"   "Row: sequence"   "Wave: constant 3"
 *   "Block: block 4"                  "Note: expression Q1 + 1"
 * Objects pass through unchanged.
 */
export function readColumnSpec(x: unknown): CustomColumnSpec {
  if (x && typeof x === "object") return x as CustomColumnSpec;
  const m = /^\s*([^:]+?)\s*:\s*(sequence|random_int|random_level|constant|block|expression)\b\s*(.*)$/i.exec(String(x ?? ""));
  if (!m) return { name: String(x ?? "").trim(), kind: "unknown" as CustomColumnKind };
  const [, name, kind, rest] = m;
  const k = kind.toLowerCase() as CustomColumnKind;
  if (k === "random_int") { const r = /(-?\d+)\s*(?:-|to|\.\.)\s*(-?\d+)/.exec(rest); return { name, kind: k, ...(r ? { min: Number(r[1]), max: Number(r[2]) } : {}) }; }
  if (k === "random_level") return { name, kind: k, levels: rest.split(/[|,]/).map((v) => v.trim()).filter(Boolean) };
  if (k === "constant") return { name, kind: k, value: rest.trim() === "" ? undefined : /^-?\d+(?:\.\d+)?$/.test(rest.trim()) ? Number(rest.trim()) : rest.trim() };
  if (k === "block") return { name, kind: k, blockSize: Number(rest.trim()) || undefined };
  if (k === "expression") return { name, kind: k, expression: rest.trim() };
  return { name, kind: k };
}

export const customPlugin: DesignGeneratorPlugin<CustomDesignConfig> = {
  kind: "custom",
  label: "Design file from columns (advanced)",
  description:
    "Free-form design file: sequences, random integers, frequency-balanced level picks, constants, blocks, and free-text expression columns.",
  configFields: [
    { name: "rows", label: "Rows per version", type: "number", default: 100 },
    {
      name: "columnsSpec",
      label: "Columns",
      type: "list",
      help: "One column per line — “Name: random_level A | B | C”, “Name: random_int 1-5”, “Name: sequence”, “Name: constant 3”, “Name: block 4”, “Name: expression …”. For a real experimental design use Custom experimental design.",
    },
    {
      name: "versions",
      label: "Versions",
      type: "number",
      default: 1,
    },
  ],

  validateConfig(config: CustomDesignConfig): string[] {
    const errors: string[] = [];
    const rows = config.rows ?? 0;
    const specs = (config.columnsSpec ?? []).map(readColumnSpec);
    if (rows < 1) errors.push("rows must be at least 1.");
    if (specs.length < 1) errors.push("At least one column is required.");
    const names = specs.map((s) => s.name);
    if (new Set(names).size !== names.length) {
      errors.push("Column names must be unique.");
    }
    for (const spec of specs) {
      if (!spec.name) errors.push("Every column needs a name.");
      switch (spec.kind) {
        case "random_int":
          if (typeof spec.min !== "number" || typeof spec.max !== "number") {
            errors.push(`Column "${spec.name}": random_int needs min and max.`);
          } else if (spec.min > spec.max) {
            errors.push(`Column "${spec.name}": min must be <= max.`);
          }
          break;
        case "random_level":
          if (!spec.levels || spec.levels.length < 1) {
            errors.push(
              `Column "${spec.name}": random_level needs at least one level.`,
            );
          }
          break;
        case "constant":
          if (spec.value === undefined) {
            errors.push(`Column "${spec.name}": constant needs a value.`);
          }
          break;
        case "block":
          if (typeof spec.blockSize !== "number" || spec.blockSize < 1) {
            errors.push(`Column "${spec.name}": block needs blockSize >= 1.`);
          }
          break;
        case "sequence":
        case "expression":
          break;
        default:
          errors.push(
            `Column "${spec.name}": unknown kind "${String(spec.kind)}".`,
          );
      }
    }
    if ((config.versions ?? 1) < 1) errors.push("versions must be at least 1.");
    return errors;
  },

  generate(config: CustomDesignConfig, seed: number) {
    const rowsPerVersion = config.rows;
    const specs = (config.columnsSpec ?? []).map(readColumnSpec);
    const versions = config.versions ?? 1;
    const columns = ["version", "row", ...specs.map((s) => s.name)];
    const rows: Record<string, unknown>[] = [];

    // One RNG per random column so column values are independent of one
    // another and of row/column ordering elsewhere.
    const rngs = new Map<string, () => number>();
    // Frequency-balancing counts for random_level columns.
    const levelCounts = new Map<string, Map<string, number>>();
    for (const spec of specs) {
      if (spec.kind === "random_int" || spec.kind === "random_level") {
        rngs.set(spec.name, mulberry32(subSeed(seed, `custom:${spec.name}`)));
      }
      if (spec.kind === "random_level") {
        levelCounts.set(
          spec.name,
          new Map((spec.levels ?? []).map((l) => [l, 0])),
        );
      }
    }

    for (let version = 1; version <= versions; version++) {
      for (let row = 1; row <= rowsPerVersion; row++) {
        const record: Record<string, unknown> = { version, row };
        for (const spec of specs) {
          switch (spec.kind) {
            case "sequence":
              record[spec.name] = row;
              break;
            case "random_int": {
              const rng = rngs.get(spec.name)!;
              const min = spec.min ?? 0;
              const max = spec.max ?? 0;
              record[spec.name] = min + Math.floor(rng() * (max - min + 1));
              break;
            }
            case "random_level": {
              const rng = rngs.get(spec.name)!;
              const counts = levelCounts.get(spec.name)!;
              const levels = spec.levels ?? [];
              let min = Infinity;
              for (const l of levels) {
                const c = counts.get(l) ?? 0;
                if (c < min) min = c;
              }
              const tied = levels.filter((l) => (counts.get(l) ?? 0) === min);
              const pick = tied[Math.floor(rng() * tied.length)];
              counts.set(pick, (counts.get(pick) ?? 0) + 1);
              record[spec.name] = pick;
              break;
            }
            case "constant":
              record[spec.name] = spec.value;
              break;
            case "block":
              record[spec.name] = Math.ceil(row / (spec.blockSize ?? 1));
              break;
            case "expression":
              record[spec.name] = spec.expression ?? spec.value ?? "";
              break;
          }
        }
        rows.push(record);
      }
    }

    const levelSummary: Record<string, Record<string, number>> = {};
    for (const [name, counts] of levelCounts) {
      levelSummary[name] = Object.fromEntries(counts);
    }

    return {
      columns,
      rows,
      summary: {
        rowsPerVersion,
        versions,
        totalRows: rows.length,
        levelCounts: levelSummary,
      },
    };
  },
};
