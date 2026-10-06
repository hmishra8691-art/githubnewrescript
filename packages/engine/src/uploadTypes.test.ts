import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { uploadAccept, uploadTypeAllowed } from "./uploadTypes.js";
import { validateQuestion } from "./validate.js";

const q = (settings: Record<string, unknown>, variant = "upload.file", extra: Record<string, unknown> = {}) => {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "u", code: "Q1", variableName: "Q1", type: "upload", variant, text: "Upload", settings, ...extra }],
    flow: [{ type: "page", id: "p", questionIds: ["u"] }, { type: "end", id: "e", status: "complete" }],
  });
  return { def, q: def.questions[0] };
};
const errs = (x: ReturnType<typeof q>, value: unknown) =>
  validateQuestion(x.def, x.q, value, { def: x.def, state: { answers: {}, embedded: {} } } as never).map((e) => e.message);
const f = (name: string, size = 1000, type = "") => ({ url: "x", name, size, type });

test("accepted kinds — PDF accepts .pdf and refuses .xlsx, with the review's message", () => {
  const acc = uploadAccept({ settings: { acceptTypes: ["pdf"] } });
  assert.ok(acc);
  assert.equal(uploadTypeAllowed(acc, { name: "report.pdf" }), true);
  assert.equal(uploadTypeAllowed(acc, { name: "REPORT.PDF" }), true, "case does not matter");
  assert.equal(uploadTypeAllowed(acc, { name: "data.xlsx" }), false);
  assert.equal(acc!.wanted, "a PDF file");
  assert.match(acc!.attr, /\.pdf/);
  const x = q({ acceptTypes: ["pdf"] });
  assert.deepEqual(errs(x, f("report.pdf")), []);
  assert.deepEqual(errs(x, f("data.xlsx")), ["Invalid file type. Please upload a PDF file."]);
});

test("several kinds and a custom extension; the older free-text 'pdf' is now a rule, not a hint", () => {
  const acc = uploadAccept({ settings: { acceptTypes: ["pdf", "word", ".dwg"] } });
  assert.equal(acc!.wanted, "a PDF, Word or .dwg file");
  for (const n of ["a.pdf", "b.doc", "c.docx", "d.dwg"]) assert.equal(uploadTypeAllowed(acc, { name: n }), true, n);
  assert.equal(uploadTypeAllowed(acc, { name: "e.png" }), false);
  const legacy = uploadAccept({ settings: { accept: "pdf" } });
  assert.equal(uploadTypeAllowed(legacy, { name: "data.xlsx" }), false, "the screenshot's case: accept = 'pdf'");
  assert.equal(uploadTypeAllowed(legacy, { name: "r.pdf" }), true);
  const wild = uploadAccept({ settings: { accept: "image/*" } });
  assert.equal(uploadTypeAllowed(wild, { name: "shot", type: "image/png" }), true, "a wildcard reads the type");
  assert.equal(uploadAccept({ settings: {} }), null, "nothing set: any file");
  assert.equal(uploadTypeAllowed(null, { name: "anything.exe" }), true);
});

test("Photo / Camera Capture — JPG, JPEG, PNG only, whatever its old Accepted Files said", () => {
  const acc = uploadAccept({ variant: "upload.photo", settings: { accept: "application/pdf" } });
  for (const n of ["photo.jpg", "photo.jpeg", "photo.png"]) assert.equal(uploadTypeAllowed(acc, { name: n }), true, n);
  for (const n of ["document.pdf", "file.xlsx", "document.docx", "anim.gif"]) assert.equal(uploadTypeAllowed(acc, { name: n }), false, n);
  assert.equal(uploadTypeAllowed(acc, { name: "", type: "image/jpeg" }), true, "a photo taken in the page has no name, only a type");
  const x = q({ accept: "application/pdf" }, "upload.photo");
  assert.deepEqual(errs(x, f("document.pdf")), ["Invalid file type. Please upload an image file (JPG, JPEG, or PNG)."]);
});

test("count and size — maximum and minimum files, size per file, total size; type is reported first", () => {
  const x = q({ acceptTypes: ["pdf"], maxFiles: 2, minFiles: 2, maxSizeMb: 10, maxTotalMb: 15 });
  assert.deepEqual(errs(x, [f("a.pdf"), f("b.pdf")]), []);
  assert.deepEqual(errs(x, [f("a.pdf"), f("b.pdf"), f("c.pdf")]), ["You can upload a maximum of 2 files."]);
  assert.deepEqual(errs(x, [f("a.pdf")]), ["Please upload at least 2 files."]);
  assert.deepEqual(errs(x, [f("a.pdf", 12 * 1024 * 1024), f("b.pdf")]), ["File size exceeds the 10 MB limit."]);
  assert.deepEqual(errs(x, [f("a.pdf", 9 * 1024 * 1024), f("b.pdf", 9 * 1024 * 1024)]), ["The files together exceed the 15 MB limit."]);
  assert.deepEqual(errs(x, [f("a.xlsx"), f("b.pdf"), f("c.pdf")]),
    ["Invalid file type. Please upload a PDF file.", "You can upload a maximum of 2 files."], "type, then count");
});
