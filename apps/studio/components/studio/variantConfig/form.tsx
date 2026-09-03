"use client";
import { registerVariantSettings } from "./registry";
import { RepeatBounds } from "./list";

/**
 * Studio authoring for the form family — see docs/VARIANT-BATCH.md §4.
 *
 * The Repeating Form is bounded by the same two settings as the Dynamic
 * List, so it shares that block rather than growing a second one that could
 * drift from it.
 *
 * The Conditional Form registers nothing on purpose: it is an ordinary field
 * list, and the feature — a per-field Show-when condition — belongs to the
 * field, not to the question. Its `instruction` says where to set it.
 */
registerVariantSettings("repeatform", RepeatBounds);
