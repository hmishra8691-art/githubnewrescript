import type { Question } from "@rescript/schema";
import { uiText } from "./localization.js";

/**
 * BUCKET RULES — Drag into Buckets and Image Categorization (October 2026
 * review).
 *
 * "The Framing Builder should clearly define whether respondents can place
 * multiple items into the same bucket or only one item per bucket … If a
 * respondent tries to place another item into an occupied bucket, the system
 * should either prevent the drop or move/replace the existing item based on
 * the configured behavior", with "Allow Empty Buckets", "Require Every Image
 * to Be Categorized", "Maximum Images Per Bucket" and "Minimum/Maximum items
 * per bucket".
 *
 * The answer is unchanged — `{ itemCode: bucketCode }`, a single-select
 * matrix — so these are rules about which answers are allowed, applied in two
 * places from one definition: `dropInto` decides a drop in the respondent's
 * view, `bucketProblems` validates the answer however it arrived. "Every item
 * categorized" is the question's ordinary Required (a matrix that is required
 * needs every row), so it is not a second setting.
 */

type Settings = Question["settings"];
type Answer = Record<string, unknown>;

/** How many items this bucket may hold: one, its own capacity, the question's maximum, or no limit. */
export function bucketCapacity(settings: Settings, bucket: { meta?: Record<string, unknown> }): number {
  if (settings.bucketMode === "one") return 1;
  const own = Number(bucket.meta?.capacity);
  if (Number.isFinite(own) && own >= 1) return own;
  return settings.bucketMax != null && settings.bucketMax >= 1 ? settings.bucketMax : Infinity;
}

const plain = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/**
 * The respondent drops `item` into `bucket`. Returns the next answer, or why
 * not. With the bucket full, "replace" sends the item that was there first
 * back to the pool; "prevent" (the default) refuses and says so.
 */
export function dropInto(
  q: Pick<Question, "settings" | "options">,
  value: Answer,
  item: string,
  bucket: string | number,
): { ok: true; next: Answer; displaced?: string } | { ok: false; reason: string } {
  const opt = q.options.find((o) => String(o.code) === String(bucket));
  if (!opt) return { ok: false, reason: "That bucket is not part of this question." };
  const cap = bucketCapacity(q.settings, opt);
  const already = Object.keys(value).filter((k) => k !== item && String(value[k]) === String(bucket));
  const next: Answer = { ...value, [item]: opt.code };
  if (already.length < cap) return { ok: true, next };
  if (q.settings.bucketFull === "replace") {
    const out = already[0];
    delete next[out];
    return { ok: true, next, displaced: out };
  }
  return {
    ok: false,
    reason: cap === 1
      ? `“${plain(opt.label)}” already has an item — take it out first.`
      : `“${plain(opt.label)}” can hold at most ${cap} items.`,
  };
}

/**
 * What is wrong with an answer under the bucket rules — over capacity, under
 * the minimum, or an empty bucket where empty buckets are not allowed. An
 * untouched optional question has nothing wrong with it.
 */
export function bucketProblems(q: Pick<Question, "settings" | "options" | "required">, value: unknown, ui?: Record<string, string>): string[] {
  const vals = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Answer;
  const placed = Object.values(vals).filter((v) => v != null && v !== "");
  if (!placed.length && !q.required) return [];
  const out: string[] = [];
  for (const o of q.options) {
    const n = placed.filter((v) => String(v) === String(o.code)).length;
    const cap = bucketCapacity(q.settings, o);
    const name = plain(o.label);
    if (n > cap) out.push(uiText(ui, cap === 1 ? "bucket_max_1" : "bucket_max", { bucket: name, n: cap }));
    const min = q.settings.bucketMin ?? (q.settings.allowEmptyBuckets === false ? 1 : 0);
    if (n < min) out.push(min === 1 ? uiText(ui, "bucket_empty", { bucket: name }) : uiText(ui, "bucket_min", { bucket: name, n: min }));
  }
  return out;
}

/** Does this question carry bucket rules at all? (Only the two bucket renderers do.) */
export function hasBucketRules(rendererKey: string | undefined): boolean {
  return rendererKey === "dragbuckets" || rendererKey === "categorize";
}
