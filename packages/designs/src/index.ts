/**
 * @rescript/designs — built-in design generator plugins.
 *
 * Registers conjoint, maxdiff and custom generators into the shared
 * designGeneratorRegistry from @rescript/schema at module load.
 */
import { designGeneratorRegistry } from "@rescript/schema";
import type { DesignGeneratorPlugin } from "@rescript/schema";
import { conjointPlugin } from "./conjoint.js";
import { maxdiffPlugin } from "./maxdiff.js";
import { customPlugin } from "./custom.js";

export * from "./conjoint.js";
export * from "./maxdiff.js";
export * from "./custom.js";
export * from "./export.js";

/** Register all built-in design generators (idempotent). */
export function registerBuiltinDesignGenerators(): void {
  const plugins = [
    conjointPlugin,
    maxdiffPlugin,
    customPlugin,
  ] as unknown as DesignGeneratorPlugin[];
  for (const plugin of plugins) {
    if (!designGeneratorRegistry.has(plugin.kind)) {
      designGeneratorRegistry.register(plugin);
    }
  }
}

// Register at module load so importing the package is enough.
registerBuiltinDesignGenerators();
