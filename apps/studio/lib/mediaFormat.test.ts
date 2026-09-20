import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, fileSize, typeLabel } from "./mediaFormat.ts";

/*
 * "THE SELECTED VIDEO'S FILE SIZE IS NOT BEING DISPLAYED."
 *
 * Two faults wearing one sentence. The interview recorder never captured the
 * chosen file's name, size or type into state at all on the upload path —
 * `onPick` read them only to validate and then started the upload — so there
 * was nothing to display. And where a size WAS displayed, on the recorded
 * path, the recorder had its own formatter:
 *
 *     const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
 *
 * Every real file in this product's own storage is small. The five assets
 * that failed to upload in production were 72 KB, 396 KB, 484 KB and two of
 * 1.5 MB; the videos were about 1.1 MB. Under that formatter the first reads
 * "0.1 MB" and anything under 51 KB reads "0.0 MB" — a rendering that cannot
 * tell an empty file from a small one, which is not a size.
 *
 * The asset library already had a correct formatter. Having two was the
 * cause, so these hold the one that is left.
 */

test("a size is rendered at its own scale, not always in megabytes", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(5_000), "4.9 KB");
  assert.equal(formatBytes(72_385), "71 KB");
  assert.equal(formatBytes(483_940), "473 KB");
  assert.equal(formatBytes(1_103_363), "1.1 MB");
  assert.equal(formatBytes(1_577_660), "1.5 MB");
  assert.equal(formatBytes(48_000_000), "46 MB");
  assert.equal(formatBytes(3_221_225_472), "3.00 GB");
});

test("the small files that failed in production stay distinguishable", () => {
  /*
   * The property the old formatter lacked, stated for the range where it
   * lacked it. Under `(n / 1048576).toFixed(1)` an empty file and a 40 KB one
   * were both "0.0 MB", and 72 KB, 396 KB and 484 KB were "0.1 MB", "0.4 MB",
   * "0.5 MB" — one significant figure for the whole sub-megabyte range, which
   * is where every asset in this product's storage actually lives.
   *
   * Above a megabyte, rounding to one decimal legitimately merges files a few
   * per cent apart (1,103,363 and 1,164,488 are both "1.1 MB"). That is a
   * size, not a collision, so the claim is scoped rather than overstated —
   * the first version of this test asserted all eight were distinct and
   * failed on exactly that pair.
   */
  const small = [0, 40_000, 72_385, 396_263, 483_940];
  const rendered = small.map(fileSize);
  assert.equal(new Set(rendered).size, small.length, `collisions in ${JSON.stringify(rendered)}`);
  assert.ok(!rendered.some((r) => /MB/.test(r)), `a sub-megabyte file was rendered in MB: ${rendered.join(", ")}`);
});

test("absent is not zero, and zero is not absent", () => {
  /*
   * A tile with no recorded size shows nothing; a panel describing ONE file
   * in flight has to say something, because a blank there reads as a claim.
   */
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(undefined), "");
  assert.equal(formatBytes(0), "");
  assert.equal(fileSize(null), "unknown size");
  assert.equal(fileSize(undefined), "unknown size");
  assert.equal(fileSize(0), "0 B", "an empty file is a fact, not a missing one");
});

test("a codec-laden MIME type reads as a format", () => {
  /* what MediaRecorder actually produces, semicolon and all */
  assert.equal(typeLabel("video/webm;codecs=vp9,opus"), "webm");
  assert.equal(typeLabel("video/mp4"), "mp4");
  assert.equal(typeLabel("image/png"), "png");
  assert.equal(typeLabel("audio/webm; codecs=opus"), "webm");
  /* a non-media type keeps its whole name — "pdf" alone would be a guess */
  assert.equal(typeLabel("application/pdf"), "application/pdf");
  assert.equal(typeLabel(""), "unknown type");
  assert.equal(typeLabel(null), "unknown type");
});
