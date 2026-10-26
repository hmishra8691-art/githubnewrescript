/**
 * @rescript/designs — built-in design generator plugins.
 *
 * Registers conjoint, maxdiff, menu (MBC), acbc, cva (rating-based conjoint) and custom generators into the shared
 * designGeneratorRegistry from @rescript/schema at module load.
 */
import { designGeneratorRegistry } from "@rescript/schema";
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { conjointPlugin } from "./conjoint.js";
import { maxdiffPlugin } from "./maxdiff.js";
import { customPlugin } from "./custom.js";
import { menuPlugin } from "./menu.js";
import { acbcPlugin } from "./acbc.js";
import { cvaPlugin } from "./cva.js";
import { inspectConjointDesign, inspectMaxDiffDesign } from "./quality.js";

export * from "./conjoint.js";
export * from "./conjointEfficiency.js";
export * from "./maxdiff.js";
export * from "./custom.js";
export * from "./menu.js";
export * from "./acbc.js";
export * from "./cva.js";
export * from "./conjointAltSpecific.js";
export * from "./export.js";
export * from "./diagnostics.js";
export * from "./quality.js";

/** Register all built-in design generators (idempotent). */
export function registerBuiltinDesignGenerators(): void {
  const plugins = [
    conjointPlugin,
    maxdiffPlugin,
    customPlugin,
    menuPlugin,
    acbcPlugin,
    cvaPlugin,
  ] as unknown as DesignGeneratorPlugin[];
  /*
   * The publish gate asks the registry whether a stored design is sound
   * (schema `DesignGeneratorPlugin.inspect`). Attached here rather than on
   * each plugin object so the rule sits with the other registration, and so
   * a generator without one simply contributes no design rules.
   *
   * ACBC and CVA deliberately have none yet: an ACBC design is built per
   * respondent from their own BYO answers, so there are no fixed rows to
   * measure before fielding, and CVA is rating-based with no choice sets to
   * balance. Saying nothing is honest; inventing a verdict would not be.
   */
  const inspectors: Record<string, (d: Parameters<NonNullable<DesignGeneratorPlugin["inspect"]>>[0]) => ReturnType<NonNullable<DesignGeneratorPlugin["inspect"]>>> = {
    conjoint: inspectConjointDesign,
    menu: inspectConjointDesign,
    maxdiff: inspectMaxDiffDesign,
  };
  for (const plugin of plugins) {
    const inspect = inspectors[plugin.kind];
    if (inspect && !plugin.inspect) (plugin as DesignGeneratorPlugin).inspect = inspect;
    if (!designGeneratorRegistry.has(plugin.kind)) {
      designGeneratorRegistry.register(plugin);
    }
  }
}

// Register at module load so importing the package is enough.
registerBuiltinDesignGenerators();
