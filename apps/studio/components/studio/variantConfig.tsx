"use client";
import React from "react";
import type { Question, QuestionVariantDef } from "@rescript/schema";
import {
  OPTION_META_FIELDS, VARIANT_SETTINGS, registerOptionMetaFields, registerVariantSettings,
  DESC, BADGE, PRICE, type MetaField, type VariantSettingsProps,
} from "./variantConfig/registry";

/**
 * Variant-specific authoring, kept out of the (already large) question editor.
 *
 * Two hooks into the editor:
 *   - `optionMetaFields(variant)` — extra per-option inputs, written to
 *     `option.meta.<key>`, for renderers that draw more than a label.
 *   - `<VariantSettings>` — a settings block for renderers that need one
 *     (media URL, time limit, arms, …).
 *
 * Families register both from `./variantConfig/<family>.tsx`, imported at the
 * bottom of this file. The store itself lives in `./variantConfig/registry`
 * so those files can register at load without a circular import.
 *
 * A variant that declares nothing gets exactly the editor it had.
 */

export type { MetaField, VariantSettingsProps };
export { registerOptionMetaFields, registerVariantSettings };

// the Single / Multi Select batch, and pre-existing renderers that already read meta.description
registerOptionMetaFields("icons", [{ key: "icon", label: "icon", placeholder: "emoji / short text", width: 110 }]);
registerOptionMetaFields("listrows", [DESC, BADGE, PRICE]);
registerOptionMetaFields("richcards", [{ key: "subtitle", label: "subtitle", placeholder: "subtitle", width: 130 }, DESC, PRICE, BADGE]);
registerOptionMetaFields("pairwise", [DESC]);
registerOptionMetaFields("multicarousel", [DESC]);
registerOptionMetaFields("cards", [DESC]);
registerOptionMetaFields("carousel", [DESC]);
registerOptionMetaFields("compare", [DESC]);

registerVariantSettings("pairwise", ({ q }) =>
  q.options.length !== 2 ? (
    <div className="chip warn" data-testid="pairwise-count">
      A pairwise choice shows exactly two options — this one has {q.options.length}. Only the first two will be offered.
    </div>
  ) : null,
);

export function optionMetaFields(v: QuestionVariantDef | undefined): MetaField[] {
  if (!v?.renderer) return [];
  return OPTION_META_FIELDS[v.renderer] ?? [];
}

/**
 * Renderer-keyed settings. Returns null for renderers with nothing extra, so
 * the editor can always mount it.
 */
export function VariantSettings({ q, v, patch, patchSettings }: VariantSettingsProps): React.ReactElement | null {
  const key = v?.renderer ?? `base:${q.type}`;
  const block = VARIANT_SETTINGS[key] ?? VARIANT_SETTINGS[`base:${q.type}`];
  if (!block) return null;
  return (
    <div className="variant-settings" data-testid={`variant-settings-${key.replace(":", "-")}`}>
      {block({ q, v, patch, patchSettings })}
    </div>
  );
}

/* one import per family — each registers its own settings blocks and meta fields */
import "./variantConfig/text";
import "./variantConfig/numeric";
import "./variantConfig/list";
import "./variantConfig/matrix";
import "./variantConfig/ranking";
import "./variantConfig/slider";
import "./variantConfig/image";
import "./variantConfig/media";
import "./variantConfig/dragdrop";
import "./variantConfig/swipe";
import "./variantConfig/carousel";
import "./variantConfig/card";
import "./variantConfig/comparison";
import "./variantConfig/allocation";
import "./variantConfig/hotspot";
import "./variantConfig/datetime";
import "./variantConfig/upload";
import "./variantConfig/form";
import "./variantConfig/dynamic";
import "./variantConfig/gamified";
import "./variantConfig/experimental";
import "./variantConfig/conversational";
