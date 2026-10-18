import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanUntrusted } from "@rescript/engine";
import { extractResearchDocument } from "./research.js";
import { readDocx } from "./adapters/docx.js";
import { docxFixture, hiddenTextDocxFixture } from "./fixtures.js";

/*
 * PROMPT INJECTION (2026-10-18): instructions hidden in a Word document — white, hidden or 1pt runs — are listed
 * by the reader (the text itself is kept, as before) so the upload can say the document carries text its reader
 * could not see, and the scanner reads it. The payload is the shared corpus's docx case.
 */
const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("../../engine/src/fixtures/prompt-injection-corpus.json", import.meta.url)), "utf8")) as { payloads: { id: string; text: string }[] };
const payload = corpus.payloads.find((p) => p.id === "docx-hidden-white")!.text;

test("a Word brief with hidden instructions: listed as hidden, scanned, flagged", async () => {
  const bytes = hiddenTextDocxFixture(["Research brief: switching in mobile plans.", "Objective: understand why customers switch."], payload);
  const r = readDocx(bytes);
  assert.equal(r.hidden.length, 3, "white, vanish and 1pt runs");
  assert.ok(r.hidden.every((h) => h === payload));
  const doc = await extractResearchDocument(bytes, "brief.docx");
  assert.equal(doc.hidden?.length, 3);
  assert.ok(doc.pages.some((p) => p.text.includes("Objective")), "visible text kept");
  const scan = scanUntrusted(doc.pages.map((p) => p.text).join("\n"), { hidden: doc.hidden });
  assert.ok(scan.flagged);
  assert.ok(scan.signals.some((s) => s.kind === "hidden" && s.strength === "strong"));
});

test("an ordinary Word questionnaire has nothing hidden (the importer's blocks are unchanged)", async () => {
  const r = readDocx(docxFixture());
  assert.deepEqual(r.hidden, []);
  const doc = await extractResearchDocument(docxFixture(), "q.docx");
  assert.equal(doc.hidden, undefined);
});
