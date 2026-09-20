import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BILLABLE_EVENTS } from "./registry.js";

/*
 * R13 — A BILLABLE EVENT THAT NOTHING EMITS IS A REVENUE LINE THAT NEVER EARNS.
 *
 * The registry declared twenty-five event types. Six of them had no producer
 * anywhere in the codebase, and five of those six were `billable: true` — the
 * platform advertised revenue it had no way to collect, and had done since the
 * metering system shipped.
 *
 * None of it showed up anywhere. A missing charge is not an error, not a
 * failed test and not a wrong number on a screen: it is an absence, and an
 * absence has no symptom. The first symptom would have been an invoice that
 * was quietly too small, discovered by whoever reconciles revenue against
 * costs — which, before a commercial launch, is nobody.
 *
 * So the registry is held to a rule: a billable, active event either has
 * something that emits it, or is listed below with the reason it does not.
 * Both halves are load-bearing. Without the first a line can go silent
 * unnoticed; without the second the test becomes a nuisance that someone
 * turns off.
 */

/**
 * Billable, active event types that nothing emits YET, each with the reason
 * and what would change it.
 *
 * An entry here is a commitment to come back, not a place to park things: the
 * test below fails if an entry becomes untrue in either direction — a producer
 * appears for something listed here, or the type stops being billable.
 */
const PRODUCERLESS_EVENTS: Record<string, string> = {
  STORAGE_GB:
    "Stored bytes are known (`media_objects.bytes`) but a GB-MONTH is a measurement over time, not an event: it "
    + "needs a periodic job that reads the total and writes one row per customer per period. That job is the next "
    + "piece of this wave.",
  BANDWIDTH_GB:
    "`/api/media/<id>` answers 302 and the browser fetches from object storage directly, so no byte count is "
    + "observable in this application — by design. It comes from a provider-usage import, not from a route.",
  DATABASE_STORAGE_GB:
    "Non-billable, and the same shape as STORAGE_GB: a measurement over time that the provider reports.",
};

/* ------------------------------------------------------------ the search */

function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "packages")) && existsSync(join(d, "apps"))) return d;
    d = dirname(d);
  }
  throw new Error("could not find the repository root from " + import.meta.url);
}

const ROOT = repoRoot();

/**
 * Every source file that could plausibly emit a usage event.
 *
 * `dist` and tests are excluded on purpose. A producer that exists only in a
 * test is not a producer — that is exactly how a metering gap hides, with a
 * test asserting a charge that no route ever makes.
 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 8 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full, depth + 1); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (/\.test\.(ts|tsx)$/.test(name)) continue;
      /* the registry declares the names; it does not emit them */
      if (full.endsWith(join("billing", "src", "registry.ts"))) continue;
      out.push(full);
    }
  };
  walk(join(ROOT, "apps"));
  walk(join(ROOT, "packages"));
  return out;
}

const CORPUS = sources().map((f) => readFileSync(f, "utf8")).join("\n");

/** Is this event type named by anything that could write it? */
function hasProducer(type: string): boolean {
  return new RegExp(`["'\`]${type}["'\`]`).test(CORPUS);
}

/* ------------------------------------------------------------- the tests */

test("the corpus is real — the search would find a producer if one existed", () => {
  /*
   * A guard against the whole file passing vacuously. If the walk returned
   * nothing, every event below would look producerless and the declarations
   * would silently become the answer rather than the exception.
   */
  assert.ok(sources().length > 200, `only ${sources().length} source files found — the walk is broken`);
  assert.ok(hasProducer("SURVEY_RESPONSE"), "SURVEY_RESPONSE is emitted by the runtime; the search cannot see it");
  assert.ok(hasProducer("AI_REQUEST"), "AI_REQUEST is emitted by the Studio; the search cannot see it");
});

test("every billable, active event type is emitted by something — or says why not", () => {
  const silent: string[] = [];
  for (const e of DEFAULT_BILLABLE_EVENTS) {
    if (!e.billable || !e.active) continue;
    if (hasProducer(e.type)) continue;
    if (e.type in PRODUCERLESS_EVENTS) continue;
    silent.push(e.type);
  }
  assert.deepEqual(
    silent,
    [],
    "these event types are billable and active and nothing emits them — either add a producer, or add an entry to "
    + `PRODUCERLESS_EVENTS saying why there is none:\n  ${silent.join("\n  ")}`,
  );
});

test("the declarations stay true: a declared gap that gained a producer must be removed", () => {
  /*
   * The other direction, and the one that makes the list trustworthy. Without
   * it, `PRODUCERLESS_EVENTS` accumulates entries that were fixed years ago
   * and stops meaning anything — at which point the first test above is
   * exempting things nobody has looked at.
   */
  const stale = Object.keys(PRODUCERLESS_EVENTS).filter((t) => hasProducer(t));
  assert.deepEqual(
    stale,
    [],
    `these have a producer now and should come out of PRODUCERLESS_EVENTS: ${stale.join(", ")}`,
  );
});

test("every declared gap names an event the registry actually has", () => {
  const known = new Set(DEFAULT_BILLABLE_EVENTS.map((e) => e.type));
  const unknown = Object.keys(PRODUCERLESS_EVENTS).filter((t) => !known.has(t));
  assert.deepEqual(unknown, [], `PRODUCERLESS_EVENTS names types the registry does not declare: ${unknown.join(", ")}`);
});

test("an INACTIVE billable type is inactive for a stated reason", () => {
  /*
   * `billable: true, active: false` is the shape used for a revenue line that
   * cannot fire because the thing it would charge for costs nothing — browser
   * speech recognition, a transcode pipeline that does not exist. That is a
   * legitimate state and it must be legible, or the next person reads it as an
   * accident and switches it back on.
   */
  const undocumented = DEFAULT_BILLABLE_EVENTS
    .filter((e) => e.billable && !e.active)
    .filter((e) => !/inactive/i.test(e.description ?? ""))
    .map((e) => e.type);
  assert.deepEqual(
    undocumented,
    [],
    `these are billable but switched off with no reason in their description: ${undocumented.join(", ")}`,
  );
});

test("a billable event either carries its own rate, or is priced at the call site", () => {
  /*
   * `rate: null` is not automatically wrong. Five events are priced from
   * whatever the CALLER names — the AI model actually used, the translation
   * provider actually called — because the registry cannot know in advance
   * which model a request will reach. `priceSpec` takes `spec.provider ??
   * event.rate?.provider`, so a null here means "the call site supplies it".
   *
   * The distinction is real and was written down nowhere, which is why the
   * first version of this test asserted the opposite and failed on five
   * correct rows. It matters because the two states fail differently: a
   * caller-priced event with no caller price meters at zero, and a registry
   * event with no registry rate does too — but only the second can be seen
   * from here.
   */
  const CALLER_PRICED = new Set([
    "AI_REQUEST",                // the model decides the rate
    "TRANSLATION_CHARACTER",     // the provider decides the rate
    "TEXT_TO_SPEECH_CHARACTER",  // "
    "SPEECH_TO_TEXT_MINUTE",     // "
    "CUSTOM_EVENT",              // by definition: whatever registered it says
  ]);

  const priceless = DEFAULT_BILLABLE_EVENTS
    .filter((e) => e.billable && e.active && !e.rate && !CALLER_PRICED.has(e.type))
    .map((e) => e.type);
  assert.deepEqual(
    priceless,
    [],
    "billable and active, no registry rate, and not priced at the call site — these meter at zero: "
    + priceless.join(", "),
  );

  /* and the list stays honest: an entry that gained a registry rate comes out */
  const stale = [...CALLER_PRICED].filter((t) => DEFAULT_BILLABLE_EVENTS.find((e) => e.type === t)?.rate);
  assert.deepEqual(stale, [], `these have a registry rate now and are not caller-priced: ${stale.join(", ")}`);
});
