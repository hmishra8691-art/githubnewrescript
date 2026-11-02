#!/usr/bin/env node
/**
 * DYNAMIC-RECONSTRUCTION FIDELITY (2026-11-02).
 *
 *   node scripts/import-dynamics-fidelity.mjs            measure, print, exit 1 on any miss
 *   node scripts/import-dynamics-fidelity.mjs --json f   write the measurement
 *
 * The expectations below are written BY HAND from the source documents (scripts/word-corpus-build.mjs cases 08–10,
 * scripts/qsf-corpus-build.mjs 05) — what a survey programmer reading them would build — not copied from the
 * importer's output. Each is one check; the accuracy per dimension is checks passed / checks made:
 *
 *   questions     every question present, with the kind the source implies
 *   options       the source's codes (recodes) and labels on the lists written out
 *   logic         display logic / branches / ends the source states
 *   dependencies  each carried / masked / same list: its source and filter; each loop: its source and members
 *   piping        each placeholder replaced by the token that pipes the right thing; none left as text
 *   runtime       synthetic respondents run on the engine (verifyImport → dynamics): scenarios passed / run
 *
 * The figures are for THIS corpus — four synthetic files. They say what the importer does on these patterns, not
 * on every questionnaire.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeImport, verifyImport } from "../packages/import/dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "packages", "import", "corpus");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const TEXT = /^(open_text|long_text|text)$/;
const EXPECT = [
  {
    file: "word/08-carry-forward-masking.docx",
    questions: { Q1: "multi_select", Q2: "multi_select", Q3: "multi_select", Q4: "single_select", Q5: "multi_select", Q6: "multi_select" },
    options: { Q1: [[1, "Brand A"], [2, "Brand B"], [3, "Brand C"], [4, "Brand D"], [99, "None of these"]] },
    carried: { Q2: ["Q1", "selected"], Q3: ["Q2", "not_selected"], Q4: ["Q2", "selected"], Q5: ["Q1", "all"], Q6: ["Q1", "selected"] },
    /* Q6 writes Q1's four brands AND says carry forward: shown once */
    noDuplicate: ["Q6"],
    loops: [], pipes: {}, logic: [],
  },
  {
    file: "word/09-loops-piping.docx",
    questions: { Q1: "multi_select", Q2: "single_select", Q3: TEXT, Q4: "single_select", Q5: "numeric", Q6: "single_select", Q7: TEXT },
    options: { Q1: [[1, "Alpha"], [2, "Beta"], [3, "Gamma"], [4, "Delta"]] },
    carried: { Q4: ["Q1", "selected"] },
    loops: [{ source: ["Q1", "selected"], members: ["Q2", "Q3"] }],
    pipes: { Q2: ["{{loop.label}}"], Q3: ["{{loop.label}}"], Q4: ["{{Q1}}"], Q6: ["{{Q5}}", "{{Q4}}"], Q7: ["{{Q4}}"] },
    logic: [],
  },
  {
    file: "word/10-informal-instructions.docx",
    questions: { Q1: "multi_select", Q2: "single_select", Q3: "multi_select", Q4: "single_select", Q5: "multi_select", Q6: TEXT, Q7: null },
    options: { Q1: [[1, "Tesco"], [2, "Sainsbury's"], [3, "Asda"], [4, "Aldi"], [5, "Lidl"]] },
    carried: { Q2: ["Q1", "selected"], Q3: ["Q1", "not_selected"], Q5: ["Q1", "all"] },
    /* “only show the supermarkets they like” names no question and no rule — it must be ASKED, not guessed */
    mustAsk: ["Q7"],
    loops: [{ source: ["Q1", "selected"], members: ["Q4"] }],
    pipes: { Q4: ["{{loop.label}}"], Q6: ["{{Q2}}"] },
    logic: [],
  },
  {
    file: "qsf/05-dynamic-lists.qsf",
    questions: { aware: "multi_select", bought: "multi_select", notbought: "multi_select", main: "single_select", why: TEXT, sat: "single_select", better: TEXT, rec: "single_select" },
    options: { aware: [[10, "Alpha"], [20, "Beta"], [30, "Gamma"], [40, "Delta"], [99, "None of these"]] },
    carried: { bought: ["aware", "selected"], notbought: ["bought", "not_selected"], main: ["bought", "selected"] },
    loops: [{ source: ["bought", "selected"], members: ["sat", "better"] }],
    pipes: { why: ["{{main}}", "{{ed.panel}}"], sat: ["{{loop.label}}"], better: ["{{loop.label}}"] },
    optionPipes: { rec: ["{{main}}"] },
    /* bought: shown unless “None of these” (99); main: carried x1 → 10 at bought, OR 20 and 30 at aware; a screen-out on 99 redirecting with the panel id */
    logic: [["bought", ["aware", 99]], ["main", ["bought", 10], ["aware", 20], ["aware", 30]]],
    ends: [{ status: "screened", redirect: "{{ed.panel}}" }],
  },
];

let n = 0;
const uid = (p) => `${p}_${(++n).toString(36)}`;
const dims = ["questions", "options", "logic", "dependencies", "piping", "runtime"];
const total = Object.fromEntries(dims.map((d) => [d, { ok: 0, of: 0 }]));
const out = [];

for (const e of EXPECT) {
  n = 0;
  const a = await analyzeImport(new Uint8Array(readFileSync(join(CORPUS, e.file))), e.file.split("/").pop(), { surveyId: "fid", uid });
  const def = a.result?.def;
  const r = { file: e.file, checks: [], dims: Object.fromEntries(dims.map((d) => [d, { ok: 0, of: 0 }])) };
  const check = (dim, what, ok, got = "") => { r.checks.push({ dim, what, ok: !!ok, got }); r.dims[dim].of++; total[dim].of++; if (ok) { r.dims[dim].ok++; total[dim].ok++; } };
  if (!def) { check("questions", "a survey is produced", false, a.issues?.[0]?.message); out.push(r); continue; }
  const byCode = (c) => def.questions.find((q) => q.code === c);
  const codeOf = (id) => def.questions.find((q) => q.id === id)?.code;

  for (const [c, kind] of Object.entries(e.questions)) {
    const q = byCode(c);
    check("questions", `${c} present${kind ? ` as ${kind}` : ""}`, q && (!kind || (kind instanceof RegExp ? kind.test(q.type) : q.type === kind)), q?.type ?? "missing");
  }
  check("questions", "no extra question", def.questions.length === Object.keys(e.questions).length, `${def.questions.length}`);
  for (const [c, opts] of Object.entries(e.options)) {
    const got = (byCode(c)?.options ?? []).map((o) => [o.code, o.label.replace(/<[^>]+>/g, "")]);
    check("options", `${c} codes and labels`, JSON.stringify(got) === JSON.stringify(opts), JSON.stringify(got));
  }
  for (const c of e.noDuplicate ?? []) {
    const q = byCode(c);
    check("options", `${c}: the carried list is not also written out`, q && !q.carryForward?.keepOwn && !(q.options ?? []).length, `${(q?.options ?? []).length} own options, keepOwn ${q?.carryForward?.keepOwn}`);
  }
  for (const [c, [src, filter]] of Object.entries(e.carried)) {
    const cf = byCode(c)?.carryForward;
    check("dependencies", `${c} carries ${filter} from ${src}`, cf && codeOf(cf.sourceQuestionId) === src && cf.filter === filter, cf ? `${codeOf(cf.sourceQuestionId)} ${cf.filter}` : "no carry");
  }
  for (const c of e.mustAsk ?? []) {
    const asked = (a.report?.clarifications ?? []).some((x) => x.location === c || x.questionId === c || x.id.includes(`:${c}:`));
    check("dependencies", `${c}: the unreadable instruction is asked, not guessed`, asked && !byCode(c)?.carryForward, asked ? "asked" : "not asked");
  }
  const loops = [];
  const walk = (ns) => { for (const x of ns) { if (x.type === "loop") { const m = []; const p = (cs) => { for (const y of cs) { if (y.type === "page") m.push(...y.questionIds.map(codeOf)); if (y.children) p(y.children); } }; p(x.children ?? []); loops.push({ source: x.source, members: m }); } if (x.children) walk(x.children); for (const b of x.branches ?? []) walk(b.children); if (x.otherwise) walk(x.otherwise); } };
  walk(def.flow);
  for (const l of e.loops) {
    const hit = loops.find((x) => x.source?.kind === "question" && codeOf(x.source.questionId) === l.source[0] && x.source.filter === l.source[1]);
    check("dependencies", `loop over ${l.source[0]} ${l.source[1]}`, hit, hit ? "" : JSON.stringify(loops.map((x) => x.source)));
    check("dependencies", `loop holds ${l.members.join(", ")}`, hit && JSON.stringify(hit.members) === JSON.stringify(l.members), hit ? hit.members.join(", ") : "-");
  }
  check("dependencies", "no unexpected loop", loops.length === e.loops.length, `${loops.length}`);
  for (const [c, toks] of Object.entries(e.pipes)) for (const t of toks) check("piping", `${c} pipes ${t}`, byCode(c)?.text.includes(t), (byCode(c)?.text ?? "").slice(0, 90));
  for (const [c, toks] of Object.entries(e.optionPipes ?? {})) for (const t of toks) check("piping", `${c} option pipes ${t}`, (byCode(c)?.options ?? []).some((o) => o.label.includes(t)), (byCode(c)?.options ?? []).map((o) => o.label).join(" | "));
  const all = def.questions.flatMap((q) => [q.text, ...(q.options ?? []).map((o) => o.label)]).join(" ");
  check("piping", "no placeholder left as text ([BRAND], [INSERT …], {Q4}, ${…})", !/\[(?:INSERT|BRAND|SUPERMARKET|Q\d)|(?<!\{)\{Q\d+\}(?!\})|\$\{/.test(all), (all.match(/\[(?:INSERT|BRAND|SUPERMARKET|Q\d)[^\]]*\]|(?<!\{)\{Q\d+\}(?!\})|\$\{[^}]*\}/g) ?? []).join(" "));
  for (const [c, ...refs] of e.logic) {
    const dl = JSON.stringify(byCode(c)?.displayLogic ?? null);
    for (const [src, code] of refs) {
      const id = byCode(src)?.id;
      check("logic", `${c} display logic reads ${src} = ${code}`, dl.includes(`"ref":"${id}"`) && new RegExp(`"value":${code}\\b`).test(dl.split(`"ref":"${id}"`).slice(1).join("")), dl.slice(0, 120));
    }
  }
  const ends = [];
  const we = (ns) => { for (const x of ns) { if (x.type === "end") ends.push(x); if (x.children) we(x.children); for (const b of x.branches ?? []) we(b.children); if (x.otherwise) we(x.otherwise); } };
  we(def.flow);
  for (const en of e.ends ?? []) check("logic", `an end “${en.status}” redirecting with ${en.redirect}`, ends.some((x) => x.status === en.status && x.redirectUrl?.includes(en.redirect)), ends.map((x) => `${x.status} ${x.redirectUrl ?? ""}`).join("; "));

  const v = verifyImport(a.canonical, a.result);
  const d = v.dynamics;
  r.runtime = d ? { passed: d.passed, failed: d.failed, scenarios: d.scenarios.length, error: d.error } : null;
  r.dims.runtime = { ok: d?.passed ?? 0, of: d?.scenarios.length ?? 0 };
  total.runtime.ok += d?.passed ?? 0; total.runtime.of += d?.scenarios.length ?? 0;
  for (const s of d?.scenarios ?? []) if (s.result === "fail") r.checks.push({ dim: "runtime", what: s.id, ok: false, got: `want ${s.expected}, engine ${s.observed}` });
  r.reconstruction = a.report?.reconstruction?.counts;
  out.push(r);
}

const pct = (x) => (x.of ? `${((100 * x.ok) / x.of).toFixed(1)}%` : "n/a");
let misses = 0;
for (const r of out) {
  console.log(`\n${r.file}  ${dims.map((d) => `${d} ${r.dims[d].ok}/${r.dims[d].of}`).join(" · ")}${r.reconstruction ? `  · reconstruction ${JSON.stringify(r.reconstruction)}` : ""}`);
  for (const c of r.checks.filter((x) => !x.ok)) { misses++; console.log(`  MISS [${c.dim}] ${c.what} — got ${c.got}`); }
}
console.log(`\nTOTAL (${out.length} files, synthetic corpus)`);
for (const d of dims) console.log(`  ${d.padEnd(13)} ${String(total[d].ok).padStart(3)}/${String(total[d].of).padEnd(3)} ${pct(total[d])}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ files: out, total }, null, 1));
process.exit(misses ? 1 : 0);
