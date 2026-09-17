import type React from "react";
import type { Question, QuestionVariantDef } from "@rescript/schema";

/**
 * The Studio-side variant registry: per-option meta fields and per-renderer
 * settings blocks. Kept in its own module with NO imports of family files so a
 * family can register at load without hitting a half-initialised map.
 */

export interface MetaField {
  key: string;
  label: string;
  placeholder?: string;
  width?: number;
  /**
   * "text" (default) | "number" | "check" | "icon"
   *
   * `icon` is a text box with a picker beside it. The review found the Icon
   * Select's icon field to be a bare text input with no hint of what belongs
   * in it and no way to browse, sitting next to an Image URL that silently
   * overrode it.
   */
  kind?: "text" | "number" | "check" | "icon";
}

export interface VariantSettingsProps {
  q: Question;
  v: QuestionVariantDef | undefined;
  patch(p: Partial<Question>): void;
  patchSettings(p: Partial<Question["settings"]>): void;
}
export type SettingsBlock = (p: VariantSettingsProps) => React.ReactNode;

export const DESC: MetaField = { key: "description", label: "description", placeholder: "secondary line", width: 200 };
export const BADGE: MetaField = { key: "badge", label: "badge", placeholder: "e.g. Popular", width: 100 };
export const PRICE: MetaField = { key: "price", label: "price", placeholder: "$ 9.99", width: 90 };
export const META_PRESETS = { DESC, BADGE, PRICE };

export const OPTION_META_FIELDS: Record<string, MetaField[]> = {};
export const VARIANT_SETTINGS: Record<string, SettingsBlock> = {};

export function registerOptionMetaFields(rendererKey: string, fields: MetaField[]): void {
  OPTION_META_FIELDS[rendererKey] = fields;
}
export function registerVariantSettings(rendererKey: string, block: SettingsBlock): void {
  VARIANT_SETTINGS[rendererKey] = block;
}
