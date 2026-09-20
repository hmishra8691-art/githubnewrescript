import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUESTION_VARIANTS } from "./variants.js";

/*
 * R5's GAP — A DECLARED CAPABILITY THAT NOTHING DRAWS.
 *
 * `other_specify` is declared here, in the variant registry, and honoured
 * over in @rescript/renderer. R5 itself was the bug where those two
 * disagreed: 20-odd variants declared the capability, the validator demanded
 * text for it, and no box was ever drawn — so a respondent who picked
 * "Other" was told "Please specify", given nowhere to do so, and could go
 * neither forward nor back. A dead-end interview.
 *
 * R5 was fixed centrally and well: `QuestionRenderer` draws the box for every
 * variant that does not draw its own, and `rendersOwnOtherBox` is the single
 * place that says which those are. What was still missing is the thing that
 * stops it happening again — nothing asserted that the SET and the COMPONENTS
 * agree. Add a variant with renderer "buttons" and delete the box out of
 * `ChoiceButtons`, and every test in the repository still passes while the
 * dead end is back.
 *
 * So this is a parity test, in the shape of `namingParity.test.ts`: the claim
 * lives here, the behaviour lives there, and the two are checked against each
 * other rather than assumed to match. It reads the renderer's SOURCE because
 * @rescript/renderer is typecheck-only — it is never built to `dist`, so
 * there is nothing to import. Reading the source is the coarser instrument,
 * and it is the one that exists.
 *
 * It catches the two failures that matter and are opposites of each other:
 *
 *   NO BOX  — a renderer that claims its own box and does not draw one; the
 *             respondent is trapped exactly as in R5.
 *   TWO BOXES — a renderer that draws a box without claiming it, so the
 *             central fallback draws a second one underneath. Both bind to
 *             the same key, so the respondent sees the same text twice in
 *             two inputs and cannot tell which one counts.
 */

function rendererDir(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = join(d, "packages", "renderer", "src");
    if (existsSync(p)) return p;
    d = dirname(d);
  }
  throw new Error("could not find packages/renderer/src from " + import.meta.url);
}

const DIR = rendererDir();
const DISPATCHER = readFileSync(join(DIR, "QuestionRenderer.tsx"), "utf8");

/** The renderer keys `rendersOwnOtherBox` claims draw their own box. */
function claimedRenderers(): Set<string> {
  const m = /const OWN_OTHER_BOX_RENDERERS = new Set\(\[([^\]]*)\]\)/.exec(DISPATCHER);
  assert.ok(m, "OWN_OTHER_BOX_RENDERERS is gone from QuestionRenderer.tsx — this test needs rewriting, not deleting");
  return new Set([...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

/** The base TYPES it claims draw their own box (for variants with no renderer key). */
function claimedTypes(): Set<string> {
  const m = /const OWN_OTHER_BOX_TYPES = new Set\(\[([^\]]*)\]\)/.exec(DISPATCHER);
  assert.ok(m, "OWN_OTHER_BOX_TYPES is gone from QuestionRenderer.tsx");
  return new Set([...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

/**
 * Every source file a renderer could live in: the dispatcher itself (the
 * older renderers are components in that file) plus every family module.
 */
function sources(): { name: string; text: string }[] {
  const out = [{ name: "QuestionRenderer.tsx", text: DISPATCHER }];
  const vdir = join(DIR, "variants");
  for (const f of readdirSync(vdir)) {
    if (f.endsWith(".tsx")) out.push({ name: `variants/${f}`, text: readFileSync(join(vdir, f), "utf8") });
  }
  return out;
}

/** Does anything anywhere register or dispatch this renderer key? */
function componentFor(key: string): { name: string; text: string } | null {
  for (const s of sources()) {
    if (new RegExp(`registerVariantRenderer\\(\\s*["'\`]${key}["'\`]`).test(s.text)) return s;
  }
  /* the older shape: a `case "key":` arm in the dispatcher's switch */
  if (new RegExp(`case\\s+["'\`]${key}["'\`]\\s*:`).test(DISPATCHER)) {
    return { name: "QuestionRenderer.tsx", text: DISPATCHER };
  }
  return null;
}

/**
 * Does this source draw an "Other, specify" box?
 *
 * Both spellings count: `OtherInput` is the input itself, `OtherSpecifyBox`
 * the labelled wrapper around it. The central `OtherSpecifyFallback` does
 * NOT count — that is the dispatcher drawing it, which is the opposite of a
 * variant drawing its own.
 */
function drawsOwnBox(text: string, key: string): boolean {
  /* look only at the part of a multi-renderer file that plausibly belongs to
   * this key: whole-file matching would say every renderer in card.tsx draws
   * a box because one of them does */
  const anchor = new RegExp(`registerVariantRenderer\\(\\s*["'\`]${key}["'\`]\\s*,\\s*(\\w+)`).exec(text);
  const component = anchor?.[1];
  if (component) {
    const start = text.search(new RegExp(`(function|const)\\s+${component}\\b`));
    if (start >= 0) {
      /* to the next top-level function/const declaration, or the end */
      const rest = text.slice(start + 1);
      const nextIdx = rest.search(/\n(?:export\s+)?(?:function|const)\s+[A-Z]\w*/);
      const body = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
      return /<OtherInput\b|<OtherSpecifyBox\b|OtherSpecifyBox\(/.test(body);
    }
  }
  /* dispatcher `case` arms: the component named in the arm */
  const arm = new RegExp(`case\\s+["'\`]${key}["'\`]\\s*:\\s*return\\s*<(\\w+)`).exec(text);
  if (arm) {
    const start = text.search(new RegExp(`(function|const)\\s+${arm[1]}\\b`));
    if (start >= 0) {
      const rest = text.slice(start + 1);
      const nextIdx = rest.search(/\n(?:export\s+)?(?:function|const)\s+[A-Z]\w*/);
      const body = nextIdx >= 0 ? rest.slice(0, nextIdx) : rest;
      return /<OtherInput\b|<OtherSpecifyBox\b|OtherSpecifyBox\(/.test(body);
    }
  }
  return false;
}

const WITH_OTHER = QUESTION_VARIANTS.filter((v) => (v.capabilities ?? []).includes("other_specify"));

test("the capability is declared by enough variants for this test to mean something", () => {
  /*
   * A guard against the test quietly becoming vacuous: if someone removes the
   * capability from the registry wholesale, every assertion below passes over
   * an empty list and says nothing.
   */
  assert.ok(WITH_OTHER.length >= 20, `only ${WITH_OTHER.length} variants declare other_specify — expected ~33`);
});

test("every variant declaring other_specify resolves to a renderer that exists", () => {
  const missing: string[] = [];
  for (const v of WITH_OTHER) {
    if (!v.renderer) continue; // falls through to the base-type switch, which is exhaustive
    if (!componentFor(v.renderer)) missing.push(`${v.id} → renderer "${v.renderer}"`);
  }
  assert.deepEqual(missing, [], `these variants name a renderer nothing registers or dispatches:\n${missing.join("\n")}`);
});

test("a renderer that CLAIMS its own Other box actually draws one", () => {
  /*
   * The R5 failure, in its exact original form. A claim here means the
   * dispatcher does NOT draw the fallback — so if the component does not
   * draw a box either, nobody does, and the respondent is trapped.
   */
  const broken: string[] = [];
  for (const key of claimedRenderers()) {
    const src = componentFor(key);
    if (!src) { broken.push(`"${key}" claims its own box but nothing registers that renderer`); continue; }
    if (!drawsOwnBox(src.text, key)) {
      broken.push(`"${key}" is in OWN_OTHER_BOX_RENDERERS but ${src.name} draws no Other box — a respondent who picks "Other" has nowhere to type`);
    }
  }
  assert.deepEqual(broken, [], broken.join("\n"));
});

test("a renderer that does NOT claim its own box does not draw one either", () => {
  /*
   * The opposite failure, which is subtler and just as wrong: the fallback
   * draws a box for every unclaimed renderer, so one that also draws its own
   * shows the respondent two inputs bound to the same answer.
   */
  const claimed = claimedRenderers();
  const doubled: string[] = [];
  for (const v of WITH_OTHER) {
    if (!v.renderer || claimed.has(v.renderer)) continue;
    const src = componentFor(v.renderer);
    if (src && drawsOwnBox(src.text, v.renderer)) {
      doubled.push(`"${v.renderer}" (${v.id}) draws its own Other box but is not in OWN_OTHER_BOX_RENDERERS — the central fallback will draw a second one`);
    }
  }
  assert.deepEqual(doubled, [], [...new Set(doubled)].join("\n"));
});

test("the base types that claim their own box are types this registry actually uses", () => {
  const types = new Set(QUESTION_VARIANTS.map((v) => v.baseType));
  const stale = [...claimedTypes()].filter((t) => !types.has(t as never));
  assert.deepEqual(stale, [], `OWN_OTHER_BOX_TYPES names types no variant has: ${stale.join(", ")}`);
});
