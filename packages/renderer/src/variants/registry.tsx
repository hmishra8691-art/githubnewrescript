import type React from "react";
import type { QRProps } from "../QuestionRenderer";

/**
 * Renderer registry for the variant families.
 *
 * `QuestionRenderer` consults this before its own switch: a variant's
 * `renderer` key, or `base:<type>` for a base type that has no variant stored
 * (a legacy question, or one built from JSON). Each family file registers
 * what it implements at module load, so the core dispatcher never changes.
 */
export const variantRenderers: Record<string, React.ComponentType<QRProps>> = {};

export function registerVariantRenderer(key: string, component: React.ComponentType<QRProps>): void {
  if (variantRenderers[key] && variantRenderers[key] !== component) {
    // two families claiming one key is a programming error worth hearing about
    console.warn(`variant renderer "${key}" registered twice`);
  }
  variantRenderers[key] = component;
}
