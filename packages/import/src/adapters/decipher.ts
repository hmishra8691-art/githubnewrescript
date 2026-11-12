import type {
  CanonicalVendor, CanonicalSurveyOptions, RequiredFile,
  CanonicalSurvey, CanonicalQuestion, CanonicalOption, CanonicalRow, CanonicalValidation, CanonicalCustom,
  CanonicalEmbeddedField, CFlow, CExpr, CRef, COp, CLoop, CanonicalKind, Issue,
} from "../canonical.js";
import { plainText, exprHasRaw } from "../canonical.js";
import { parseXml, kids, kid, type XmlNode } from "../xml.js";
import { exclusive, expandCounts, inlineDispatchers, readDispatchers, readExecAssignments, type Dispatcher, type ExecRow } from "./decipherExec.js";

/**
 * A third-party fraud / duplicate service wired into the survey (Research Defender: `RD_*` hidden questions filled
 * by API calls in <exec>, `researchdefender` / `resdefcomplete` components). It is not carried: the calls cannot run
 * here, and the platform's own quality rules do that job. Said once in the report, not once per element.
 */
const FRAUD_SERVICE = /\bRD_|researchdefender|resdefcomplete|rdsecured\.com\/api|rtymgt\.com/i;

/**
 * DECIPHER XML → CANONICAL (§2, §4–§9 for Decipher).
 *
 * A Decipher project is one XML document: `<survey>` holding, in respondent
 * order, questions (`<radio>`, `<checkbox>`, `<select>`, `<text>`,
 * `<textarea>`, `<number>`, `<float>`, `<html>`), page breaks
 * (`<suspend/>`), containers (`<block>`, `<loop>`), flow control (`<term>`
 * ends the interview, `<goto>` jumps), Python (`<exec>`, `<validate>`, every
 * `cond="…"`), sample sources (`<var>` URL variables) and quota markers.
 *
 * A question's dimensions decide its kind: rows alone are options; rows and
 * columns make a grid; a `<number>` with rows is a numeric list. Its
 * `label` is its identity AND its variable, so `q7` stays `q7`.
 *
 * Conditions are Python. The common vocabulary — `q1.r2`, `q1.r2.c3`,
 * `q3.ival > 17`, `q2.any`, `q2.count >= 2`, `and / or / not`, `in` — is
 * translated; anything else is kept as `raw` Python with the question labels
 * it mentions, and reported. Required-ness follows Decipher's default: every
 * question is required unless it says `optional="1"`.
 */

/** the source's own speeding / straight-lining bookkeeping: hidden counters filled by code that walks every question */
const QUALITY_CHECK = /^(straightLine\w*|straightLiner|speeder)$/i;

const QTAGS = new Set(["radio", "checkbox", "select", "text", "textarea", "number", "float", "html", "autosum", "rank"]);

export function readDecipher(textIn: string, fileName: string, fp: string): CanonicalSurvey {
  const issues: Issue[] = [];
  /*
   * A LABEL THAT CARRIES THE LOOP VARIABLE — `label="B01_[loopvar: label]"` — is Decipher naming each iteration's
   * copy of one question. Here a looped question is ONE question whose answers are kept per item, so the suffix is
   * dropped from labels and from the references to them (it used to become a second, orphaned variable).
   */
  const text = textIn.replace(/(?<=[A-Za-z0-9])(?<!\.r)_?\[loopvar:\s*label\](?=["._])/g, "");
  const doc = parseXml(text, { keepInner: (n) => n === "title" || n === "comment" || n === "row" || n === "col" || n === "choice" || n === "html" || n === "noanswer" || n === "term" || n === "exec" || n === "validate" });
  for (const e of doc.errors.slice(0, 5)) issues.push({ location: fileName, type: "parse", severity: "low", message: `XML: ${e}`, autoAttempted: true });
  const root = doc.root;
  const base = { platform: "decipher" as const, format: "decipher" as const, fileName, fingerprint: fp };
  if (!root || root.name !== "survey") {
    return { source: base, questions: [], flow: [], embedded: [], quotas: [], custom: [], issues: [...issues, { location: fileName, type: "parse", severity: "high", message: "The XML has no <survey> root.", autoAttempted: false }] };
  }

  const questions = new Map<string, CanonicalQuestion>();
  const dims = new Map<string, { rows: boolean; cols: boolean }>();
  const custom: CanonicalCustom[] = [];
  const embedded: CanonicalEmbeddedField[] = [];
  const defines = new Map<string, XmlNode[]>();
  for (const d of findDeep(root, "define")) if (d.attrs.label) defines.set(d.attrs.label, kids(d, "row"));

  /* sample sources: the URL variables a panel passes in */
  for (const ss of findDeep(root, "samplesources")) {
    for (const v of findDeep(ss, "var")) {
      const name = v.attrs.name;
      if (name && !embedded.some((e) => e.name === name)) embedded.push({ name, source: "url", dataType: "string", sourceType: `sample source variable${v.attrs.unique === "1" ? " (unique)" : ""}` });
    }
  }

  /* URL variables the survey itself declares (extraVariables), beside Decipher's own bookkeeping ones */
  for (const name of (root.attrs.extraVariables ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/^(ipAddress|source|record|decLang|list|userAgent|rd_proj_ud)$/.test(name) || embedded.some((e) => e.name === name)) continue;
    embedded.push({ name, source: "url", dataType: "string", sourceType: "extra URL variable" });
  }

  /* helper functions defined in <exec> that conditions call with a literal — read by shape, never run (decipherExec.ts) */
  const dispatchers: Dispatcher[] = findDeep(root, "exec").flatMap((x) => { const code = x.inner ?? x.text; return /\bdef\s+\w+\(/.test(code) ? readDispatchers(code) : []; });
  let fraudDropped = 0;
  const qualityDropped = new Set<string>();

  /* first pass: every question, so conditions can resolve labels */
  const collectQ = (n: XmlNode) => { for (const c of n.children) { if (QTAGS.has(c.name) && c.attrs.label && FRAUD_SERVICE.test(`${c.attrs.label} ${c.attrs.uses ?? ""}`)) { fraudDropped++; } else if (QTAGS.has(c.name) && c.attrs.label && QUALITY_CHECK.test(c.attrs.label)) { qualityDropped.add(c.attrs.label); } else if (QTAGS.has(c.name) && c.attrs.label) { const q = readQuestion(c, defines, issues); questions.set(q.sourceId, q); dims.set(q.sourceId, { rows: q.rows.length > 0, cols: q.kind.startsWith("matrix") }); } else if (c.name === "block" || c.name === "loop") collectQ(c); } };
  collectQ(root);

  /*
   * NAMED CONDITIONS — `<condition label="adult" cond="q1.ival >= 18"/>`, used
   * as `condition.adult` anywhere a cond is. They were reported as "expanded
   * wherever used" and then not expanded, so every condition naming one was
   * unreadable and dropped. Each use is replaced by its definition, bracketed
   * so its own AND / OR keep their meaning, and a definition that uses
   * another is expanded too (cycles stop after a few levels).
   */
  const namedConds = new Map<string, string>();
  for (const cn of findDeep(root, "condition")) if (cn.attrs.label && cn.attrs.cond) namedConds.set(cn.attrs.label, cn.attrs.cond);
  const expandNamed = (src: string): string => {
    let out = src;
    for (let pass = 0; pass < 6 && /\bcondition\.\w+/.test(out); pass++) {
      out = out.replace(/\bcondition\.(\w+)/g, (m, label: string) => (namedConds.has(label) ? `(${namedConds.get(label)})` : m));
    }
    return out;
  };
  const urlVars = new Set(embedded.map((e) => e.name));
  let liveAssumed = false;
  const prepare = (src: string): string => {
    /* "is this the live survey?" is yes for every respondent a published survey has */
    let out = rewriteIdioms(src).replace(/\btimeSpent\(\)/g, "__elapsed__")
      /* anyCodes(Q, ['r1', 'ch:2-5']) — "any of these answers"; a `prefix:a-b` entry is a run of labels */
      .replace(/\banyCodes\(\s*(\w+)\s*,\s*\[([^\]]*)\]\s*\)/g, (m, qid: string, list: string) => {
        const q = questions.get(qid); if (!q) return m;
        const has = (l: string) => q.options.some((o) => o.sourceId === l) || q.rows.some((r) => r.sourceId === l);
        const labels = [...list.matchAll(/['"]([^'"]+)['"]/g)].flatMap((x) => { const r = /^(\w+):(\d+)-(\d+)$/.exec(x[1]); return r ? Array.from({ length: Number(r[3]) - Number(r[2]) + 1 }, (_v, i) => `${r[1]}${Number(r[2]) + i}`).filter(has) : [x[1]]; });
        return labels.length && labels.every(has) ? `(${labels.map((l) => `${qid}.${l}`).join(" or ")})` : m;
      })
      /* Q.c1.all — every row answered c1; Q.all — every answer selected */
      .replace(/\b(\w+)\.(c\d+)\.all\b/g, (m, qid: string, col: string) => { const q = questions.get(qid); return q && q.rows.length && q.options.some((o) => o.sourceId === col) ? `(${q.rows.map((r) => `${qid}.${r.sourceId}.${col}`).join(" and ")})` : m; })
      .replace(/\b(\w+)\.all\b/g, (m, qid: string) => { const q = questions.get(qid); return q && q.kind === "multi" && q.options.length ? `(${q.options.map((o) => `${qid}.${o.sourceId}`).join(" and ")})` : m; })
      .replace(/\bgv\.survey\.root\.state\.live\b/g, () => { liveAssumed = true; return "True"; });
    for (let pass = 0; pass < 4; pass++) { const next = expandNamed(inlineDispatchers(expandCounts(out), dispatchers).text); if (next === out) break; out = next; }
    return out;
  };
  const cond = (src: string | undefined, location: string, into: Issue[] = issues): CExpr | undefined => {
    if (!src || src.trim() === "1" || src.trim() === "True") return undefined;
    return readPython(prepare(src), location, questions, into, urlVars);
  };
  for (const d of dispatchers) issues.push({ location: `def ${d.name}()`, type: "converted", severity: "info", message: `The helper ${d.name}() is replaced by the condition it tests wherever it is called (${d.cases.size} cases)${d.sideEffects.length ? `; it also ${d.sideEffects.join(" and ")}, which is not reproduced` : ""}.`, autoAttempted: true });

  /**
   * AN <exec> THAT CODES HIDDEN QUESTIONS becomes auto-punch rules on them (decipherExec.ts idiom 1). All of it or
   * none: every target must be a question here, every option one it has, every guard a condition that reads.
   */
  /* the rows a `for row in Q.rows:` walks — a grid's rows, otherwise the answers */
  const rowsOf = (id: string): ExecRow[] | null => { const q = questions.get(id); if (!q) return null; return (q.rows.length ? q.rows.map((r) => ({ label: r.sourceId, value: String(r.code) })) : q.options.map((o) => ({ label: o.sourceId, value: String(o.code) }))); };
  const execToPunches = (code: string, where: string): true | null | string => {
    const read = readExecAssignments(code, rowsOf);
    if (!read) return null;
    const scratch: Issue[] = [];
    /* a row lookup is one leaf per option; a position is the option at that position */
    const leaves: { target: string; option: string; guard: string; single: boolean; at: number[] }[] = [];
    for (const l of read) {
      const q = questions.get(l.target);
      if (!q) return `${l.target} is not a question in this survey`;
      if (l.index !== undefined) { const o = q.options[l.index]; if (!o) return `${l.target} has no answer at position ${l.index}`; leaves.push({ target: l.target, option: o.sourceId, guard: l.guard, single: true, at: l.at }); }
      else leaves.push({ target: l.target, option: l.option, guard: l.guard, single: l.single, at: l.at });
    }
    const rules: { q: CanonicalQuestion; option: string; when?: CExpr }[] = [];
    /* an assignment that waits on one of the source's own quality counters (not carried) can never apply here */
    const dead = (g: string) => [...qualityDropped].some((d) => new RegExp(`\\b${d}\\b`).test(g)) || /\btimeSpent\(\)/.test(g);
    for (let k = leaves.length - 1; k >= 0; k--) if (dead(leaves[k].guard)) leaves.splice(k, 1);
    for (const [i, l] of leaves.entries()) {
      const q = questions.get(l.target)!;
      let when = l.guard ? cond(l.guard, where, scratch) : undefined;
      /* an assignment that can never run (`if row.label != "r9"` on row r9) names nothing that has to exist */
      if (!scratch.length && when?.t === "const" && !when.value) continue;
      if (!q.options.some((o) => o.sourceId === l.option)) return `${l.target} has no answer ${l.option}`;
      if (scratch.length || (when && when.t === "raw")) return `the condition “${l.guard.slice(0, 140)}” could not be read`;
      /* one answer: an assignment further down the block replaces this one, so this one holds only when none of those do */
      if (l.single) {
        const later = leaves.slice(i + 1).filter((x) => x.target === l.target && x.single && x.option !== l.option && !exclusive(l.at, x.at));
        const parts: CExpr[] = when ? [when] : [];
        for (const x of later) {
          if (!x.guard) { parts.length = 0; parts.push({ t: "const", value: false }); break; }
          const g = cond(x.guard, where, scratch);
          if (scratch.length || !g || g.t === "raw") return `the condition “${x.guard.slice(0, 140)}” could not be read`;
          parts.push(g.t === "const" ? { t: "const", value: !g.value } : { t: "group", op: "not", children: [g] });
        }
        when = parts.length === 0 ? undefined : fold("and", parts);
        if (when?.t === "const" && when.value === false) continue;
      }
      if (when?.t === "const") { if (!when.value) continue; when = undefined; }
      rules.push({ q, option: l.option, ...(when ? { when } : {}) });
    }
    if (!rules.length) return read.length && !leaves.length ? true : "no assignment in it can ever apply";
    for (const r of rules) (r.q.punches ??= []).push({ option: r.option, ...(r.when ? { when: r.when } : {}) });
    const targets = [...new Set(rules.map((r) => r.q.sourceId))];
    issues.push({ location: where, type: "converted", severity: "info", message: `Python <exec> that codes ${targets.join(", ")} became ${rules.length} auto-punch rule${rules.length === 1 ? "" : "s"}.`, autoAttempted: true, refs: targets });
    return true;
  };

  /*
   * COMPANION FILES. Decipher keeps quotas in a quota sheet and lets <exec> look answers up in data files
   * (`Zipfile = File("zipstate.dat", "id")`, a MaxDiff design). Neither is in the XML. Everything that waits on
   * one is gathered under that file, so the report asks for the file once and says what it will switch on.
   */
  const required = new Map<string, RequiredFile>();
  const need = (kind: RequiredFile["kind"], name: string, why: string, element: string, key?: string) => {
    const f = required.get(name) ?? { kind, name, why, neededFor: [], ...(key ? { key } : {}) };
    if (!f.neededFor.includes(element)) f.neededFor.push(element);
    required.set(name, f);
  };
  const QUOTA_SHEET = "quota sheet";
  const fileVars = new Map<string, { file: string; key?: string }>();
  for (const x of findDeep(root, "exec")) {
    const code = x.inner ?? x.text;
    for (const m of code.matchAll(/(\w+)\s*=\s*File\(\s*["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?/g)) fileVars.set(m[1], { file: m[2], ...(m[3] ? { key: m[3] } : {}) });
    for (const m of code.matchAll(/(\w+)\s*=\s*setupMaxDiffFile\(\s*["']([^"']+)["']/g)) fileVars.set(m[1], { file: m[2] });
  }
  /* variables filled from a file lookup (`respInfo = Zipfile.get(S5.val)`) lead back to the file too */
  for (const x of findDeep(root, "exec")) for (const m of (x.inner ?? x.text).matchAll(/(\w+)\s*=\s*(\w+)\.get\(/g)) { const f = fileVars.get(m[2]); if (f && !fileVars.has(m[1])) fileVars.set(m[1], f); }
  /* a question whose own <exec> reads a file: code that reads or orders that question waits on the same file */
  const fileOfQuestion = new Map<string, { file: string; key?: string }>();
  { const scan = (n: XmlNode) => { for (const c of n.children) { if (QTAGS.has(c.name) && c.attrs.label) for (const v of kids(c, "exec")) { const code = v.inner ?? v.text; const hit = [...fileVars].find(([name]) => new RegExp(`\\b${name}\\b`).test(code)) ?? (/File\(\s*["']([^"']+)["']/.exec(code) ? ["", { file: /File\(\s*["']([^"']+)["']/.exec(code)![1] }] as const : undefined); if (hit) fileOfQuestion.set(c.attrs.label.replace(/_?\[loopvar:\s*label\]$/, ""), hit[1]); } scan(c); } }; scan(root); }
  /** the file an <exec> waits on, if it waits on one: registers the need and returns true */
  const waitsOnFile = (code: string, element: string): boolean => {
    if (/\bhasMarker\(|getQuotaCells\(|\bp\.markers\b/.test(code)) { need("quota_sheet", QUOTA_SHEET, "Decipher's quota sheet holds the quota cells and their targets, and fills the hidden “picker” questions by least-fill", element); return true; }
    const direct = /File\(\s*["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?|setupMaxDiffFile\(\s*["']([^"']+)["']/.exec(code);
    const via = [...fileVars].find(([v]) => new RegExp(`\\b${v}\\b`).test(code));
    const dependent = [...fileOfQuestion].find(([label]) => new RegExp(`\\b${label}\\b`).test(code));
    const f = direct ? { file: direct[1] ?? direct[3], key: direct[2] } : via?.[1] ?? dependent?.[1];
    if (!f) return /\bsetupMaxDiffItems\w*\(|_expanded\.order\.index\(/.test(code) && [...fileVars.values()].some((v) => /maxdiff/i.test(v.file)) ? (need("data_file", [...fileVars.values()].find((v) => /maxdiff/i.test(v.file))!.file, "the MaxDiff design: which items each version and task shows", element), true) : false;
    need("data_file", f.file, /maxdiff/i.test(f.file) ? "the MaxDiff design: which items each version and task shows" : `a lookup table${f.key ? ` keyed by “${f.key}”` : ""} that <exec> code reads answers from`, element, f.key);
    return true;
  };

  /*
   * "THE ROW WITH THE SAME ATTRIBUTE" — `for row in T.rows: if row.styles.cs.panel == S.selected.styles.cs.panel:
   * T.val = row.index`: T takes the row whose cs:panel equals that of S's selected answer. The attributes are in
   * the XML, so it is written out as plain assignments: `if S.r1 or S.r4: T.val = 0`.
   */
  const joinByRowAttribute = (code: string, target: XmlNode): string => {
    const m = /^\s*for\s+(\w+)\s+in\s+(\w+)\.rows\s*:\s*\n\s*if\s+\1\.styles\.cs\.(\w+)\s*==\s*(\w+)\.selected\.styles\.cs\.\3\s*:\s*\n\s*\2\.val\s*=\s*\1\.index\s*$/.exec(code.replace(/\r/g, ""));
    const src = m ? findDeep(root, "radio").concat(findDeep(root, "select")).find((x) => x.attrs.label === m[4]) : undefined;
    /* `for row in T.rows: if Q.check(row.o.alt): T.val = row.index` — each row's own range is in its alt="18-24" */
    const byAlt = /^\s*(?:if\s+(.+?):\s*\n\s*)?for\s+(\w+)\s+in\s+(\w+)\.rows\s*:\s*\n\s*(\w+)\s*=\s*\2\.o\.alt[^\n]*\n\s*if\s+(\w+)\.check\(\s*\4\s*\)\s*:\s*\n\s*\3\.val\s*=\s*\2\.index\s*(?:\n\s*break\s*)?$/.exec(code.replace(/\r/g, ""));
    if (byAlt && target.attrs.label === byAlt[3]) {
      const rows = kids(target, "row");
      if (rows.length && rows.every((r) => /^(?:[\d\s,-]+|\s*(?:>=|<=|>|<)\s*\d+\s*)$/.test(r.attrs.alt ?? ""))) return rows.map((r, i) => `if ${byAlt[1] ? `(${byAlt[1]}) and ` : ""}${byAlt[5]}.check('${r.attrs.alt.trim()}'):\n  ${byAlt[3]}.val = ${i}`).join("\n");
    }
    if (!m || !src || target.attrs.label !== m[2]) return code;
    const attr = `cs:${m[3]}`;
    const lines = kids(target, "row").map((r, i) => { const same = kids(src, "row").concat(kids(src, "choice")).filter((x) => x.attrs[attr] !== undefined && x.attrs[attr] === r.attrs[attr]).map((x) => `${m[4]}.${x.attrs.label}`); return same.length ? `if ${same.join(" or ")}:\n  ${m[2]}.val = ${i}` : ""; }).filter(Boolean);
    return lines.length ? lines.join("\n") : code;
  };

  /** code that changes no routing and no answer a respondent gives: said for what it is, at medium */
  const softExec = (code: string, host: string): Pick<Issue, "type" | "severity" | "message" | "suggestion" | "autoAttempted"> | null => {
    const bare = code.replace(/^\s*#.*$/gm, "");
    if (/\btimeSpent\(\)/.test(bare) && /(?:^|\n)\s*(?:p\.\w+\s*=\s*timeSpent\(\)|\w+\.val\s*=\s*\(?\s*timeSpent\(\)\s*-\s*p\.\w+)/.test(bare)) return { type: "unsupported", severity: "medium", message: `${host ? `${host} records` : "Python code records"} how long a section took (timeSpent() between two points). That stopwatch is not reproduced; the time on every page is recorded with the response.`, suggestion: "Read the section time from the page timings in the data.", autoAttempted: false };
    if (/^\s*group_rows\(/.test(bare) && !/\.val\s*=/.test(bare)) return { type: "unsupported", severity: "medium", message: `${host} keeps sets of rows together when its rows are shuffled (group_rows). The grouping is not reproduced: the rows shuffle one by one.`, suggestion: "Use option groups on the question if the sets must stay together.", autoAttempted: false };
    if (/^\s*def\s+\w+\(/m.test(bare) && !/^\S/m.test(bare.replace(/^def\s[^\n]*\n(?:[ \t]+[^\n]*\n?|\s*\n)*/gm, ""))) return { type: "custom_logic", severity: "medium", message: `A library of Python helper functions (${[...bare.matchAll(/^def\s+(\w+)/gm)].map((m) => m[1]).join(", ")}) is defined here. Functions that conditions call were replaced by what they test; the others are used by validation or exec code that is reported where it is used.`, suggestion: "Nothing to do for the library itself.", autoAttempted: true };
    return null;
  };

  /* a block of `def`s none of which is called anywhere outside the block */
  const unusedHelpers = (code: string): boolean => {
    const rest = text.split(code).join("");
    const outside = text.includes(code) ? rest : text.replace(/<exec[\s\S]*?<\/exec>/g, (m) => (/^\s*(?:<exec[^>]*>)?\s*(?:#[^\n]*\n\s*)*def\s/.test(m) ? "" : m));
    return [...code.matchAll(/^def\s+(\w+)/gm)].every((m) => !new RegExp(`\\b${m[1]}\\(`).test(outside));
  };

  /* second pass: the flow */
  const quotaMarkers: string[] = [];
  const loopKinds: string[] = [];
  const options: CanonicalSurveyOptions = {};
  const orderCopies: string[] = [];
  let execWhy: true | null | string = null;
  let lastQ: CanonicalQuestion | null = null;
  const readChildren = (n: XmlNode, path: string): CFlow[] => {
    const out: CFlow[] = [];
    let pages: string[][] = [[]];
    let blockSeq = 0;
    /*
     * A COUNTER OVER ROWS — `cnt = 0; for xr in S12.rows: if <test on xr>: cnt += 1` — then `if cnt ge 4:`. There
     * is no "count the rows that…" condition, but there is "count the answers selected": the rows that pass the
     * test are coded into a hidden multiple-choice helper (one answer per row), and the counter becomes that
     * helper's count. The helper sits on the page of the code that used the counter, and is named for it.
     */
    const withCounter = (code: string, host: string): string => {
      const src = code.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\r/g, "");
      const m = /^[ \t]*(\w+)\s*=\s*0[ \t]*\n(?:[ \t]*(\w+)\s*=\s*\[([^\]]*)\][ \t]*\n)?\s*for\s+(\w+)\s+in\s+(\w+)\.rows\s*:[ \t]*\n[ \t]*if\s+(.+?):[ \t]*\n(?:[ \t]*if\s+(.+?):[ \t]*\n)?[ \t]*\1\s*\+=\s*1[ \t]*\n/m.exec(src);
      const grid = m ? questions.get(m[5]) : undefined;
      if (!m || !grid || !grid.rows.length || grid.rows.length > 60) return code;
      const [, counter, listName, listBody, v, qid, c1, c2] = m;
      const list = listBody !== undefined ? [...listBody.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]) : [];
      const helperId = `${host}_${counter}`;
      if (questions.has(helperId)) return code;
      const scratch: Issue[] = [];
      const rules: { option: string; when?: CExpr }[] = [];
      for (const row of grid.rows) {
        const text = [c1, c2].filter(Boolean).map((c) => `(${c})`).join(" and ")
          .replace(new RegExp(`\\b${v}\\.displayed\\b`, "g"), "True")
          .replace(new RegExp(`\\b${v}\\.label\\s+in\\s+${listName ?? "\\w+"}\\b`, "g"), listName && list.includes(row.sourceId) ? "True" : "False")
          .replace(new RegExp(`(\\w+)\\[\\s*${v}\\s*\\]`, "g"), `$1.${row.sourceId}`)
          .replace(new RegExp(`\\b${v}\\.(?=c\\d|val\\b|ival\\b|any\\b)`, "g"), `${qid}.${row.sourceId}.`);
        if (new RegExp(`\\b${v}\\b`).test(text)) return code;
        const when = cond(text, `${host} · counter ${counter}`, scratch);
        if (scratch.length || (when && exprHasRaw(when))) return code;
        if (when?.t === "const" && !when.value) continue;
        rules.push({ option: row.sourceId, ...(when && when.t !== "const" ? { when } : {}) });
      }
      const helper: CanonicalQuestion = {
        sourceId: helperId, variable: helperId, text: `Counter “${counter}” of ${host}: the rows of ${qid} that pass its test`, kind: "multi", sourceType: "exec counter",
        options: grid.rows.map((r, i) => ({ sourceId: r.sourceId, code: i + 1, label: r.label })), rows: [], required: false, validation: [], skips: [], custom: [], confidence: "confirmed",
        notes: [`added by the import: the source counts rows of ${qid} in Python (“${counter}”); here the rows that pass are this hidden question's answers, and the count is how many are selected`], settings: { hidden: true }, punches: rules,
      };
      questions.set(helperId, helper);
      pages[pages.length - 1].push(helperId);
      issues.push({ location: `${host} · <exec>`, type: "converted", severity: "low", message: `The Python counter “${counter}” (how many rows of ${qid} pass a test) became a hidden helper question, ${helperId}, with ${rules.length} auto-punch rules; conditions on the counter read how many of its answers are selected.`, autoAttempted: true, refs: [host, qid] });
      return src.replace(m[0], "").replace(new RegExp(`\\b${counter}\\b`, "g"), `${helperId}.count`);
    };
    const flush = () => {
      const ps = pages.filter((p) => p.length);
      if (ps.length) out.push({ t: "block", sourceId: `${path}_part${++blockSeq}`, pages: ps });
      pages = [[]];
    };
    for (const c of n.children) {
      if (QTAGS.has(c.name) && c.attrs.label && !questions.has(c.attrs.label)) {
        /* a fraud-service element (dropped in the first pass) */
      } else if (QTAGS.has(c.name) && c.attrs.label) {
        const q = questions.get(c.attrs.label)!;
        for (const v of kids(c, "exec")) {
          const code = (v.inner ?? v.text).trim();
          if (!code) continue;
          if (/^(?:\s*\w+\.(?:rows|cols)\.order\s*=\s*\w+\.(?:rows|cols)\.order\s*)+$/.test(code)) { orderCopies.push(...[...code.matchAll(/(\w+)\.(?:rows|cols)\.order\s*=\s*(\w+)\./g)].map((m) => `${m[1]} ← ${m[2]}`)); continue; }
          const done = execToPunches(withCounter(joinByRowAttribute(code, c), q.sourceId), `${q.sourceId} · <exec>`);
          if (done === true) continue;
          if (waitsOnFile(code, q.sourceId)) { q.custom.push({ language: "python", code, location: q.sourceId, role: "exec in question (waits on a companion file)", refs: pyRefs(code, questions) }); q.confidence = "review"; continue; }
          q.custom.push({ language: "python", code, location: q.sourceId, role: `exec in question${v.attrs.when ? ` (${v.attrs.when})` : ""}`, refs: pyRefs(code, questions) });
          const soft = softExec(code, q.sourceId);
          if (soft) { issues.push({ location: `${q.sourceId} · <exec>`, ...soft }); continue; }
          issues.push({ location: `${q.sourceId} · <exec>`, type: "custom_logic", severity: "high", message: /\bhasMarker\(|getQuotaCells\(/.test(code) ? `${q.sourceId} is filled from Decipher's quota sheet (a picker / least-fill assignment that reads quota markers). The quota sheet is not part of the XML, so the assignment could not be rebuilt.` : done === null ? `${q.sourceId} runs Python code, which has no direct Rescript equivalent.` : `${q.sourceId} runs Python code that codes hidden variables, which could not be converted: ${done}.`, suggestion: "Recreate it as auto-punch rules on the hidden question.", autoAttempted: true, refs: [q.sourceId] });
          q.confidence = "review";
        }
        q.displayLogic = cond(c.attrs.cond, `${q.sourceId} · cond`);
        for (const r of kids(c, "row")) { const o = q.options.find((x) => x.sourceId === r.attrs.label); if (o && r.attrs.cond) o.displayLogic = cond(r.attrs.cond, `${q.sourceId}.${r.attrs.label} · cond`); }
        pages[pages.length - 1].push(q.sourceId);
        lastQ = q;
      } else if (c.name === "suspend") {
        if (pages[pages.length - 1].length) pages.push([]);
      } else if (c.name === "block") {
        flush();
        const inner = readChildren(c, c.attrs.label || `${path}_block`);
        /* `cond="Q.r[loopvar:label]"` inside a loop over Q's selected answers is that loop's own filter */
        const isLoopFilter = /^\w+\.r?\[loopvar:\s*label\]$/.test((c.attrs.cond ?? "").trim()) && loopKinds[loopKinds.length - 1] === "question";
        const when = isLoopFilter ? undefined : cond(c.attrs.cond, `block ${c.attrs.label ?? "?"} · cond`);
        const randomize = c.attrs.randomize === "1" || c.attrs.randomizeChildren === "1";
        const group: CFlow = { t: "group", sourceId: c.attrs.label || `${path}_b${out.length}`, title: c.attrs.builder_title || c.attrs["builder:title"] || c.attrs.label, children: randomize ? [{ t: "randomizer", sourceId: `${c.attrs.label}_rand`, children: inner }] : inner };
        out.push(when ? { t: "branch", sourceId: `${c.attrs.label}_cond`, when, children: [group], description: `block ${c.attrs.label} cond` } : group);
      } else if (c.name === "loop") {
        flush();
        const loop = readLoop(c, issues, questions);
        loopKinds.push(loop.kind);
        const inner = readChildren(c, c.attrs.label || `${path}_loop`);
        loopKinds.pop();
        /* over a question's answers the item's text IS the answer's label: `[loopvar: name]` reads that */
        if (loop.kind === "question") {
          const names = (c.attrs.vars ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          const re = names.length ? new RegExp(`\\{\\{loop\\.(?:${names.join("|")})\\}\\}`, "g") : null;
          const fix = (t: string | undefined) => (t && re ? t.replace(re, "{{loop.label}}") : t);
          const inside = (n: XmlNode): string[] => n.children.flatMap((k) => (QTAGS.has(k.name) && k.attrs.label ? [k.attrs.label] : inside(k)));
          for (const id of inside(c)) { const q = questions.get(id); if (!q) continue; q.text = fix(q.text) ?? q.text; q.instruction = fix(q.instruction); for (const o of q.options) o.label = fix(o.label) ?? o.label; for (const r of q.rows) r.label = fix(r.label) ?? r.label; }
        }
        // the loop's questions sit in one or more blocks; the first block carries the loop
        // (a <block> inside the loop reads as a group; its pages are the loop's pages)
        const flat = (xs: CFlow[]): CFlow[] => xs.flatMap((x) => (x.t === "group" && !("when" in x) ? flat(x.children) : [x]));
        const body = flat(inner);
        const first = body.find((x) => x.t === "block") as Extract<CFlow, { t: "block" }> | undefined;
        if (first && body.length === 1) { first.loop = loop; first.title ??= c.attrs.label; out.push(first); }
        else {
          /* every page of the body, however deep — a question inside a conditional block of the loop is still in the loop */
          const pagesOf = (xs: CFlow[]): string[][] => xs.flatMap((x) => (x.t === "block" ? x.pages : "children" in x && Array.isArray(x.children) ? pagesOf(x.children as CFlow[]) : []));
          const always = (x: CFlow): boolean => x.t === "block" || (x.t === "group" && x.children.every(always)) || (x.t === "branch" && x.when.t === "const" && x.when.value === false);
          const live = body.filter((x) => !(x.t === "branch" && x.when.t === "const" && x.when.value === false));
          const holder: Extract<CFlow, { t: "block" }> = { t: "block", sourceId: c.attrs.label || "loop", title: c.attrs.label, pages: pagesOf(live), loop }; out.push(holder);
          /* what the source switched off inside the loop (`cond="0"`) stays switched off, after it — its questions are kept, never asked */
          out.push(...body.filter((x) => !live.includes(x))); if (!body.every(always)) issues.push({ location: `loop ${c.attrs.label}`, type: "converted", severity: "medium", message: `Loop ${c.attrs.label} contains flow elements besides questions; its questions were kept in the loop, the other elements were not.`, autoAttempted: true });
        }
      } else if (c.name === "term" && FRAUD_SERVICE.test(`${c.attrs.label ?? ""} ${c.attrs.cond ?? ""}`)) {
        fraudDropped++;
      } else if (c.name === "term" && ([...qualityDropped].some((l) => new RegExp(`\\b${l}\\b`).test(c.attrs.cond ?? "")))) {
        qualityDropped.add(`term ${c.attrs.label ?? plainText(c.inner ?? c.text)}`);
      } else if (c.name === "term") {
        flush();
        const when = cond(c.attrs.cond, `term ${c.attrs.label ?? ""} · cond`) ?? { t: "const", value: true } as CExpr;
        /* a termination that is switched off (`cond="0"`, or a disposition defined as False) ends nobody: not carried */
        if (when.t === "const" && when.value === false) continue;
        /*
         * A termination whose condition could not be read is NOT carried as "terminate everyone" (it was). Nobody
         * is ended by it, and the report says which termination is missing and why.
         */
        if (exprHasRaw(when)) {
          const lookup = /\bp\.\w+/.test(c.attrs.cond ?? "") ? [...fileVars.values()].find((f) => !/maxdiff/i.test(f.file)) : undefined;
          const waits = lookup ? { name: lookup.file, why: `a lookup table${lookup.key ? ` keyed by “${lookup.key}”` : ""} that <exec> code reads answers from` } : undefined;
          if (waits) need("data_file", waits.name, waits.why, `termination ${c.attrs.label ?? ""} (${plainText(c.inner ?? c.text)})`, lookup?.key);
          const at = issues.findIndex((i) => i.location === `term ${c.attrs.label ?? ""} · cond`);
          const line: Issue = { location: `term ${c.attrs.label ?? ""}`, type: "custom_logic", severity: waits ? "medium" : "high", message: `The termination “${plainText(c.inner ?? c.text) || c.attrs.label}” (${(c.attrs.cond ?? "").trim()}) was not carried: its condition reads ${/\bp\.\w+/.test(c.attrs.cond ?? "") ? "a counter kept by Python code (how many times an answer was refused)" : "something that could not be converted"}. Nobody is ended by it here.${waits ? ` It belongs with the lookup in “${waits.name}”: once that file is in, an answer the file does not know can end the interview.` : ""}`, suggestion: "Add the termination in Architect once its rule is decided.", autoAttempted: true };
          if (at >= 0) issues[at] = line; else issues.push(line);
          continue;
        }
        /* a quality termination (speeding, straight-lining, a failed check) is "terminated"; the rest are screen-outs */
        const quality = /speed|straight|quality|fraud|dupe|duplicate|attention|trap|cheat|bot\b/i.test(`${c.attrs.label ?? ""} ${c.attrs.markers ?? ""} ${plainText(c.inner ?? c.text)}`);
        out.push({ t: "branch", sourceId: c.attrs.label || `term_${out.length}`, when, children: [{ t: "end", sourceId: `${c.attrs.label || "term"}_end`, status: quality ? "terminated" : "screened", message: plainText(c.inner ?? c.text) || undefined }], description: `terminate: ${plainText(c.inner ?? c.text)}` });
      } else if (c.name === "goto") {
        const target = c.attrs.target;
        if (lastQ && target) {
          const when = cond(c.attrs.cond, `goto ${target}`) ?? { t: "const", value: true } as CExpr;
          /* a jump to a block is a jump to the first question in it */
          const blockFirst = questions.has(target) ? undefined : findDeep(root, "block").filter((b) => b.attrs.label === target).flatMap((b) => { const first = (n: XmlNode): string[] => n.children.flatMap((k) => (QTAGS.has(k.name) && questions.has(k.attrs.label) ? [k.attrs.label] : first(k))); return first(b); })[0];
          (lastQ as CanonicalQuestion).skips.push({ when, to: questions.has(target) ? { kind: "question", id: target } : blockFirst ? { kind: "question", id: blockFirst } : { kind: "block", id: target } });
        } else issues.push({ location: `goto ${target ?? "?"}`, type: "structure", severity: "medium", message: "A <goto> with no question before it could not be attached.", autoAttempted: false });
      } else if (c.name === "exec") {
        const code = (c.inner ?? c.text).trim();
        if (code && FRAUD_SERVICE.test(code)) fraudDropped++;
        else if (code && /^\s*def\s+\w+\(/m.test(code) && readDispatchers(code).length && !code.replace(/^\s*#.*$/gm, "").split(/^def\s/m).slice(1).some((f) => !dispatchers.some((d) => f.startsWith(`${d.name}(`)))) { /* only helpers that were inlined: nothing left to keep */ }
        else if (code && /^(?:\s*\w+(?:\.rows|_expanded)\.order\s*=\s*\w+\.rows\.order\s*)+$/.test(code)) orderCopies.push(...[...code.matchAll(/(\w+?)(?:\.rows|_expanded)\.order\s*=\s*(\w+)\.rows/g)].map((m) => `${m[1]} ← ${m[2]}`));
        else if (code && /^if gv\.survey\.root\.state\.live:\s*(?:gv\.survey\.root\.styles\.ss\.\w+\s*=\s*\d\s*)+$/.test(code)) {
          if (/disableBackButton\s*=\s*1/.test(code)) { options.backButton = false; issues.push({ location: "exec at survey start", type: "converted", severity: "info", message: "The Back button is switched off, as the source does for its live survey.", autoAttempted: true }); }
        }
        else if (code && /^\w+\.val\s*=\s*str\(gv\.survey\.path\)[^\n]*$/.test(code)) issues.push({ location: "survey id", type: "dropped", severity: "info", message: "A hidden variable that records Decipher's own project path was not filled: the project has its own id here.", autoAttempted: true });
        else if (code && /^(?:\s*setMarker\(\s*["'][^"']*["']\s*\)\s*)+$/.test(code)) issues.push({ location: lastQ ? `exec after ${(lastQ as CanonicalQuestion).sourceId}` : "exec at survey start", type: "dropped", severity: "info", message: `A marker (${[...code.matchAll(/setMarker\(\s*["']([^"']*)["']/g)].map((m) => m[1]).join(", ")}) is a tag on the response for Decipher's reports; nothing in the survey reads it, so it was not carried.`, autoAttempted: true });
        else if (code && /^\s*def\s+\w+\(/m.test(code) && !/^\S/m.test(code.replace(/^\s*#.*$/gm, "").replace(/^def\s[^\n]*\n(?:[ \t]+[^\n]*\n?|\s*\n)*/gm, "")) && unusedHelpers(code)) issues.push({ location: "helper functions", type: "dropped", severity: "info", message: `A library of Python helper functions (${[...code.matchAll(/^def\s+(\w+)/gm)].map((m) => m[1]).join(", ")}) is defined but never called in this survey; it was not carried.`, autoAttempted: true });
        else if (code && waitsOnFile(code, lastQ ? `code after ${(lastQ as CanonicalQuestion).sourceId}` : "code at the start")) custom.push({ language: "python", code, location: lastQ ? `after ${(lastQ as CanonicalQuestion).sourceId}` : "survey start", role: "exec (waits on a companion file)", refs: pyRefs(code, questions) });
        else if (code && /^(?:\s*p\.\w+\s*=\s*\d+\s*)+$/.test(code)) { /* a Python counter set to its starting value: nothing to carry on its own */ }
        else if (code && softExec(code, "")) { custom.push({ language: "python", code, location: lastQ ? `after ${(lastQ as CanonicalQuestion).sourceId}` : "survey start", role: "exec", refs: pyRefs(code, questions) }); issues.push({ location: lastQ ? `exec after ${(lastQ as CanonicalQuestion).sourceId}` : "exec at survey start", ...softExec(code, "")! }); }
        else if (code && (execWhy = execToPunches(code, lastQ ? `exec after ${(lastQ as CanonicalQuestion).sourceId}` : "exec at survey start")) === true) { /* converted */ }
        else if (code) {
          custom.push({ language: "python", code, location: lastQ ? `after ${(lastQ as CanonicalQuestion).sourceId}` : "survey start", role: `exec${c.attrs.when ? ` (${c.attrs.when})` : ""}`, refs: pyRefs(code, questions) });
          issues.push({ location: lastQ ? `exec after ${(lastQ as CanonicalQuestion).sourceId}` : "exec at survey start", type: "custom_logic", severity: "high", message: `Python <exec> code has no direct Rescript equivalent${pyRefs(code, questions).length ? ` (reads ${pyRefs(code, questions).join(", ")})` : ""}${typeof execWhy === "string" ? `: it codes hidden variables, but ${execWhy}` : ""}.`, suggestion: "It is kept, disabled, in Scripts. Ask “what could not be migrated?” in Intelligent mode and press Analyze; most execs set a hidden variable, which a calculation can do.", autoAttempted: false, refs: pyRefs(code, questions) });
        }
      } else if (c.name === "quota") {
        quotaMarkers.push(c.attrs.sheet ?? c.attrs.label ?? "?");
        need("quota_sheet", QUOTA_SHEET, "Decipher's quota sheet holds the quota cells and their targets, and fills the hidden “picker” questions by least-fill", `checkpoint ${c.attrs.sheet ?? c.attrs.label ?? "?"}`);
      } else if (["samplesources", "define", "res", "style", "themevars", "note", "condition", "pipe", "marker", "logic", "languages", "datasource", "looprow", "stylevar", "label"].includes(c.name)) {
        /* configuration, not flow: read elsewhere, or not needed */
      } else if (c.name === "finish") {
        flush();
        out.push({ t: "end", sourceId: "finish", status: "complete" });
      } else if (c.name && !c.name.startsWith("builder")) {
        issues.push({ location: `<${c.name}>`, type: "unsupported", severity: "low", message: `Decipher element <${c.name}> was not reproduced.`, autoAttempted: false });
      }
    }
    flush();
    return out;
  };
  const flow = readChildren(root, "survey");

  /* one line per companion file: what to send, and what it switches on */
  for (const f of required.values()) issues.push({ location: f.kind === "quota_sheet" ? "quota sheet" : `data file ${f.name}`, type: "unsupported", severity: "high", message: f.kind === "quota_sheet"
    ? `The quota sheet is needed. ${f.why}; it is not part of the XML, so no quota was created and ${f.neededFor.filter((x) => !x.startsWith("checkpoint ")).length} hidden question(s) are not filled. Waiting on it: ${f.neededFor.join(", ")}.`
    : `The data file “${f.name}” is needed: ${f.why}. It is not part of the XML. Waiting on it: ${f.neededFor.join(", ")}.`,
    suggestion: f.kind === "quota_sheet" ? "Send the quota sheet (the project's quota.xls, or an Excel / CSV with the cells and targets) in Intelligent mode; the quotas and the picker questions are then built from it." : `Send “${f.name}” (the tab-delimited file from the Decipher project) in Intelligent mode; the lookup is then rebuilt from it.`, autoAttempted: false });
  if (fraudDropped) issues.push({ location: "fraud service", type: "dropped", severity: "info", message: `${fraudDropped} element${fraudDropped === 1 ? "" : "s"} of a third-party fraud service (hidden questions, API calls and the terminations that read them) were not carried. Response quality is handled by the platform's own quality rules.`, autoAttempted: true });
  if (orderCopies.length) issues.push({ location: "row order", type: "unsupported", severity: "medium", message: `${orderCopies.length} question${orderCopies.length === 1 ? "" : "s"} show their rows in the order another question was shown in (${orderCopies.slice(0, 10).join(", ")}). That link is not reproduced: each question orders its own rows.`, suggestion: "If the shared order matters, turn randomisation off on both, or use the same fixed order.", autoAttempted: false });
  if (qualityDropped.size) issues.push({ location: "quality checks", type: "dropped", severity: "low", message: `The source's own speeding and straight-lining checks (${[...qualityDropped].join(", ")}) were not carried: they are Python that walks every question and reads the quota sheet. The platform's quality rules cover speeding and straight-lining.`, suggestion: "Set the thresholds in Quality rules.", autoAttempted: true });
  if (liveAssumed) issues.push({ location: "live / test", type: "converted", severity: "low", message: "Code that asks whether the survey is live (gv.survey.root.state.live) is read as live: a published survey's respondents are live, and test data is kept apart by the platform.", autoAttempted: true });
  const vendors = readVendors(root, issues);

  // named conditions: <condition label="adult" cond="q1.ival >= 18"/> are referenced as condition.adult — kept for the report
  for (const cn of findDeep(root, "condition")) if (cn.attrs.label && cn.attrs.cond) issues.push({ location: `condition.${cn.attrs.label}`, type: "converted", severity: "info", message: `Named condition ${cn.attrs.label} (${cn.attrs.cond}) is expanded wherever it is used.`, autoAttempted: true });

  return {
    source: { ...base, title: root.attrs.alt || root.attrs.name || undefined, language: root.attrs.language || undefined },
    questions: [...questions.values()], flow, embedded, quotas: [], custom, issues, ...(required.size ? { requiredFiles: [...required.values()] } : {}), ...(vendors.length ? { vendors } : {}), ...(Object.keys(options).length ? { options } : {}),
  };

  /* ------------------------------------------------------------ helpers */
}

/**
 * SAMPLE SUPPLIERS. A <samplesource> with a unique URL variable and <exit url=…> links is a supplier: its id
 * parameter, its other variables, and the return link per outcome. Exits that only show text are not suppliers.
 */
function readVendors(root: XmlNode, issues: Issue[]): CanonicalVendor[] {
  const out: CanonicalVendor[] = [];
  for (const ss of findDeep(root, "samplesource")) {
    const vars = kids(ss, "var").filter((v) => v.attrs.name);
    const exits = kids(ss, "exit").filter((e) => /^https?:\/\//.test((e.attrs.url ?? "").trim()));
    const idVar = vars.find((v) => v.attrs.unique === "1") ?? vars.find((v) => exits.some((e) => e.attrs.url.includes(`\${${v.attrs.name}}`)));
    if (!exits.length || !idVar) continue;
    const name = plainText(kid(ss, "title")?.inner ?? kid(ss, "title")?.text ?? "") || `Sample source ${ss.attrs.list ?? out.length + 1}`;
    const idParam = idVar.attrs.name;
    const redirects: CanonicalVendor["redirects"] = {};
    for (const e of exits) {
      const c = (e.attrs.cond ?? "").replace(/\s+/g, " ").trim();
      const url = e.attrs.url.trim().replace(/\$\{(\w+)\}/g, (_m, v: string) => (v === idParam ? "{{pid}}" : `{{${v}}}`));
      const oc = /^qualified\b/.test(c) ? "complete" : /^overquota\b/.test(c) ? "quota_full" : /^terminated\b/.test(c) ? (/and\s+not\b/.test(c) || !/\band\b/.test(c) ? "screenout" : "terminate") : undefined;
      if (!oc) { issues.push({ location: `samplesource ${name}`, type: "unsupported", severity: "medium", message: `${name} has a return link for “${c}”, which is not one of the four outcomes; it was not carried.`, autoAttempted: true }); continue; }
      redirects[oc] ??= url;
    }
    if (!Object.keys(redirects).length) continue;
    out.push({ sourceId: ss.attrs.list ?? String(out.length + 1), name, idParam, params: vars.map((v) => v.attrs.name).filter((v) => v !== idParam), redirects });
  }
  return out;
}

function findDeep(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of n.children) { if (c.name === name) out.push(c); findDeep(c, name, out); }
  return out;
}

const inner = (n: XmlNode | undefined) => plainText(n ? n.inner ?? n.text : "");

function readQuestion(n: XmlNode, defines: Map<string, XmlNode[]>, issues: Issue[]): CanonicalQuestion {
  const label = n.attrs.label;
  const rowsX = [...kids(n, "row"), ...kids(n, "insert").flatMap((i) => defines.get(i.attrs.source) ?? [])];
  const colsX = kids(n, "col");
  const choicesX = kids(n, "choice");
  const noans = kids(n, "noanswer");
  const notes: string[] = [];
  const custom: CanonicalCustom[] = [];
  /* `where="execute…"` runs the question's code without showing it — Decipher's standard hidden variable; so does a `where` without "survey" */
  const hidden = n.attrs.where !== undefined && (/\bexecute\b/.test(n.attrs.where) || !/survey/.test(n.attrs.where));
  const optional = n.attrs.optional === "1";
  const toOpt = (x: XmlNode, i: number, exclusive = false): CanonicalOption => {
    const code = x.attrs.value ?? (/^[rc](\d+)$/.test(x.attrs.label ?? "") ? Number(/\d+/.exec(x.attrs.label)![0]) : x.attrs.label ?? String(i + 1));
    return { sourceId: x.attrs.label ?? `r${i + 1}`, code: /^-?\d+$/.test(String(code)) ? Number(code) : String(code), label: inner(x), ...(exclusive || x.attrs.exclusive === "1" ? { exclusive: true } : {}), ...(x.attrs.open === "1" ? { otherSpecify: true } : {}), ...(x.attrs.randomize === "0" ? { anchor: true } : {}) };
  };
  const toRow = (x: XmlNode, i: number): CanonicalRow => ({ sourceId: x.attrs.label ?? `r${i + 1}`, code: x.attrs.label ?? `r${i + 1}`, label: inner(x) });
  const q: CanonicalQuestion = {
    sourceId: label, variable: label, text: decipherPiping(inner(kid(n, "title"))), instruction: inner(kid(n, "comment")) || undefined,
    kind: "unknown", sourceType: n.name, options: [], rows: [], required: !optional && n.name !== "html", validation: [], skips: [], custom, confidence: "confirmed", notes,
  };
  const grid = rowsX.length > 0 && colsX.length > 0;
  const kind = (k: CanonicalKind) => { q.kind = k; };
  switch (n.name) {
    case "radio":
      if (grid) { kind("matrix_single"); q.rows = rowsX.map(toRow); q.options = colsX.map((x, i) => toOpt(x, i)); }
      else { kind("single"); q.options = (rowsX.length ? rowsX : colsX).map((x, i) => toOpt(x, i)); }
      break;
    case "checkbox":
      if (grid) { kind("matrix_multi"); q.rows = rowsX.map(toRow); q.options = colsX.map((x, i) => toOpt(x, i)); }
      else { kind("multi"); q.options = (rowsX.length ? rowsX : colsX).map((x, i) => toOpt(x, i)); }
      if (n.attrs.atleast && Number(n.attrs.atleast) > 1) q.validation.push({ kind: "min_selections", value: Number(n.attrs.atleast) });
      if (n.attrs.atmost) q.validation.push({ kind: "max_selections", value: Number(n.attrs.atmost) });
      if (n.attrs.exactly) { q.validation.push({ kind: "min_selections", value: Number(n.attrs.exactly) }, { kind: "max_selections", value: Number(n.attrs.exactly) }); }
      if (n.attrs.atleast === "0") q.required = false;
      break;
    case "select":
      q.options = choicesX.map((x, i) => toOpt(x, i));
      if (rowsX.length) { kind("matrix_dropdown"); q.rows = rowsX.map(toRow); } else kind("dropdown");
      break;
    case "text": case "textarea":
      if (rowsX.length || colsX.length) { kind(grid ? "matrix_text" : "text"); q.rows = (rowsX.length ? rowsX : colsX).map(toRow); }
      else kind(n.name === "textarea" ? "textarea" : "text");
      break;
    case "number": case "float":
      if (grid) { kind("matrix_numeric"); q.rows = rowsX.map(toRow); q.options = colsX.map((x, i) => toOpt(x, i)); notes.push("the columns of a numeric grid were kept as its column labels"); q.confidence = "review"; }
      else if (rowsX.length || colsX.length) { kind("matrix_numeric"); q.rows = (rowsX.length ? rowsX : colsX).map(toRow); }
      else kind("numeric");
      if (n.name === "number") q.validation.push({ kind: "integer" });
      break;
    case "autosum": kind("constant_sum"); q.options = rowsX.map((x, i) => toOpt(x, i)); if (n.attrs.amount) q.validation.push({ kind: "sum_equals", value: Number(n.attrs.amount) }); break;
    case "rank": kind("ranking"); q.options = rowsX.map((x, i) => toOpt(x, i)); break;
    case "html": kind("descriptive"); q.text = decipherPiping(plainText(n.inner ?? n.text)) || q.text; q.required = false; break;
  }
  for (const [i, x] of noans.entries()) q.options.push(toOpt(x, q.options.length + i, true));
  if (n.attrs.shuffle && /rows/.test(n.attrs.shuffle) || n.attrs.randomize === "1") q.randomizeOptions = true;
  if (hidden) {
    notes.push(`where="${n.attrs.where}" — not shown to respondents`);
    /* a hidden choice question stays a choice question, hidden: its options are what conditions, quotas and punch rules name */
    if (q.kind === "single" || q.kind === "multi" || q.kind === "dropdown") { q.settings = { ...(q.settings ?? {}), hidden: true }; q.required = false; }
    else if (q.kind !== "descriptive") { q.settings = { ...(q.settings ?? {}), sourceKind: q.kind }; kind("hidden"); q.required = false; }
  }
  /* verify="…" */
  const verify = n.attrs.verify ?? "";
  for (const m of verify.matchAll(/(range|len)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)) {
    if (m[1] === "range") q.validation.push({ kind: "min_value", value: Number(m[2] ) }, { kind: "max_value", value: Number(m[3]) });
    else q.validation.push({ kind: "min_length", value: Number(m[2]) }, { kind: "max_length", value: Number(m[3]) });
  }
  if (/\bemail\b/.test(verify)) q.validation.push({ kind: "email" });
  if (/zipcode|postal/.test(verify)) q.validation.push({ kind: "zip" });
  if (/phone/.test(verify)) q.validation.push({ kind: "phone" });
  if (verify && !/^(?:\s*(?:range|len)\([^)]*\)|\s*email|\s*zipcode|\s*phone\w*|\s*digits|\s*,)+\s*$/.test(verify)) notes.push(`verify="${verify}" partly carried`);
  if (n.attrs.size && q.kind === "text") { /* display width, not validation */ }
  /* inline Python */
  for (const v of kids(n, "validate")) {
    const code = (v.inner ?? v.text).trim();
    if (!code) continue;
    custom.push({ language: "python", code, location: label, role: "validate", refs: [] });
    issues.push({ location: `${label} · <validate>`, type: "custom_logic", severity: "medium", message: `${label} has a Python <validate> block, which was not converted.`, suggestion: "Analyze it in Intelligent mode, or recreate it as a Condition validation rule.", autoAttempted: false, refs: [label] });
    q.confidence = "review";
  }
  /* <exec> inside the question is read in the flow pass (readDecipher): converted to auto-punch rules, or reported there */
  if (q.kind === "unknown") { q.confidence = "unsupported"; issues.push({ location: label, type: "unsupported", severity: "high", message: `${label} is a Decipher <${n.name}> with no Rescript equivalent.`, autoAttempted: false, refs: [label] }); }
  return q;
}

function readLoop(n: XmlNode, issues: Issue[], questions: Map<string, CanonicalQuestion>): CLoop {
  /*
   * A LOOP OVER WHAT WAS SELECTED: every <looprow cond="Q.rN"> (or the body's `cond="Q.r[loopvar:label]"`) names the
   * same question, one option per row. That is a loop over Q's selected answers, not a fixed list with conditions.
   */
  const rows = kids(n, "looprow");
  const body = kids(n, "block").map((b) => /^(\w+)\.r?\[loopvar:\s*label\]$/.exec((b.attrs.cond ?? "").trim())?.[1]);
  const perRow = rows.map((lr) => /^(\w+)\.(\w+)$/.exec((lr.attrs.cond ?? "").trim()));
  const owner = perRow.length && perRow.every((m) => m && m[1] === perRow[0]![1]) ? perRow[0]![1] : body.length === 1 && body[0] ? body[0] : undefined;
  const oq = owner ? questions.get(owner) : undefined;
  const norm = (t: string) => plainText(t).replace(/\s+/g, " ").trim().toLowerCase();
  if (oq && rows.length && rows.every((lr, i) => { const o = perRow[i]?.[2] ?? (/^\d+$/.test(lr.attrs.label ?? "") ? `r${lr.attrs.label}` : lr.attrs.label); const opt = oq.options.find((x) => x.sourceId === o); const lv = kids(lr, "loopvar")[0]; return !!opt && (!lv || norm(lv.inner ?? lv.text) === norm(opt.label)); })) {
    const all = rows.length === oq.options.length;
    if (!all) issues.push({ location: `loop ${n.attrs.label ?? ""}`, type: "converted", severity: "medium", message: `Loop ${n.attrs.label ?? ""} repeats for ${rows.length} of the ${oq.options.length} answers of ${oq.sourceId}; here it repeats for every selected answer of ${oq.sourceId}.`, suggestion: "Check that the answers left out can never be selected, or add a condition.", autoAttempted: true, refs: [oq.sourceId] });
    return { kind: "question", questionId: oq.sourceId, filter: "selected", loopVar: (n.attrs.vars ?? "").split(",")[0]?.trim() || "item", randomize: n.attrs.randomizeChildren === "1" };
  }
  const vars = (n.attrs.vars ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const items = kids(n, "looprow").map((lr, i) => {
    const fields: Record<string, string> = {};
    for (const lv of kids(lr, "loopvar")) if (lv.attrs.name) fields[lv.attrs.name] = plainText(lv.inner ?? lv.text);
    return { code: lr.attrs.label ?? String(i + 1), label: fields[vars[0]] ?? lr.attrs.label ?? String(i + 1), fields };
  });
  if (!items.length) issues.push({ location: `loop ${n.attrs.label ?? ""}`, type: "structure", severity: "medium", message: `Loop ${n.attrs.label ?? ""} has no <looprow> items.`, autoAttempted: false });
  return { kind: "static", items, fieldNames: vars, loopVar: vars[0] || "item", randomize: n.attrs.randomizeChildren === "1" };
}

/** Decipher piping: [loopvar: brand], [pipe: name], ${q1.selected.text} */
export function decipherPiping(s: string): string {
  return s
    .replace(/\[loopvar:\s*(\w+)\s*\]/g, "{{loop.$1}}")
    .replace(/\$\{\s*(\w+)\.(?:selected\.text|text|val|ival|value)\s*\}/g, "{{@$1}}")
    .replace(/\$\{\s*(\w+)\s*\}/g, "{{@$1}}")
    .replace(/\[pipe:\s*(\w+)\s*\]/g, "{{@$1}}");
}

/**
 * Decipher idioms rewritten into plain comparisons before the condition is read:
 *   Q.check('18-24')            → (Q.val ge 18 and Q.val le 24)        — also '1,3-5'
 *   (Q.ival + 1) in [7, 20]     → Q.ival in [6, 19]
 */
export function rewriteIdioms(src: string): string {
  return src
    .replace(/(\w+)\.check\(\s*['"]([\d\s,<>=-]+)['"]\s*\)/g, (_m, q: string, spec: string) => `(${spec.split(",").map((part) => { const cmp = /^\s*(>=|<=|>|<)\s*(\d+)\s*$/.exec(part); if (cmp) return `${q}.val ${({ ">=": "ge", "<=": "le", ">": "gt", "<": "lt" } as Record<string, string>)[cmp[1]]} ${cmp[2]}`; const [a, b] = part.trim().split("-").map((x) => x.trim()); return b === undefined ? `${q}.val == ${a}` : `(${q}.val ge ${a} and ${q}.val le ${b})`; }).join(" or ")})`)
    .replace(/\(\s*(\w+\.i?val)\s*([+-])\s*(\d+)\s*\)\s+in\s+\[([\d\s,]+)\]/g, (_m, ref: string, sign: string, k: string, list: string) => `${ref} in [${list.split(",").map((x) => Number(x.trim()) + (sign === "+" ? -Number(k) : Number(k))).join(", ")}]`);
}

/* ------------------------------------------------------------ Python conditions */

type Tok = { k: "id" | "num" | "str" | "op" | "punct" | "kw"; v: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|('[^']*'|"[^"]*")|(==|!=|<=|>=|<|>)|([()[\],])|(and|or|not|in|is|lt|gt|le|ge|eq|ne)\b|([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    i = re.lastIndex;
    if (m[1]) out.push({ k: "num", v: m[1] });
    else if (m[2]) out.push({ k: "str", v: m[2].slice(1, -1) });
    else if (m[3]) out.push({ k: "op", v: m[3] });
    else if (m[4]) out.push({ k: "punct", v: m[4] });
    else if (m[5]) out.push(WORD_OP[m[5]] ? { k: "op", v: WORD_OP[m[5]] } : { k: "kw", v: m[5] });
    else if (m[6]) out.push({ k: "id", v: m[6] });
  }
  return out;
}

/** Decipher's word comparisons (XML attributes cannot hold `<`) */
const WORD_OP: Record<string, string> = { lt: "<", gt: ">", le: "<=", ge: ">=", eq: "==", ne: "!=" };
/** `float(str(Q.val))` is `Q.val`: the casts change nothing a comparison reads */
const stripCasts = (s: string): string => { let out = s; for (let i = 0; i < 6; i++) { const n = out.replace(/\b(?:float|int|str|bool)\(([^()]*)\)/g, "$1"); if (n === out) break; out = n; } return out; };
/** AND / OR with a constant in it: `X and 0` is never, `X or 1` is always, the neutral constant just drops out */
function fold(op: "and" | "or", parts: CExpr[]): CExpr {
  const absorbing = op === "or";
  if (parts.some((x) => x.t === "const" && x.value === absorbing)) return { t: "const", value: absorbing };
  const rest = parts.filter((x) => x.t !== "const");
  if (!rest.length) return { t: "const", value: !absorbing };
  return rest.length === 1 ? rest[0] : { t: "group", op, children: rest };
}

const CMP: Record<string, COp> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };

export function readPython(src: string, location: string, questions: Map<string, CanonicalQuestion>, issues: Issue[], vars: ReadonlySet<string> = new Set()): CExpr {
  const raw = (reason: string): CExpr => {
    const refs = pyRefs(src, questions);
    issues.push({ location, type: "custom_logic", severity: "high", message: `The Python condition “${src.trim()}” could not be converted (${reason}).`, suggestion: "Rebuild it in the Logic builder, or analyze it in Intelligent mode.", autoAttempted: true, refs });
    return { t: "raw", text: src.trim(), language: "python", refs, reason };
  };
  const toks = tokenize(stripCasts(src));
  if (!toks) return raw("unrecognised syntax");
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => { const t = toks[p]; if (v && t?.v !== v) throw new Error(`expected ${v}`); p++; return t; };
  const orE = (): CExpr => { const parts = [andE()]; while (peek()?.v === "or") { eat(); parts.push(andE()); } return fold("or", parts); };
  const andE = (): CExpr => { const parts = [notE()]; while (peek()?.v === "and") { eat(); parts.push(notE()); } return fold("and", parts); };
  const notE = (): CExpr => {
    if (peek()?.v === "not") { eat(); const inner = notE(); if (inner.t === "cmp" && inner.op === "selected") return { ...inner, op: "notSelected" }; if (inner.t === "cmp" && inner.op === "answered") return { ...inner, op: "unanswered" }; if (inner.t === "const") return { t: "const", value: !inner.value }; return { t: "group", op: "not", children: [inner] }; }
    return cmpE();
  };
  const value = (): string | number | (string | number)[] => {
    const t = eat();
    if (t.k === "num") return Number(t.v);
    if (t.k === "str") return t.v;
    if (t.v === "[" || t.v === "(") { const close = t.v === "[" ? "]" : ")"; const items: (string | number)[] = []; while (peek() && peek().v !== close) { const v = value(); if (Array.isArray(v)) throw new Error("nested list"); items.push(v); if (peek()?.v === ",") eat(); } eat(close); return items; }
    if (t.k === "id") { const r = refOf(t.v); if (r.kind === "option") return r.code; }
    throw new Error(`unexpected ${t.v}`);
  };
  /** q1.r2 → selected; q1.r2.c3 → cell; q1.any; q1.count; q1.val / ival */
  const refOf = (id: string): { kind: "sel"; ref: CRef } | { kind: "val"; ref: CRef } | { kind: "any"; ref: CRef } | { kind: "count"; ref: CRef } | { kind: "shown"; ref: CRef } | { kind: "option"; code: string | number } | { kind: "none" } => {
    const parts = id.split(".");
    const q = questions.get(parts[0]);
    /* timeSpent(): seconds since the interview started — a native behaviour source */
    if (id === "__elapsed__") return { kind: "val", ref: { kind: "behavior", id: "elapsed" } };
    /* a URL / sample variable (`s == '2'`, `sid == '15'`) */
    if (!q && parts.length === 1 && vars.has(id)) return { kind: "val", ref: { kind: "embedded", id } };
    if (!q) { const opt = /^r(\d+)$/.exec(id); return opt ? { kind: "option", code: Number(opt[1]) } : { kind: "none" }; }
    const ref: CRef = { kind: "question", id: q.sourceId };
    const rest = parts.slice(1);
    const grid = q.kind.startsWith("matrix");
    if (!rest.length) return { kind: "val", ref };
    const [a, b, c] = rest;
    if (a === "any") return { kind: "any", ref };
    if (a === "count") return { kind: "count", ref };
    if (a === "displayed") return { kind: "shown", ref };
    /* the sum of a question with one field is that field */
    if (a === "sum" && !q.rows.length && (q.kind === "numeric" || q.kind === "hidden")) return { kind: "val", ref };
    if (a === "val" || a === "ival" || a === "unsafe_val" || a === "text") return { kind: "val", ref };
    const isRow = q.rows.some((r) => r.sourceId === a) || (!grid && q.options.some((o) => o.sourceId === a));
    if (!isRow) return { kind: "none" };
    if (grid) {
      ref.row = a;
      if (b && q.options.some((o) => o.sourceId === b)) { ref.choice = b; return c === undefined ? { kind: "sel", ref } : { kind: "none" }; }
      if (!b || b === "any") return { kind: "any", ref };
      if (b === "val" || b === "ival") return { kind: "val", ref };
      return { kind: "none" };
    }
    ref.choice = a;
    if (b === "any") return { kind: "sel", ref };
    if (!b) return q.kind === "single" || q.kind === "multi" || q.kind === "dropdown" || q.kind === "hidden" ? { kind: "sel", ref } : { kind: "val", ref: { ...ref, choice: undefined, row: a } };
    if (b === "val" || b === "ival") return { kind: "val", ref: { ...ref, choice: undefined, row: a } };
    return { kind: "none" };
  };
  const cmpE = (): CExpr => {
    const t = peek();
    if (!t) throw new Error("unexpected end");
    if (t.v === "(") { eat(); const e = orE(); eat(")"); return e; }
    if (t.k === "kw" && (t.v === "True" || t.v === "False")) { eat(); return { t: "const", value: t.v === "True" }; }
    /* a bare number is a truth value: `cond="0"` is how a programmer switches something off */
    if (t.k === "num" && !(toks[p + 1]?.k === "op")) { eat(); return { t: "const", value: Number(t.v) !== 0 }; }
    if (t.k !== "id") throw new Error(`unexpected ${t.v}`);
    eat();
    if (t.v === "True" || t.v === "False") return { t: "const", value: t.v === "True" };
    const r = refOf(t.v);
    const next = peek();
    if (next && (next.k === "op" || next.v === "in" || (next.v === "not" && toks[p + 1]?.v === "in"))) {
      let op: COp;
      if (next.v === "not") { eat(); eat("in"); op = "notIn"; }
      else if (next.v === "in") { eat(); op = "in"; }
      else { eat(); op = CMP[next.v]; }
      const v = value();
      /*
       * THE VALUE OF A SINGLE CHOICE IS ITS POSITION. Decipher's `Q.val` / `Q.ival` on a radio or select is the
       * 0-based position of the selected answer (which is why programmers write `H.val = H.r2.index`), not a code.
       * A comparison with a number is therefore about WHICH ANSWERS, and is written as that.
       */
      const sq = r.kind === "val" && r.ref.kind === "question" && !r.ref.row && !r.ref.choice ? questions.get(r.ref.id) : undefined;
      const nums = typeof v === "number" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null;
      if (sq && (sq.kind === "single" || sq.kind === "dropdown") && sq.options.length && nums && r.kind === "val") {
        const n = nums[0];
        const test = (i: number) => (op === "eq" ? i === n : op === "ne" ? i === n : op === "lt" ? i < n : op === "lte" ? i <= n : op === "gt" ? i > n : op === "gte" ? i >= n : nums.includes(i));
        const hit = sq.options.filter((_o, i) => test(i));
        const negative = op === "ne" || op === "notIn";
        const one = (o: CanonicalOption): CExpr => ({ t: "cmp", ref: { ...r.ref, choice: o.sourceId }, op: negative ? "notSelected" : "selected" });
        if (!hit.length) return { t: "const", value: negative };
        return hit.length === 1 ? one(hit[0]) : { t: "group", op: negative ? "and" : "or", children: hit.map(one) };
      }
      if (r.kind === "count") {
        /* `count != N` is NOT (count = N) — it used to become "count ≤ N", which also matches N itself */
        if (op === "ne") return { t: "group", op: "not", children: [{ t: "cmp", ref: r.ref, op: "countEq", value: v as number }] };
        return { t: "cmp", ref: r.ref, op: op === "gte" ? "countGte" : op === "lte" ? "countLte" : op === "eq" ? "countEq" : op === "gt" ? "countGte" : "countLte", value: op === "gt" ? Number(v) + 1 : op === "lt" ? Number(v) - 1 : (v as number) };
      }
      if (r.kind === "val" || r.kind === "sel" || r.kind === "any") return { t: "cmp", ref: r.ref, op, value: v };
      throw new Error(`cannot compare ${t.v}`);
    }
    if (next?.v === "(") throw new Error(`function call ${t.v}()`);
    if (r.kind === "shown") return { t: "cmp", ref: r.ref, op: "displayed" };
    if (r.kind === "sel") return { t: "cmp", ref: r.ref, op: "selected" };
    if (r.kind === "any") return { t: "cmp", ref: r.ref, op: "answered" };
    if (r.kind === "val") return { t: "cmp", ref: r.ref, op: "answered" };
    throw new Error(`${t.v} is not a question reference`);
  };
  try {
    const e = orE();
    if (p < toks.length) return raw(`unexpected “${toks[p].v}”`);
    return e;
  } catch (err) {
    return raw((err as Error).message);
  }
}

function pyRefs(code: string, questions: Map<string, CanonicalQuestion>): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)(?=\.|\b)/g)) if (questions.has(m[1])) out.add(m[1]);
  return [...out];
}

export type { CanonicalValidation };
