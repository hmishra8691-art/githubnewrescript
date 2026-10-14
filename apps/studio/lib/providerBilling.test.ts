import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A recoverable provider failure must not consume balance or bill twice. The
 * guarantees live in two places, and this pins both:
 *
 *  1. `meteredAi` holds the estimate, runs the call, and RELEASES the hold on
 *     any throw (a 429, a timeout, a refused key) — only a call that returned
 *     is settled, with what the provider reported. Retries happen INSIDE the
 *     call (the ai package's manager), so a retried success is one settle.
 *  2. The copilot route calls the model only through `meteredAi`, one item per
 *     call, and never re-asks for an item the browser says is built (`done`) —
 *     so a resumed build is not paid for twice.
 */
const ROOT = join(import.meta.dirname, "..");
const metering = readFileSync(join(ROOT, "lib/metering.ts"), "utf8");
const route = readFileSync(join(ROOT, "app/api/copilot/turn/route.ts"), "utf8");

test("meteredAi releases the hold when the provider call throws, and settles only a call that returned", () => {
  /* the rule lives in the metering core now (lib/meterRun.ts); meteredAi delegates to it */
  const core = readFileSync(join(ROOT, "lib/meterRun.ts"), "utf8");
  const body = core.slice(core.indexOf("export async function meteredCore"));
  assert.match(metering.slice(metering.indexOf("export async function meteredAi"), metering.indexOf("export async function meteredTts")), /meteredCore\(/, "meteredAi walks the core");
  assert.match(body, /catch \(e\) \{\s*await meter\.release\(hold\)/, "a throw gives the platform's hold back");
  assert.match(body, /catch \(e\) \{\s*if \(holdOk\) await meter\.release\(holdOk\)/, "and the backstop hold of an own-provider call");
  assert.match(body, /meter\.settle\(hold,/, "a return is settled with the reported usage");
  assert.ok(body.indexOf("meter.settle(") < body.indexOf("catch (e)"), "settle is inside the try, release in the catch");
});

test("the copilot route reaches the provider only inside meteredAi, and skips items already built", () => {
  const calls = route.match(/completeJson\(/g) ?? [];
  const metered = route.match(/meteredAi\(/g) ?? [];
  assert.ok(calls.length >= 5 && metered.length >= calls.length - 1, `${calls.length} model calls, ${metered.length} metered`);
  assert.match(route, /if \(prior\.has\(item\.id\) && !prior\.get\(item\.id\)!\.applied\) continue;/, "a built item is not asked of the model again");
  assert.match(route, /const prior = sanitizeDone\(body\.done/, "the browser's checkpoint is read");
  assert.match(route, /shared\(`item:\$\{item\.id\}`/, "a duplicate in-flight item shares one call");
});

test("a failed item is not a charge: the route adds to `charge` only from a returned call", () => {
  const items = route.slice(route.indexOf("const m = await meteredAi(meter, ctx, \"AI_REQUEST\", { ...consent, estimateText: COPILOT_SYSTEM_PROMPT + itemPrompt"));
  const firstCharge = items.indexOf("charge += m.event?.customerCharge");
  const firstCatch = items.indexOf("} catch (e) {");
  assert.ok(firstCharge > 0 && firstCharge < firstCatch, "the charge is read from the settled event, before any failure handling");
});
