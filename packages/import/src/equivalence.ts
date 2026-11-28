import type { Question, SurveyDefinition } from "@rescript/schema";
import type { CanonicalSurvey, CExpr, CFlow } from "./canonical.js";
import type { MapResult } from "./map.js";
import { walkSurvey, readByOthers } from "./verify.js";
import { exprText } from "./review.js";

/**
 * BEHAVIOURAL EQUIVALENCE (import brief §15, I8): does the reconstructed survey BEHAVE like the source, not only
 * look like it?
 *
 * From the source's own logic (canonical, before mapping) each rule becomes two scenarios — the condition met and
 * the condition not met — with the answers that make it so and what the SOURCE says must then happen:
 *
 *   display logic on Q        met → Q is shown;               not met → Q is not shown
 *   skip from Q to T          met → T is shown and the question after Q is not (when T is further on)
 *   skip / terminate to end   met → the interview ends with that status
 *   branch                    met → its first question is shown (or its end status reached); not met → not
 *
 * Each scenario is then RUN on the Rescript engine against the imported definition: the scenario's answers are
 * fixed, every other question is answered by the "deepest" walker (the path that goes furthest), and what the
 * respondent saw and how the interview ended are compared with the expectation. A condition the scenario builder
 * cannot drive with a few answers (a count, a text match, an unread part) is listed as not testable, with the
 * reason — never counted as a pass.
 *
 * This is reported apart from the structural check (verify.ts): a survey can have every question and still
 * branch differently.
 */
export interface Scenario {
  id: string;
  rule: string;
  kind: "display" | "skip" | "branch";
  met: boolean;
  /** the answers the scenario fixes, in words */
  given: string[];
  expect: { shown?: string; hidden?: string; end?: string };
}
export interface ScenarioResult extends Scenario { result: "pass" | "fail" | "not_testable" | "not_run"; observed: string }
export interface BehaviourReport {
  scenarios: ScenarioResult[]; passed: number; failed: number; notTestable: number;
  /** scenarios built but not run: over the count limit or the time budget — said, never counted as passed */
  notRun: number;
  error?: string;
}

type Force = { values: Record<string, unknown>; embedded: Record<string, string>; given: string[] };
/** how many draws a scenario inside a randomizer tries before it is called not testable */
const DRAWS = 16;

export function runScenarios(c: CanonicalSurvey, m: MapResult, opts: { max?: number; budgetMs?: number } = {}): BehaviourReport {
  const def = m.def as SurveyDefinition | null;
  if (!def) return { scenarios: [], passed: 0, failed: 0, notTestable: 0, notRun: 0, error: "no survey" };
  const max = opts.max ?? 120;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const readBy = readByOthers(def);
  let ran = 0;
  const rid = new Map(m.mapping.filter((x) => x.kind === "question").map((x) => [x.source, x.rescript]));
  const byId = new Map(c.questions.map((q) => [q.sourceId, q]));
  const qOf = (src: string): Question | undefined => def.questions.find((q) => q.id === rid.get(src));
  const name = (src: string) => byId.get(src)?.code ?? byId.get(src)?.variable ?? src;
  const order = flowOrder(c);
  const flowSets = new Map<string, string>();
  const scan = (fs: CFlow[]) => { for (const f of fs) { if (f.t === "embedded") for (const x of f.fields) if (x.source === "static" || x.source === "expression") flowSets.set(x.name, x.value !== undefined ? `= ${x.value}` : x.source); if ("children" in f) scan(f.children); } };
  scan(c.flow);
  const out: ScenarioResult[] = [];
  /*
   * The answer codes that END the interview somewhere — a terminating branch, a skip to the end. "Not this answer"
   * avoids them, so a scenario about one term is not ended by its sibling. Only those: avoiding every code any rule
   * mentions would also avoid a WRONG code the import wrote, and the check would stop catching it.
   */
  const ending = new Map<string, Set<string>>();
  const note = (c: unknown) => JSON.stringify(c ?? null, (_k, v) => { const r = v as { type?: string; source?: { kind?: string; ref?: string }; value?: unknown } | null; if (r && typeof r === "object" && r.type === "rule" && r.source?.kind === "question" && r.source.ref) { const set = ending.get(r.source.ref) ?? new Set<string>(); for (const x of Array.isArray(r.value) ? r.value : [r.value]) if (x !== undefined && x !== null) set.add(String(x)); ending.set(r.source.ref, set); } return v; });
  const endsHere = (ns: unknown[]): boolean => (ns as { type?: string; status?: string }[]).some((n) => n.type === "end" && n.status !== "complete");
  const scanEnds = (ns: unknown[]) => { for (const n of ns as { type?: string; children?: unknown[]; branches?: { when?: unknown; children: unknown[] }[]; otherwise?: unknown[] }[]) { for (const b of n.branches ?? []) { if (endsHere(b.children)) note(b.when); scanEnds(b.children); } scanEnds(n.children ?? []); scanEnds(n.otherwise ?? []); } };
  scanEnds(def.flow as unknown[]);
  for (const q of def.questions) for (const r of q.skipLogic ?? []) if (r.target?.kind === "end" || r.target?.kind === "terminate") note(r.when);
  const mentionedCodes = (qid: string) => ending.get(qid) ?? new Set<string>();
  /* questions inside a randomizer that presents a subset, each mapped to the questions of the same drawn element */
  const drawGroup = new Map<string, Set<string>>();
  const questionsIn = (n: unknown): string[] => { const x = n as { type?: string; questionIds?: string[]; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[] }; return [...(x.type === "page" ? x.questionIds ?? [] : []), ...(x.children ?? []).flatMap(questionsIn), ...(x.branches ?? []).flatMap((b) => b.children.flatMap(questionsIn)), ...(x.otherwise ?? []).flatMap(questionsIn)]; };
  const findDraws = (ns: unknown[]) => { for (const n of ns as { type?: string; show?: number; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[] }[]) {
    if (n.type === "randomizer" && typeof n.show === "number" && n.show < (n.children ?? []).length) for (const child of n.children ?? []) { const ids = new Set(questionsIn(child)); for (const id of ids) drawGroup.set(id, ids); }
    findDraws(n.children ?? []); for (const b of n.branches ?? []) findDraws(b.children); findDraws(n.otherwise ?? []);
  } };
  findDraws(def.flow as unknown[]);

  /** answers that make `e` true (met) or false, or the reason it cannot be driven */
  const drive = (e: CExpr, met: boolean): Force | string => {
    if (e.t === "const") return e.value === met ? { values: {}, embedded: {}, given: [] } : "a constant condition";
    if (e.t === "raw") return "a condition the importer could not read";
    if (e.t === "group") {
      if (e.op === "not") return e.children.length === 1 ? drive(e.children[0], !met) : "a NOT over several conditions";
      const all = (e.op === "and") === met; // AND met / OR not met: every child must take the value
      /* AND not met / OR met: one child decides — the first that can be driven (I2, 2026-11-27: it was always the first child) */
      const parts = all ? e.children.map((ch) => drive(ch, met)) : [e.children.map((ch) => drive(ch, met)).find((p) => typeof p !== "string") ?? drive(e.children[0], met)];
      const bad = parts.find((p) => typeof p === "string");
      if (bad) return bad as string;
      const f: Force = { values: {}, embedded: {}, given: [] };
      for (const p of parts as Force[]) { for (const [k, v] of Object.entries(p.values)) { if (k in f.values && JSON.stringify(f.values[k]) !== JSON.stringify(v)) return "two parts need different answers to one question"; f.values[k] = v; } Object.assign(f.embedded, p.embedded); f.given.push(...p.given); }
      return f;
    }
    const r = e.ref;
    if (r.kind === "embedded") {
      /* a field the survey's own flow sets (a fixed value, an expression) is not the respondent's to vary */
      const set = flowSets.get(r.id);
      if (set) return `ED.${r.id} is set by the survey's flow (${set}), not by the respondent or the link`;
      if ((e.op === "eq" || e.op === "ne") && e.value !== undefined && !Array.isArray(e.value)) {
        const want = (e.op === "eq") === met; const v = want ? String(e.value) : `${String(e.value)}_other`;
        return { values: {}, embedded: { [r.id]: v }, given: [`ED.${r.id} = ${v}`] };
      }
      const n = Number(e.value);
      if (["gt", "gte", "lt", "lte"].includes(e.op) && Number.isFinite(n)) {
        /* the boundary itself: gt 1 met → 2, not met → 1; lt 5 met → 4, not met → 5 */
        const up = e.op === "gt" || e.op === "gte";
        const strict = e.op === "gt" || e.op === "lt";
        const v = met ? (strict ? (up ? n + 1 : n - 1) : n) : (strict ? n : (up ? n - 1 : n + 1));
        return { values: {}, embedded: { [r.id]: String(v) }, given: [`ED.${r.id} = ${v}`] };
      }
      return "an embedded-data comparison the scenario builder cannot drive";
    }
    if (r.kind !== "question") return `a ${r.kind} condition`;
    const src = byId.get(r.id); const q = qOf(r.id);
    if (!src || !q) return `question ${r.id} is not in the imported survey`;
    if (r.row) return "a grid-row condition";
    const isMulti = /^multi/.test(q.type);
    if (isMulti && /^count(Gte|Gt|Lte|Lt|Eq)$/.test(e.op) && Number.isInteger(Number(e.value))) {
      /* "N or more selected": choose exactly the boundary number of plain answers */
      const n = Number(e.value); const plain = (q.options ?? []).filter((o) => !o.flags?.some((f) => f === "exclusive" || f === "other_specify") && o.logic?.visibility !== "always_hide");
      const want: Record<string, [number, number]> = { countGte: [n, n - 1], countGt: [n + 1, n], countLte: [n, n + 1], countLt: [n - 1, n], countEq: [n, n === 1 ? 2 : n - 1] };
      const k = want[e.op][met ? 0 : 1];
      if (k < 1 || k > plain.length) return `${k} answers cannot be chosen on ${name(r.id)}`;
      return { values: { [q.id]: plain.slice(0, k).map((o) => o.code) }, embedded: {}, given: [`${name(r.id)}: ${k} answer${k === 1 ? "" : "s"} chosen`] };
    }
    if (!/^(single_select|dropdown|multi_select|multi_dropdown|nps)/.test(q.type) || !r.choice || !["selected", "notSelected", "eq", "ne"].includes(e.op)) return "a condition other than an answer chosen / not chosen";
    const opt = src.options.find((o) => o.sourceId === r.choice);
    const code = opt?.code;
    if (code === undefined || !(q.options ?? []).some((o) => String(o.code) === String(code))) return "the answer is not in the imported question";
    const wantChosen = (e.op === "selected" || e.op === "eq") === met;
    /* I2: "not this answer" prefers one that ends nothing — "not Straightliner" taken as "Speeder" fired the Speeder term instead */
    const others = (q.options ?? []).filter((o) => String(o.code) !== String(code) && !o.flags?.includes("other_specify") && o.logic?.visibility !== "always_hide");
    const named = mentionedCodes(q.id);
    const other = others.find((o) => !named.has(String(o.code))) ?? others[0];
    if (!wantChosen && !other) return "the question has no other answer to choose";
    const value = wantChosen ? code : other!.code;
    const label = wantChosen ? opt!.label : other!.label;
    /*
     * I2 (2026-11-27): a HIDDEN question the survey sets itself from a link field ("select 1 when ED.testing2 = 1",
     * recomputed on every page — Decipher's qTesting exec) cannot be fixed directly: the next page recomputes it.
     * The scenario drives the field instead, which is what the source does.
     */
    if ((q.settings as { hidden?: boolean } | undefined)?.hidden && (q.punches ?? []).some((p) => p.when)) {
      const set = driveHidden(q, code, wantChosen, 0);
      if (typeof set !== "string") return { ...set, given: [...set.given, `(the survey then sets ${name(r.id)} ${wantChosen ? `= ${label}` : `≠ ${opt!.label}`})`] };
      /* a flag the survey recomputes as it is read cannot be fixed directly either: the scenario would test nothing */
      if ((q.punches ?? []).some((p) => p.when && p.recompute === "always")) return `${name(r.id)} is worked out by the survey as it is read (${set}), so a scenario cannot fix it`;
      /* otherwise the flag is fixed directly (as before): it holds unless a later page sets it again, which the walk checks */
    }
    return { values: { [q.id]: isMulti ? [value] : value }, embedded: {}, given: [`${name(r.id)} = ${label}`] };
  };

  /*
   * I2 (2026-11-27): a HIDDEN question the survey sets itself — a punch "select 2 when hS10qta = 1 and S16 is 1 or 2",
   * recomputed on every page (Decipher's exec flags, a link field's test switch) — cannot be fixed directly: the next
   * page recomputes it. 52 of the 131 failing scenarios on the corpus fixed such a flag and so tested nothing. The
   * punch's own condition is driven instead (the imported one, the same rules the source's script states), which is
   * what makes the source set it; a flag that depends on another flag is followed a few levels down.
   */
  const driveHidden = (q: Question, code: unknown, wantChosen: boolean, depth: number): Force | string => {
    if (depth > 3) return `${q.code} is set by the survey from other flags, too many levels down`;
    const sets = (q.punches ?? []).filter((p) => p.when && p.source?.kind === "codes" && (p.source.codes ?? []).map(String).includes(String(code)));
    if (!sets.length) return `${q.code} is set by the survey's script, never to this answer the scenario builder can see`;
    if (wantChosen) return driveDef(sets[0].when, true, depth + 1);
    /* not chosen: every punch that would choose it must be off */
    const f: Force = { values: {}, embedded: {}, given: [] };
    for (const p of sets) { const x = driveDef(p.when, false, depth + 1); if (typeof x === "string") return x; const m = merge(f, x); if (typeof m === "string") return m; }
    return f;
  };
  const merge = (f: Force, p: Force): Force | string => {
    for (const [k, v] of Object.entries(p.values)) { if (k in f.values && JSON.stringify(f.values[k]) !== JSON.stringify(v)) return "two parts need different answers to one question"; f.values[k] = v; }
    for (const [k, v] of Object.entries(p.embedded)) { if (k in f.embedded && f.embedded[k] !== v) return "two parts need different values of one field"; f.embedded[k] = v; }
    f.given.push(...p.given);
    return f;
  };
  /** the same as `drive`, over an IMPORTED condition (ids and codes of the Rescript survey) */
  const driveDef = (c: unknown, met: boolean, depth: number): Force | string => {
    const n = c as { type?: string; op?: string; children?: unknown[]; source?: { kind?: string; ref?: string }; operator?: string; value?: unknown };
    if (n?.type === "group") {
      if (n.op === "not") return (n.children ?? []).length === 1 ? driveDef(n.children![0], !met, depth) : "a NOT over several conditions in a survey flag";
      const kids = n.children ?? [];
      if (!kids.length) return (n.op === "and") === met ? { values: {}, embedded: {}, given: [] } : "an empty condition in a survey flag";
      /* "one of these answers" not met (S3 is one of 35 states → a state outside the list), and its mirror "none of these" met */
      const rules = kids as { type?: string; source?: { kind?: string; ref?: string }; operator?: string; value?: unknown }[];
      const sameRef = rules.every((k) => k.type === "rule" && k.source?.kind === "question" && k.source.ref === rules[0].source?.ref && !Array.isArray(k.value) && k.value !== undefined);
      const outside = sameRef && ((n.op === "or" && !met && rules.every((k) => k.operator === "selected" || k.operator === "eq")) || (n.op === "and" && met && rules.every((k) => k.operator === "notSelected" || k.operator === "ne")));
      if (outside) {
        const tq = def.questions.find((x) => x.id === rules[0].source!.ref);
        const listed = new Set(rules.map((k) => String(k.value)));
        const o = (tq?.options ?? []).find((x) => !listed.has(String(x.code)) && !x.flags?.includes("other_specify") && x.logic?.visibility !== "always_hide");
        if (tq && o && !(tq.settings as { hidden?: boolean } | undefined)?.hidden) return { values: { [tq.id]: /^multi/.test(tq.type) ? [o.code] : o.code }, embedded: {}, given: [`${tq.code} = ${o.label}`] };
      }
      const all = (n.op === "and") === met;
      if (!all) {
        /* one child decides: the first that can be driven */
        let why = "";
        for (const k of kids) { const x = driveDef(k, met, depth); if (typeof x !== "string") return x; why ||= x; }
        return why;
      }
      const f: Force = { values: {}, embedded: {}, given: [] };
      for (const k of kids) { const x = driveDef(k, met, depth); if (typeof x === "string") return x; const m = merge(f, x); if (typeof m === "string") return m; }
      return f;
    }
    if (n?.type !== "rule" || !n.source?.ref) return "a survey flag set by a condition the scenario builder cannot read";
    if (n.source.kind === "embedded") {
      if (!["eq", "ne"].includes(n.operator ?? "") || n.value === undefined || Array.isArray(n.value)) return "a survey flag set from a link field compared in a way the scenario builder cannot drive";
      const v = (n.operator === "eq") === met ? String(n.value) : `${String(n.value)}_other`;
      return { values: {}, embedded: { [n.source.ref]: v }, given: [`ED.${n.source.ref} = ${v}`] };
    }
    if (n.source.kind !== "question") return `a survey flag set from a ${n.source.kind} value`;
    const tq = def.questions.find((x) => x.id === n.source!.ref);
    if (tq && (n.operator === "answered" || n.operator === "unanswered")) {
      /* the walk answers every question it shows, so "answered" holds by itself; "unanswered" cannot be made to */
      if ((n.operator === "answered") === met) return { values: {}, embedded: {}, given: [] };
      return `a survey flag needs ${tq.code} left unanswered`;
    }
    if (!tq || !/^(single_select|dropdown|multi_select|multi_dropdown)/.test(tq.type) || !["selected", "notSelected", "eq", "ne"].includes(n.operator ?? "") || n.value === undefined || Array.isArray(n.value)) return "a survey flag set by a condition other than an answer chosen / not chosen";
    const want = (n.operator === "selected" || n.operator === "eq") === met;
    const hit = (tq.options ?? []).find((o) => String(o.code) === String(n.value));
    if (!hit) return "a survey flag reads an answer that is not in the question";
    if ((tq.settings as { hidden?: boolean } | undefined)?.hidden && (tq.punches ?? []).some((p) => p.when)) return driveHidden(tq, hit.code, want, depth);
    const other = (tq.options ?? []).find((o) => String(o.code) !== String(hit.code) && !o.flags?.includes("other_specify") && o.logic?.visibility !== "always_hide");
    if (!want && !other) return "a survey flag reads a question with no other answer to choose";
    const o = want ? hit : other!;
    return { values: { [tq.id]: /^multi/.test(tq.type) ? [o.code] : o.code }, embedded: {}, given: [`${tq.code} = ${o.label}`] };
  };

  const add = (s: Omit<Scenario, "given">, e: CExpr) => {
    const f = drive(e, s.met);
    if (typeof f === "string") { out.push({ ...s, given: [], result: "not_testable", observed: f }); return; }
    if (ran >= max || Date.now() > deadline) { out.push({ ...s, given: f.given, result: "not_run", observed: ran >= max ? `more than ${max} scenarios — not run` : "the time budget for scenarios ran out — not run" }); return; }
    ran++;
    /* a scenario about one question stops once the walk is past it; one about how the interview ends runs to the end */
    const target = s.expect.end ? undefined : (s.expect.shown ?? s.expect.hidden); /* a skip's target is the later of its two */
    /*
     * I2 (2026-11-27): a target inside a randomizer that shows N of M elements (Qualtrics "randomly present 1 of 4")
     * is shown only when it is drawn — in the source as here — so one fixed draw tested nothing about it. Further
     * draws are tried until the element holding the target is reached; if none reaches it, the scenario is not
     * testable, never a pass by absence.
     */
    const group = target && rid.get(target) ? drawGroup.get(rid.get(target)!) : undefined;
    const walkOnce = (seed: number) => walkSurvey(def, "deepest", seed, { force: f.values, embedded: f.embedded, readBy, ...(target && rid.get(target) ? { stopAfter: rid.get(target) } : {}) });
    let w = walkOnce(7);
    if (group) {
      let k = 0;
      while (![...group].some((id) => w.seen.has(id)) && ++k < DRAWS) w = walkOnce(7 + k);
      if (![...group].some((id) => w.seen.has(id))) { out.push({ ...s, given: f.given, result: "not_testable", observed: `${name(target!)} is inside a randomizer that shows only some of its elements, and none of ${DRAWS} draws presented its element` }); return; }
    }
    if (w.forceLost?.length) { out.push({ ...s, given: f.given, result: "not_testable", observed: `${w.forceLost.map((id) => def.questions.find((q) => q.id === id)?.code ?? id).join(", ")} is worked out again by the survey on later pages, so the value the scenario gave it does not hold` }); return; }
    const seen = (src: string) => { const id = rid.get(src); return !!id && w.seen.has(id); };
    let pass = true; const obs: string[] = [];
    if (s.expect.shown) { const ok = seen(s.expect.shown); pass &&= ok; obs.push(`${name(s.expect.shown)} ${ok ? "shown" : "NOT shown"}`); }
    if (s.expect.hidden) { const ok = !seen(s.expect.hidden); pass &&= ok; obs.push(`${name(s.expect.hidden)} ${ok ? "not shown" : "SHOWN"}`); }
    if (s.expect.end) { const ok = s.expect.end.startsWith("not ") ? w.end !== s.expect.end.slice(4) : w.end === s.expect.end; pass &&= ok; obs.push(`ended ${w.end}`); }
    if (w.error) { pass = false; obs.push(`engine error: ${w.error}`); }
    out.push({ ...s, given: f.given, result: pass ? "pass" : "fail", observed: obs.join("; ") });
  };
  const nextAfter = (src: string): string | undefined => { const i = order.indexOf(src); return i >= 0 ? order[i + 1] : undefined; };

  for (const q of c.questions) {
    if (!rid.has(q.sourceId) || !order.includes(q.sourceId)) continue;
    if (q.displayLogic) {
      const rule = `${name(q.sourceId)} shown if ${exprText(q.displayLogic, c)}`;
      add({ id: `display:${q.sourceId}:met`, rule, kind: "display", met: true, expect: { shown: q.sourceId } }, q.displayLogic);
      add({ id: `display:${q.sourceId}:not`, rule, kind: "display", met: false, expect: { hidden: q.sourceId } }, q.displayLogic);
    }
    q.skips.forEach((sk, i) => {
      const to = sk.to.kind === "question" ? name(sk.to.id) : sk.to.kind === "end" ? `end (${sk.to.status})` : sk.to.kind;
      const rule = `${name(q.sourceId)}: if ${exprText(sk.when, c)} → ${to}`;
      const nx = nextAfter(q.sourceId);
      if (sk.to.kind === "end") {
        const st = sk.to.status === "terminated" ? "screened" : sk.to.status;
        add({ id: `skip:${q.sourceId}:${i}:met`, rule, kind: "skip", met: true, expect: { end: st } }, sk.when);
        if (st !== "complete") add({ id: `skip:${q.sourceId}:${i}:not`, rule, kind: "skip", met: false, expect: { end: `not ${st}` } }, sk.when);
      } else if (sk.to.kind === "question" && nx && sk.to.id !== nx && order.indexOf(sk.to.id) > order.indexOf(q.sourceId)) {
        add({ id: `skip:${q.sourceId}:${i}:met`, rule, kind: "skip", met: true, expect: { shown: sk.to.id, hidden: nx } }, sk.when);
        if (!byId.get(nx)?.displayLogic) add({ id: `skip:${q.sourceId}:${i}:not`, rule, kind: "skip", met: false, expect: { shown: nx } }, sk.when);
      }
    });
  }
  const branches = (fs: CFlow[]) => { for (const f of fs) {
    if (f.t === "branch" && !f.sourceId.startsWith("unused_")) {
      const first = firstQuestion(f.children); const end = f.children.find((x) => x.t === "end") as Extract<CFlow, { t: "end" }> | undefined;
      const rule = `branch ${f.description ?? f.sourceId}: ${exprText(f.when, c)}`;
      if (first && rid.has(first)) {
        add({ id: `branch:${f.sourceId}:met`, rule, kind: "branch", met: true, expect: { shown: first } }, f.when);
        add({ id: `branch:${f.sourceId}:not`, rule, kind: "branch", met: false, expect: { hidden: first } }, f.when);
      } else if (end && end.status !== "complete") {
        add({ id: `branch:${f.sourceId}:met`, rule, kind: "branch", met: true, expect: { end: end.status } }, f.when);
        add({ id: `branch:${f.sourceId}:not`, rule, kind: "branch", met: false, expect: { end: `not ${end.status}` } }, f.when);
      }
    }
    if ("children" in f) branches(f.children);
  } };
  branches(c.flow);
  const n = (r: ScenarioResult["result"]) => out.filter((x) => x.result === r).length;
  return { scenarios: out, passed: n("pass"), failed: n("fail"), notTestable: n("not_testable"), notRun: n("not_run") };
}

function flowOrder(c: CanonicalSurvey): string[] {
  const out: string[] = [];
  const walk = (fs: CFlow[]) => { for (const f of fs) { if (f.t === "block") for (const p of f.pages) for (const id of p) if (!out.includes(id)) out.push(id); if ("children" in f) walk(f.children); } };
  walk(c.flow);
  if (!c.flow.length) out.push(...c.questions.map((q) => q.sourceId));
  return out;
}
function firstQuestion(fs: CFlow[]): string | undefined {
  for (const f of fs) { if (f.t === "block" && f.pages[0]?.[0]) return f.pages[0][0]; if ("children" in f) { const x = firstQuestion(f.children); if (x) return x; } }
  return undefined;
}
