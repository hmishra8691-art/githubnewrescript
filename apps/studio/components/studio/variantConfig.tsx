"use client";
import React from "react";
import type { Question, QuestionVariantDef } from "@rescript/schema";

/**
 * Variant-specific authoring, kept out of the (already large) question editor.
 *
 * Two hooks into the editor:
 *   - `optionMetaFields(variant)` — extra per-option inputs, written to
 *     `option.meta.<key>`, for renderers that draw more than a label.
 *   - `<VariantSettings>` — a settings block for renderers that need one
 *     (media URL, time limit, arms, …). Families add a case here.
 *
 * Neither changes what is stored for existing questions: a variant that
 * declares nothing gets exactly the editor it had.
 */

export interface MetaField {
  key: string;
  label: string;
  placeholder?: string;
  width?: number;
  /** "text" (default) | "number" | "check" */
  kind?: "text" | "number" | "check";
}

const DESC: MetaField = { key: "description", label: "description", placeholder: "secondary line", width: 200 };
const BADGE: MetaField = { key: "badge", label: "badge", placeholder: "e.g. Popular", width: 100 };
const PRICE: MetaField = { key: "price", label: "price", placeholder: "$ 9.99", width: 90 };

const OPTION_META_FIELDS: Record<string, MetaField[]> = {
  icons: [{ key: "icon", label: "icon", placeholder: "emoji / short text", width: 110 }],
  listrows: [DESC, BADGE, PRICE],
  richcards: [{ key: "subtitle", label: "subtitle", placeholder: "subtitle", width: 130 }, DESC, PRICE, BADGE],
  pairwise: [DESC],
  multicarousel: [DESC],
  // pre-existing renderers already read meta.description; expose it
  cards: [DESC],
  carousel: [DESC],
  compare: [DESC],
};

export function optionMetaFields(v: QuestionVariantDef | undefined): MetaField[] {
  if (!v?.renderer) return [];
  return OPTION_META_FIELDS[v.renderer] ?? [];
}

/* ------------------------------------------------------- settings blocks */

export interface VariantSettingsProps {
  q: Question;
  v: QuestionVariantDef | undefined;
  patch(p: Partial<Question>): void;
  patchSettings(p: Partial<Question["settings"]>): void;
}

/**
 * Renderer-keyed settings. Returns null for renderers with nothing extra, so
 * the editor can always mount it.
 */
export function VariantSettings({ q, v, patch, patchSettings }: VariantSettingsProps): React.ReactElement | null {
  const key = v?.renderer ?? `base:${q.type}`;
  const block = VARIANT_SETTINGS[key] ?? VARIANT_SETTINGS[`base:${q.type}`];
  if (!block) return null;
  return <div className="variant-settings" data-testid={`variant-settings-${key.replace(":", "-")}`}>{block({ q, v, patch, patchSettings })}</div>;
}

type Block = (p: VariantSettingsProps) => React.ReactNode;

const VARIANT_SETTINGS: Record<string, Block> = {
  pairwise: ({ q }) =>
    q.options.length !== 2 ? (
      <div className="chip warn" data-testid="pairwise-count">
        A pairwise choice shows exactly two options — this one has {q.options.length}. Only the first two will be offered.
      </div>
    ) : null,
};

/** Families register their settings blocks here. */
export function registerVariantSettings(key: string, block: Block): void {
  VARIANT_SETTINGS[key] = block;
}
