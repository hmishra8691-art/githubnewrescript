import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUESTION_VARIANTS, isSelectableVariant, resolveVariant, variantRegistry,
} from "./index.js";

/**
 * THE REGISTRY'S INVARIANTS (question taxonomy audit, 2026-09-10).
 *
 * The audit found ELEVEN pairs of variants that were the same base type and
 * the same renderer under two names in two families — "Image Ranking" existed
 * twice under the identical label. The cause was one field doing two jobs:
 * `family` sometimes named what a question collects and sometimes how it is
 * drawn, so a question that was both got filed twice.
 *
 * Retiring the duplicates is eleven `supersededBy` lines. What stops them
 * coming back is this file. A registry that can be extended by anybody needs
 * its rules written down where a failing build will state them.
 */

const selectable = QUESTION_VARIANTS.filter(isSelectableVariant);
/** the variants that claim an identity of their own — presets borrow their parent's */
const types = selectable.filter((v) => !v.presetOf);
const presets = selectable.filter((v) => v.presetOf);
const identity = (v: { baseType: string; renderer?: string; responseModel: string }) =>
  `${v.baseType} · ${v.renderer ?? "(base)"} · ${v.responseModel}`;

test("NO TWO SELECTABLE VARIANTS SHARE A BASE TYPE, RENDERER AND RESPONSE MODEL", () => {
  /*
   * Same baseType + renderer + responseModel = the same question, drawn the same
   * way, collecting the same shape of answer. Two
   * of those are one variant with two names, and a programmer browsing the
   * picker sees the duplicate before they see anything else. Anything that
   * legitimately differs — a validation preset, starter labels, a default
   * layout — is CONFIGURATION on one variant, not a second variant.
   */
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const v of types) {
    const key = identity(v);
    const prior = seen.get(key);
    if (prior) collisions.push(`${key}: ${prior} and ${v.id}`);
    else seen.set(key, v.id);
  }
  assert.deepEqual(collisions, [], `duplicate variants:\n  ${collisions.join("\n  ")}`);
});

test("A PRESET IS ITS PARENT WITH DIFFERENT DEFAULTS — never a type in disguise", () => {
  /*
   * The whole point of `presetOf` is that a preset borrows its parent's
   * identity. If one could differ in base type, renderer or response model it
   * would be a separate question wearing a preset's label — exactly the
   * confusion the audit was clearing up, reintroduced through a side door.
   */
  assert.ok(presets.length >= 22, `expected the audit's presets to be registered, saw ${presets.length}`);
  for (const v of presets) {
    const parent = variantRegistry.get(v.presetOf!);
    assert.ok(parent, `${v.id} is a preset of ${v.presetOf}, which does not exist`);
    assert.ok(isSelectableVariant(parent!) && !parent!.presetOf,
      `${v.id} → ${parent!.id}, which must be a live, non-preset variant`);
    assert.equal(identity(v), identity(parent!),
      `${v.id} claims to be a preset of ${parent!.id} but differs in identity:\n    ${identity(v)}\n    ${identity(parent!)}`);
    /*
     * A preset PICKS DEFAULTS. It may not unlock a capability or a validator its
     * parent lacks — if it could, choosing the preset would let a programmer do
     * something the type itself cannot, which makes it a type. The parent
     * declares everything configurable; the preset chooses a starting point.
     */
    const pc = new Set(parent!.capabilities), pv = new Set(parent!.validations);
    const extraC = (v.capabilities ?? []).filter((c) => !pc.has(c));
    const extraV = (v.validations ?? []).filter((c) => !pv.has(c));
    assert.deepEqual(extraC, [], `${v.id} unlocks capabilities its parent ${parent!.id} lacks: ${extraC.join(", ")} — add them to the parent`);
    assert.deepEqual(extraV, [], `${v.id} unlocks validators its parent ${parent!.id} lacks: ${extraV.join(", ")} — add them to the parent`);
    assert.ok(v.defaults, `${v.id} has no defaults — nothing distinguishes it from ${parent!.id}, so it is a duplicate to retire, not a preset`);
  }
});

test("EVERY RETIRED VARIANT STILL RESOLVES, and to something selectable", () => {
  /*
   * Retirement must be invisible to a survey in field. A stored id keeps
   * resolving — to a variant that is itself live, so the chain cannot dead-end
   * on something that was retired later.
   */
  const retired = QUESTION_VARIANTS.filter((v) => v.supersededBy);
  assert.ok(retired.length >= 19, `expected the 7 earlier + 12 new retirements, saw ${retired.length}`);
  for (const v of retired) {
    const target = resolveVariant(v.id);
    assert.ok(target, `${v.id} → nothing`);
    assert.notEqual(target!.id, v.id, `${v.id} points at itself`);
    assert.ok(isSelectableVariant(target!), `${v.id} → ${target!.id}, which is not selectable`);
  }
});

test("A RETIREMENT NEVER CHANGES WHAT A STORED ANSWER MEANS", () => {
  /*
   * The one property that makes retirement safe: the survivor collects the
   * same shape of data as the variant it replaces. Same responseModel means
   * the response rows, exports, logic references and analytics that were
   * written against the old id read identically against the new one.
   */
  for (const v of QUESTION_VARIANTS.filter((x) => x.supersededBy)) {
    const target = resolveVariant(v.id)!;
    assert.equal(target.responseModel, v.responseModel,
      `${v.id} (${v.responseModel}) → ${target.id} (${target.responseModel}) changes the response model`);
    assert.equal(target.baseType, v.baseType,
      `${v.id} → ${target.id} changes the base type`);
  }
});

test("THE TEN CROSS-FAMILY DUPLICATES RETIRED IN THE TAXONOMY AUDIT resolve to their named survivors", () => {
  const expected: Record<string, string> = {
    "image.ranking": "ranking.image",
    "dragdrop.ranking": "ranking.drag",
    "conjoint.maxdiff": "ranking.best_worst",
    "comparison.tournament": "ranking.tournament",
    "slider.allocation_slider": "allocation.slider_allocation",
    "dragdrop.allocation": "allocation.drag",
    "image.hotspot": "hotspot.click",
    "image.comparison": "comparison.side_by_side",
    "card.rich": "single_select.product_choice",
    // found by this test on its first run — byte-identical to its parent
    "multi_select.searchable": "multi_select.dropdown",
  };
  for (const [from, to] of Object.entries(expected)) {
    assert.ok(variantRegistry.get(from), `${from} must stay registered — surveys store it`);
    assert.equal(resolveVariant(from)?.id, to);
    assert.ok(!isSelectableVariant(variantRegistry.get(from)!), `${from} must be hidden from the picker`);
  }
});

test("every selectable variant has a renderer or is a bare base type — never both missing", () => {
  for (const v of selectable) {
    assert.ok(v.baseType, `${v.id} has no baseType`);
    assert.ok(v.responseModel, `${v.id} has no responseModel`);
  }
});
