/**
 * A SURVEY DRAFT FROM A DATA FILE (2026-11-12): a CSV / Excel export of responses, or an SPSS .sav.
 *
 * A data file says what was RECORDED, not how the survey was PROGRAMMED. So everything this reader produces is
 * marked by where it came from, and the three are never mixed:
 *
 *   explicit   written in the file's own metadata: an SPSS variable label, SPSS value labels and missing values, a
 *              codebook sheet (variable / label / values) beside the data
 *   inferred   read off the variables' names and the values that occur: Q5_1…Q5_8 holding only 0 / 1 is a
 *              multiple choice; Q7_1…Q7_5 sharing one set of codes is a grid; a family whose values are a
 *              1…k ordering in every row is a ranking. Each inference says what it rests on, and is for review.
 *   unknown    not in the file at all, and NOT guessed: skip and display logic, piping, randomisation, quotas,
 *              whether a question was required, answer texts that no label gives. A column that is blank for some
 *              respondents is reported as "probably conditional" — the condition itself is never invented, because
 *              a pattern in the answers is not a rule in the questionnaire.
 *
 * The draft is one question per page, in the file's column order, with no logic.
 */
import type { CanonicalSurvey, CanonicalQuestion, CanonicalOption, CFlow, Issue, SourceFormat } from "../canonical.js";

export interface DataVariable {
  name: string;
  /** explicit: the variable's label */
  label?: string;
  /** explicit: code → label */
  values?: [string, string][];
  /** explicit: codes declared missing / special */
  missing?: string[];
  /** string variable (SPSS), when the file says */
  string?: boolean;
  /** the values that occur, when the file has rows */
  observed?: string[];
  /** rows with a value / rows in all */
  filled?: number;
}

const SYSTEM = /^(?:id|uuid|guid|record(?:id)?|resp(?:ondent)?_?id|response_?id|case_?id|serial|caseid|start(?:_?(?:date|time))?|end(?:_?(?:date|time))?|date|timestamp|submit(?:ted)?(?:_?at)?|duration(?:_in_seconds)?|status|finished|progress|ip(?:_?address)?|user_?agent|language|locale|weight|wt|source|panel|pid|rid|psid|latitude|longitude|location\w*|recipient\w*|external\w*|distribution\w*|qtime|vos|vbrowser|vmobile\w*|markers|list|dcua|url|session\w*)$/i;
const isInt = (s: string) => /^-?\d+$/.test(s);
const isNum = (s: string) => /^-?\d+(?:\.\d+)?$/.test(s);
const binaryLabels = (vals: [string, string][]) => vals.length <= 2 && vals.every(([, l]) => /^(?:yes|no|selected|not selected|checked|unchecked|ticked|not ticked|mentioned|not mentioned|quoted|not quoted|0|1)$/i.test(l.trim()));

/** is this table a set of responses (a header of variable names over rows of codes) rather than a questionnaire written as a table? */
export function looksLikeDataFile(rows: string[][]): boolean {
  if (rows.length < 4) return false;
  const head = rows[0].map((c) => c.trim());
  if (head.length < 3) return false;
  if (head.some((h) => /^(?:question(?: ?text)?|type|question ?type|options?|answers?|choices|response options|logic|routing|instruction)$/i.test(h))) return false;
  const idish = head.filter((h) => /^[A-Za-z_][\w.]*$/.test(h) && h.length <= 40).length / head.length;
  const body = rows.slice(1, 60);
  const cells = body.flatMap((r) => r.slice(0, head.length)).filter((c) => c.trim() !== "");
  const short = cells.filter((c) => isNum(c.trim()) || c.trim().length <= 3).length / Math.max(1, cells.length);
  return idish >= 0.8 && short >= 0.6 && new Set(head).size === head.length;
}

/** a codebook sheet: variable | label | values ("1=Yes; 2=No") — in any column order, by header word */
export function readCodebook(rows: string[][]): Map<string, { label?: string; values?: [string, string][] }> | null {
  if (rows.length < 2) return null;
  const head = rows[0].map((c) => c.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const v = col(/^(?:variable|var|name|variable ?name|column|field)$/), l = col(/^(?:label|question|question ?text|description|variable ?label|text)$/), vals = col(/^(?:values?|value ?labels?|codes?|categories|answers?|options?)$/);
  if (v < 0 || (l < 0 && vals < 0)) return null;
  const out = new Map<string, { label?: string; values?: [string, string][] }>();
  for (const r of rows.slice(1)) {
    const name = (r[v] ?? "").trim();
    if (!name) continue;
    const pairs = vals >= 0 ? [...(r[vals] ?? "").matchAll(/(-?\d+)\s*[=:)\-–]\s*([^;|\n]+?)(?=\s*(?:[;|\n]|$))/g)].map((m): [string, string] => [m[1], m[2].trim()]) : [];
    out.set(name, { ...(l >= 0 && (r[l] ?? "").trim() ? { label: r[l].trim() } : {}), ...(pairs.length ? { values: pairs } : {}) });
  }
  return out.size ? out : null;
}

/** the variables of a response table: the header row, the values each column takes, and a codebook's labels when there is one */
export function variablesFromRows(rows: string[][], codebook: Map<string, { label?: string; values?: [string, string][] }> | null): { vars: DataVariable[]; respondents: number; table: string[][] } {
  const head = rows[0].map((c) => c.trim());
  /* a second header row of question texts (Qualtrics-style exports): every cell is words, none is a code */
  const second = rows[1] ?? [];
  const labelRow = second.filter((c) => c.trim()).length >= head.length * 0.6 && second.filter((c) => c.trim()).every((c) => !isNum(c.trim())) && second.some((c) => /\s/.test(c.trim()));
  const body = rows.slice(labelRow ? 2 : 1).filter((r) => r.some((c) => c.trim() !== ""));
  const vars = head.map((name, i): DataVariable => {
    const col = body.map((r) => (r[i] ?? "").trim());
    const cb = codebook?.get(name);
    return { name, ...(cb?.label ? { label: cb.label } : labelRow && second[i]?.trim() ? { label: second[i].trim() } : {}), ...(cb?.values ? { values: cb.values } : {}), observed: [...new Set(col.filter((c) => c !== ""))].slice(0, 400), filled: col.filter((c) => c !== "").length };
  });
  return { vars, respondents: body.length, table: [head, ...body] };
}

export function readDataFile(vars: DataVariable[], meta: { fileName: string; format: SourceFormat; fingerprint: string; title?: string; rows?: string[][]; respondents?: number }): CanonicalSurvey {
  const issues: Issue[] = [];
  const questions: CanonicalQuestion[] = [];
  const pages: string[][] = [];
  const n = meta.respondents ?? 0;
  const system: string[] = [], conditional: string[] = [], unlabeled: string[] = [];
  const inferred: string[] = [], explicit: string[] = [];
  const mk = (id: string, text: string, kind: CanonicalQuestion["kind"], sourceType: string, note: string, confidence: CanonicalQuestion["confidence"]): CanonicalQuestion => {
    const q: CanonicalQuestion = { sourceId: id, variable: id, text, kind, sourceType, options: [], rows: [], required: false, validation: [], skips: [], custom: [], confidence, notes: [note] };
    questions.push(q); pages.push([id]);
    return q;
  };
  const optionsOf = (v: DataVariable): { options: CanonicalOption[]; fromLabels: boolean } => {
    const miss = new Set(v.missing ?? []);
    if (v.values?.length) return { fromLabels: true, options: v.values.filter(([c]) => !miss.has(c)).map(([c, l]) => ({ sourceId: c, code: isInt(c) ? Number(c) : c, label: l })) };
    const codes = (v.observed ?? []).filter(isInt).map(Number).sort((a, b) => a - b);
    return { fromLabels: false, options: codes.map((c) => ({ sourceId: String(c), code: c, label: `Code ${c}` })) };
  };
  const blankShare = (v: DataVariable) => (n && v.filled !== undefined ? 1 - v.filled / n : 0);

  /* families: Q5_1 … Q5_8, Q7r1 … Q7r5, Q9.1 … — the stem and a trailing number */
  const stemOf = (name: string) => /^(.*?[A-Za-z0-9])(?:[_.]|_?r|_?c)?(\d{1,3})$/.exec(name);
  const families = new Map<string, DataVariable[]>();
  for (const v of vars) { const m = stemOf(v.name); if (m && !SYSTEM.test(v.name)) (families.get(m[1]) ?? families.set(m[1], []).get(m[1])!).push(v); }
  const inFamily = new Map<string, string>();
  for (const [stem, members] of families) if (members.length >= 2 && !vars.some((v) => v.name === stem && (v.values?.length || (v.observed?.length ?? 0) > 0))) for (const m of members) inFamily.set(m.name, stem);

  const commonPrefix = (labels: string[]) => { if (labels.length < 2) return ""; let p = labels[0]; for (const l of labels) while (p && !l.startsWith(p)) p = p.slice(0, -1); const cut = Math.max(p.lastIndexOf(" - "), p.lastIndexOf(": "), p.lastIndexOf("? ")); return cut > 8 ? p.slice(0, cut + 2) : ""; };
  const done = new Set<string>();
  for (const v of vars) {
    if (done.has(v.name)) continue;
    if (SYSTEM.test(v.name)) { system.push(v.name); done.add(v.name); continue; }
    const stem = inFamily.get(v.name);
    const members = stem ? families.get(stem)! : null;
    if (members) {
      for (const m of members) done.add(m.name);
      const labels = members.map((m) => m.label ?? "");
      const prefix = commonPrefix(labels.filter(Boolean));
      const itemText = (m: DataVariable, i: number) => (m.label ? (prefix ? m.label.slice(prefix.length) : m.label).trim() : "") || `Item ${stemOf(m.name)?.[2] ?? i + 1}`;
      const stemText = prefix.replace(/[\s:–-]+$/, "").trim() || stem!;
      const obs = (m: DataVariable) => m.observed ?? [];
      const binary = members.every((m) => (m.values?.length ? binaryLabels(m.values) : obs(m).length > 0 && obs(m).every((x) => x === "0" || x === "1")));
      const sameLabels = members.every((m) => m.values?.length && JSON.stringify(m.values) === JSON.stringify(members[0].values)) && (members[0].values?.length ?? 0) >= 2;
      const ints = members.every((m) => obs(m).length > 0 && obs(m).every(isInt));
      /* a ranking: in every row the family's values are distinct and run 1…k */
      const ranked = ints && !!meta.rows && (() => { const head = meta.rows![0].map((c) => c.trim()); const idx = members.map((m) => head.indexOf(m.name)); let seen = 0; for (const r of meta.rows!.slice(1)) { const vals = idx.map((i) => (r[i] ?? "").trim()).filter(Boolean).map(Number); if (!vals.length) continue; seen++; if (new Set(vals).size !== vals.length || Math.min(...vals) !== 1 || Math.max(...vals) !== vals.length) return false; } return seen >= 3; })();
      const hasText = members.some((m) => m.string || obs(m).some((x) => !isNum(x)));
      if (binary && !sameLabels || (binary && binaryLabels(members[0].values ?? [["1", "1"]]))) {
        const q = mk(stem!, stemText, "multi", "data: a family of 0 / 1 variables", `inferred: ${members.length} variables ${members[0].name}…${members[members.length - 1].name} each hold only 0 / 1 — one answer of a multiple choice each`, "review");
        q.options = members.map((m, i) => ({ sourceId: m.name, code: Number(stemOf(m.name)?.[2] ?? i + 1), label: itemText(m, i) }));
        if (members.some((m) => !m.label)) unlabeled.push(stem!);
        inferred.push(`${stem} → multiple choice (${members.length} answers)`);
      } else if (ranked) {
        const q = mk(stem!, stemText, "ranking", "data: a family holding an order 1…k", `inferred: in every row the values of ${members[0].name}…${members[members.length - 1].name} are a 1…k order — a ranking of ${members.length} items`, "review");
        q.options = members.map((m, i) => ({ sourceId: m.name, code: Number(stemOf(m.name)?.[2] ?? i + 1), label: itemText(m, i) }));
        if (members.some((m) => !m.label)) unlabeled.push(stem!);
        inferred.push(`${stem} → ranking (${members.length} items)`);
      } else if (!hasText && (sameLabels || (ints && new Set(members.flatMap(obs)).size <= 11))) {
        const scale = sameLabels ? optionsOf(members[0]) : optionsOf({ ...members[0], observed: [...new Set(members.flatMap(obs))] });
        const q = mk(stem!, stemText, "matrix_single", "data: a family sharing one set of codes", `${sameLabels ? "explicit scale labels; " : ""}inferred: ${members.length} variables share one set of ${scale.options.length} codes — the rows of a grid`, "review");
        q.rows = members.map((m, i) => ({ sourceId: m.name, code: m.name, label: itemText(m, i) }));
        q.options = scale.options;
        if (!scale.fromLabels || members.some((m) => !m.label)) unlabeled.push(stem!);
        inferred.push(`${stem} → grid (${members.length} rows × ${scale.options.length})`);
      } else {
        /* not a recognisable family: each variable is its own question */
        for (const m of members) { done.delete(m.name); inFamily.delete(m.name); }
      }
      if (members.every((m) => done.has(m.name))) { if (members.some((m) => blankShare(m) > 0.02)) conditional.push(stem!); continue; }
    }
    done.add(v.name);
    const obs = v.observed ?? [];
    const text = v.label ?? v.name;
    if (v.values && v.values.length >= 2) {
      const q = mk(v.name, text, "single", "data: value labels", "explicit: the answers and their codes are the file's own value labels", v.label ? "high" : "review");
      q.options = optionsOf(v).options;
      explicit.push(v.name);
      if (v.missing?.length) q.notes.push(`declared missing / special values, left out of the answers: ${v.missing.join(", ")}`);
    } else if (v.string || obs.some((x) => !isNum(x))) {
      mk(v.name, text, obs.some((x) => x.length > 80) ? "textarea" : "text", "data: text", "explicit: the variable holds text", v.label ? "high" : "review");
    } else if (obs.length > 0 && obs.every(isInt) && obs.length <= 10 && Math.max(...obs.map(Number)) <= 20 && Math.min(...obs.map(Number)) >= 0) {
      const q = mk(v.name, text, "single", "data: a few whole-number codes", `inferred: only the codes ${obs.map(Number).sort((a, b) => a - b).join(", ")} occur — a single choice whose answer texts the file does not give`, "review");
      q.options = optionsOf(v).options;
      unlabeled.push(v.name);
      inferred.push(`${v.name} → single choice (${obs.length} codes, texts unknown)`);
    } else {
      mk(v.name, text, "numeric", "data: numbers", obs.length ? `inferred: numeric values from ${Math.min(...obs.map(Number))} to ${Math.max(...obs.map(Number))}` : "explicit: a numeric variable", v.label ? "high" : "review");
    }
    if (blankShare(v) > 0.02) conditional.push(v.name);
  }

  const say = (location: string, type: Issue["type"], severity: Issue["severity"], message: string, suggestion?: string) => issues.push({ location, type, severity, message, ...(suggestion ? { suggestion } : {}), autoAttempted: true });
  say(meta.fileName, "inferred", "medium", `This is a data file${n ? ` (${n} responses)` : ""}, not a questionnaire: ${questions.length} questions were drafted from its ${vars.length} variables. It records answers, not programming — no skip or display logic, piping, randomisation or quota is in it, and none was added.`, "Review each question's type and wording, then add the logic from the questionnaire or tell Intelligent mode the rules.");
  if (explicit.length) say("metadata", "converted", "info", `From the file's own labels (explicit): ${explicit.length} single-choice question${explicit.length === 1 ? "" : "s"} with their answers and codes.`);
  if (inferred.length) say("inferred types", "inferred", "medium", `Inferred from variable names and the values that occur — check each: ${inferred.slice(0, 40).join("; ")}${inferred.length > 40 ? `; and ${inferred.length - 40} more` : ""}.`);
  if (unlabeled.length) say("answer texts", "inferred", "high", `The file gives no text for the answers of ${unlabeled.length} question${unlabeled.length === 1 ? "" : "s"} (${unlabeled.slice(0, 25).join(", ")}${unlabeled.length > 25 ? ", …" : ""}); they are shown as “Code 1”, “Item 2”.`, "Send the codebook or questionnaire, or type the answer texts.");
  if (conditional.length) say("conditions", "inferred", "medium", `${conditional.length} question${conditional.length === 1 ? " is" : "s are"} blank for part of the sample (${conditional.slice(0, 25).join(", ")}${conditional.length > 25 ? ", …" : ""}). They were probably shown on a condition, or were optional. The file does not say which, so no condition was created.`, "Say who was asked each of them and the rule will be added.");
  if (system.length) say("system variables", "dropped", "info", `${system.length} column${system.length === 1 ? "" : "s"} of bookkeeping (${system.slice(0, 20).join(", ")}) ${system.length === 1 ? "is" : "are"} not questions and were left out.`);

  const flow: CFlow[] = pages.length ? [{ t: "block", sourceId: "data", title: meta.title ?? meta.fileName, pages }] : [];
  return { source: { platform: "spreadsheet", format: meta.format, fileName: meta.fileName, title: meta.title, fingerprint: meta.fingerprint }, questions, flow, embedded: [], quotas: [], custom: [], issues };
}

/* ------------------------------------------------------------ SPSS .sav: the dictionary */

/**
 * The dictionary of an SPSS system file — variable names, labels, value labels, missing values — read from its
 * header records. The data records are not read: the dictionary is the metadata, and it is explicit.
 */
export function readSavDictionary(bytes: Uint8Array): DataVariable[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== "$FL2" && magic !== "$FL3") throw new Error("not an SPSS system file");
  const le = dv.getInt32(64, true) === 2 || dv.getInt32(64, true) === 3;
  const i32 = (o: number) => dv.getInt32(o, le);
  const f64 = (o: number) => dv.getFloat64(o, le);
  let enc = "utf-8";
  const str = (o: number, len: number) => new TextDecoder(enc, { fatal: false }).decode(bytes.subarray(o, o + len)).replace(/\0+$/, "").trimEnd();
  const slots: (DataVariable | null)[] = [];
  const pending: { labels: [string, string][]; }[] = [];
  const longNames = new Map<string, string>();
  let o = 176;
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(x));
  while (o + 4 <= bytes.length) {
    const rec = i32(o); o += 4;
    if (rec === 2) {
      const type = i32(o), hasLabel = i32(o + 4), nMissing = i32(o + 8); o += 20;
      const name = str(o, 8); o += 8;
      let label: string | undefined;
      if (hasLabel === 1) { const len = i32(o); o += 4; label = str(o, len); o += Math.ceil(len / 4) * 4; }
      const missing: string[] = [];
      for (let k = 0; k < Math.abs(nMissing); k++) { if (type === 0) missing.push(fmt(f64(o))); o += 8; }
      slots.push(type === -1 ? null : { name, ...(label ? { label } : {}), ...(missing.length && nMissing > 0 ? { missing } : {}), ...(type > 0 ? { string: true } : {}) });
    } else if (rec === 3) {
      const count = i32(o); o += 4;
      const labels: [string, string][] = [];
      for (let k = 0; k < count; k++) { const val = f64(o); o += 8; const len = bytes[o]; const text = str(o + 1, len); o += Math.ceil((len + 1) / 8) * 8; labels.push([fmt(val), text]); }
      pending.push({ labels });
    } else if (rec === 4) {
      const count = i32(o); o += 4;
      const set = pending.pop();
      for (let k = 0; k < count; k++) { const v = slots[i32(o) - 1]; o += 4; if (v && set && !v.string) v.values = set.labels; }
    } else if (rec === 6) { const lines = i32(o); o += 4 + lines * 80; }
    else if (rec === 7) {
      const subtype = i32(o), size = i32(o + 4), count = i32(o + 8); o += 12;
      const len = size * count;
      if (subtype === 20) { const name = str(o, len); try { new TextDecoder(name); enc = name; } catch { /* keep utf-8 */ } }
      if (subtype === 13) for (const pair of str(o, len).split("\t")) { const [short, long] = pair.split("="); if (short && long) longNames.set(short.trim(), long.trim()); }
      o += len;
    } else if (rec === 999) break;
    else throw new Error(`unexpected record type ${rec} in the SPSS dictionary`);
  }
  return slots.filter((v): v is DataVariable => !!v).map((v) => ({ ...v, name: longNames.get(v.name) ?? v.name }));
}
