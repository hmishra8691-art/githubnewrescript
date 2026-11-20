import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfDoc, pdfCanWrite, pdfText, pdfTextWidth } from "./pdf.js";

const ascii = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const has = (tool: string) => spawnSync(tool, ["--version"]).error === undefined;

test("what can be written: Western European text yes; any other script no — said in advance, never a '?'", () => {
  for (const ok of ["Plain English.", "Énergie élevée — très bien", "Größe, Straße, façade, niño, São Paulo", "“quoted” … €5 • 10–20", "a ≥ b → c", "non breaking"]) assert.equal(pdfCanWrite(ok), true, ok);
  for (const no of ["ऊर्जा", "Ενέργεια", "Энергия", "能量", "طاقة", "smile 🙂", "Łódź"]) assert.equal(pdfCanWrite(no), false, no);
  assert.equal(pdfText("a ≥ b → c d"), "a >= b -> c d");
  assert.throws(() => { const d = new PdfDoc({ title: "t" }); d.text("ऊर्जा"); d.bytes(); }, /cannot be written/);
});

test("widths and wrapping: a line never exceeds the page width; a very long word is broken, nothing is lost", () => {
  assert.equal(pdfTextWidth("Hello", 10), 22.78); // 722+556+222+222+556 = 2278
  assert.ok(pdfTextWidth("Hello", 10, true) > pdfTextWidth("Hello", 10));
  const d = new PdfDoc({ title: "t" });
  const text = `${"word ".repeat(80)}${"x".repeat(300)} end`;
  const lines = d.wrap(text, 11, false, d.width);
  assert.ok(lines.length > 3);
  for (const l of lines) assert.ok(pdfTextWidth(l, 11) <= d.width + 0.01, l);
  assert.equal(lines.join("").replace(/ /g, ""), text.replace(/ /g, ""));
});

test("the file: a valid structure whose cross-reference table points at every object; 7-bit clean; pages break", () => {
  const d = new PdfDoc({ title: "Report (draft) \\ one", footer: "Made for RSP-ANA00001" });
  d.text("Personal report", { size: 18, bold: true });
  d.pair("Energy", "9 of 10");
  d.bar(87.5, 49);
  for (let i = 0; i < 90; i++) d.text(`Line ${i}: café, naïve, “quotes”, (parentheses) and a back\\slash.`);
  assert.ok(d.pageCount >= 2);
  const bytes = d.bytes(), s = ascii(bytes);
  assert.ok(s.startsWith("%PDF-1.4\n") && s.trimEnd().endsWith("%%EOF"));
  assert.ok(bytes.every((b) => b < 127), "7-bit clean");
  const xref = Number(/startxref\n(\d+)\n/.exec(s)![1]);
  assert.equal(s.slice(xref, xref + 4), "xref");
  const offsets = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1} at ${o}`));
  assert.equal((s.match(/\/Type \/Page /g) ?? []).length, d.pageCount);
  assert.match(s, new RegExp(`Page ${d.pageCount} of ${d.pageCount}`));
  assert.match(s, /\/Title \(Report \\\(draft\\\) \\\\ one\)/);
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) assert.equal(m[2]!.length, Number(m[1]), "a stream is exactly as long as it says");
});

test("real readers accept it: qpdf finds no error and pdftotext reads the words back, accents included", { skip: !(has("qpdf") && has("pdftotext")) && "qpdf / pdftotext are not installed" }, () => {
  const d = new PdfDoc({ title: "Bien-être" });
  d.text("Énergie élevée — très bien", { size: 14, bold: true });
  d.text("Score: 9 of 10 (“High”) … €5");
  d.bar(60, 40);
  const file = join(mkdtempSync(join(tmpdir(), "rescript-pdf-")), "t.pdf");
  writeFileSync(file, d.bytes());
  const check = spawnSync("qpdf", ["--check", file], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const read = spawnSync("pdftotext", ["-enc", "UTF-8", file, "-"], { encoding: "utf8" }).stdout;
  assert.match(read, /Énergie élevée — très bien/); assert.match(read, /Score: 9 of 10 \(“High”\) … €5/); assert.match(read, /Page 1 of 1/);
});
