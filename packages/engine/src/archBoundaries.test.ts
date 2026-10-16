import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyDefinition, type Condition } from "@rescript/schema";
import {
  interpretRequest,
  createResponseState,
  quotaIncrements,
  tallyQuotaCells,
  rowToState,
  matchesResponseCondition,
  NON_RESPONDENT_QUESTION_TYPES,
  countRespondentQuestions,
  type QuotaCounts,
} from "./index.js";

/*
 * ARCHITECTURE RULES THAT USED TO BE PROSE (audit 2026-10-16, ARCH-03/08).
 *   • the engine is env-free: the NL interpreter's trace is an injected option
 *   • one loop turns respondents into quota cell counts (`tallyQuotaCells`,
 *     built on `quotaIncrements`), used by the runtime and the Studio recount
 *   • the TS question count and its SQL twin `rescript_question_count` exclude
 *     the same element types — read from the migration, not restated here
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");

const rule = (ref: string, operator: string, value: unknown): Condition => ({ type: "rule", source: { kind: "question", ref }, operator, value } as Condition);
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "AB", title: "Arch" },
    questions: [
      { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
      { id: "q2", code: "Q2", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "h1", code: "H1", variableName: "INTRO", type: "html", text: "Welcome" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["h1", "q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
    quotas: [
      { id: "qg", name: "Gender", cells: [{ id: "m", label: "Male", when: rule("q1", "eq", 1), limit: 10 }, { id: "f", label: "Female", when: rule("q1", "eq", 2), limit: 10 }] },
      { id: "qa", name: "Age", cells: [{ id: "young", label: "<35", when: rule("q2", "lt", 35), limit: 10 }, { id: "old", label: "35+", when: rule("q2", "gte", 35), limit: 10 }] },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });
}

/* ---------------------------------------------------------------- ARCH-03 */

test("ARCH-03: no engine source file reads process.env or imports a node: built-in", () => {
  const src = join(pkgRoot, "src");
  const offenders: string[] = [];
  for (const f of readdirSync(src)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f.endsWith(".d.ts")) continue;
    const text = readFileSync(join(src, f), "utf8");
    if (/\bprocess\.env\b/.test(text)) offenders.push(`${f}: process.env`);
    if (/from\s+["']node:/.test(text)) offenders.push(`${f}: node: import`);
  }
  assert.deepEqual(offenders, []);
});

test("ARCH-03: the interpreter's trace goes to an injected debug sink, never to the environment", () => {
  const def = survey();
  const lines: string[] = [];
  const out = interpretRequest(def, "make Q2 required", { debug: (l) => lines.push(l) });
  assert.equal(out.kind, "actions");
  assert.ok(lines.some((l) => l.startsWith("[nl] ")), `expected a trace line, got ${JSON.stringify(lines)}`);

  // the old env switch no longer does anything: default is silent
  const prevEnv = process.env.RESCRIPT_NL_DEBUG;
  const prevErr = console.error;
  const seen: unknown[] = [];
  process.env.RESCRIPT_NL_DEBUG = "1";
  console.error = (...a: unknown[]) => { seen.push(a); };
  try {
    const again = interpretRequest(def, "make Q2 required");
    assert.equal(again.kind, "actions");
  } finally {
    console.error = prevErr;
    if (prevEnv === undefined) delete process.env.RESCRIPT_NL_DEBUG; else process.env.RESCRIPT_NL_DEBUG = prevEnv;
  }
  assert.deepEqual(seen, []);
});

/* ---------------------------------------------------------------- ARCH-08b */

test("ARCH-08: tallyQuotaCells is quotaIncrements summed — one membership rule for live counting and recount", () => {
  const def = survey();
  const rows = [
    { session_id: "a", answers: { q1: 1, q2: 20 } },
    { session_id: "b", answers: { q1: 2, q2: 50 } },
    { session_id: "c", answers: { q1: 1, q2: 40 } },
    { session_id: "d", answers: { q2: 18 } },
  ];
  const counts: QuotaCounts = {};
  const n1 = tallyQuotaCells(def, rows.slice(0, 2).map((r) => rowToState(def, r)), counts);
  const n2 = tallyQuotaCells(def, rows.slice(2).map((r) => rowToState(def, r)), counts);
  assert.equal(n1 + n2, 4);
  assert.deepEqual(counts, { qg: { m: 2, f: 1 }, qa: { young: 2, old: 2 } });

  // the same answer, as a live runtime state and as a stored row, lands in the same cells
  const live = createResponseState(def, { sessionId: "a", seed: 1 });
  live.answers = { q1: 1, q2: 20 } as never;
  assert.deepEqual(quotaIncrements(def, live), quotaIncrements(def, rowToState(def, rows[0])));

  // and the per-cell filter verdict (the recount's old loop) agrees with it
  const viaFilter: QuotaCounts = {};
  for (const r of rows) for (const q of def.quotas) for (const c of q.cells) {
    if (!matchesResponseCondition(def, c.when, r)) continue;
    (viaFilter[q.id] ??= {})[c.id] = (viaFilter[q.id][c.id] ?? 0) + 1;
  }
  assert.deepEqual(viaFilter, counts);
});

test("ARCH-08: the Studio recount calls the engine helper instead of looping over cells itself", { skip: !existsSync(join(repoRoot, "apps/studio/lib/quotaRecount.ts")) }, () => {
  const text = readFileSync(join(repoRoot, "apps/studio/lib/quotaRecount.ts"), "utf8");
  assert.match(text, /tallyQuotaCells\(/);
  assert.doesNotMatch(text, /for \(const cell of quota\.cells\)/);
});

/* ---------------------------------------------------------------- ARCH-08a */

/** the body of the LAST migration that (re)defines rescript_question_count */
function sqlQuestionCount(): { file: string; body: string } | null {
  const dir = join(repoRoot, "supabase", "migrations");
  if (!existsSync(dir)) return null;
  let found: { file: string; body: string } | null = null;
  for (const f of readdirSync(dir).filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
    const sql = readFileSync(join(dir, f), "utf8");
    const m = /create\s+or\s+replace\s+function\s+public\.rescript_question_count\s*\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(sql);
    if (m) found = { file: f, body: m[1] };
  }
  return found;
}

test("ARCH-08: rescript_question_count (SQL) excludes exactly the types countRespondentQuestions (TS) excludes", { skip: !existsSync(join(repoRoot, "supabase", "migrations")) }, () => {
  const sql = sqlQuestionCount();
  assert.ok(sql, "rescript_question_count is defined in some migration");
  const notIn = /q\s*->>\s*'type'\s+not\s+in\s*\(([^)]*)\)/i.exec(sql.body);
  assert.ok(notIn, `${sql.file}: the type exclusion list was not found`);
  const sqlTypes = [...notIn[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(sqlTypes, [...NON_RESPONDENT_QUESTION_TYPES].sort(), `${sql.file} and questionCount.ts disagree`);
  // the structural half of the rule: pages at any depth, and the "no pages yet" fallback
  assert.match(sql.body, /@\.type == "page"/);
  assert.match(sql.body, /questionIds/);
  assert.match(sql.body, /not exists \(select 1 from placed\)/);
  // and the TS side applies that list
  assert.equal(countRespondentQuestions(survey()), 2);
});
