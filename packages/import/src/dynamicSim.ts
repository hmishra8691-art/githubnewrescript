import type { Question, SurveyDefinition } from "@rescript/schema";
import { createResponseState, setAnswer, effectiveQuestion, resolvePiping, stripHtmlText, type ResponseState } from "@rescript/engine";
import { walkSurvey } from "./verify.js";

/**
 * SYNTHETIC RESPONDENTS FOR THE DYNAMIC PARTS (2026-11-02).
 *
 * The structural check says a carried list, a loop or a pipe EXISTS; this says it BEHAVES, by running the engine
 * the runtime uses (`effectiveQuestion`, `resolvePiping`, the flow walker) with answers chosen to test it:
 *
 *   carried / masked list   the source answered with one answer, with several, with none, and changed after the
 *                           first answer — the list shown must be exactly what the filter says, each time
 *   loop                    two answers selected at the source → the looped questions are asked twice, each
 *                           answer stored under its own item; none selected → not asked at all
 *   pipe                    the source answered → the piped text carries that answer (its label, or the number)
 *
 * Every scenario ends pass or fail with what was expected and what the engine did; nothing is assumed.
 *
 * ## Where the expectation comes from
 *
 * Given `intent` — what the SOURCE says each carried list is (its source question and filter, from the canonical
 * survey, before mapping) — the expected list is computed from that, so a mapping that changed the source, the
 * filter or dropped the carry fails here. Without it (a definition with no source, e.g. a test), the expectation is
 * what the definition's own carryForward says, which checks the engine, not the mapping.
 */
export type DynamicIntent = Map<string, { sourceQuestionId: string; filter: "selected" | "not_selected" | "displayed" | "all" }>;
export interface DynamicScenario { id: string; feature: "carry_forward" | "mask" | "same_list" | "loop" | "pipe"; target: string; scenario: string; result: "pass" | "fail"; expected: string; observed: string }
export interface DynamicSimulation { scenarios: DynamicScenario[]; passed: number; failed: number }

const SINGLE = new Set(["single_select", "dropdown"]);
const plainOpts = <T extends { code: string | number; flags?: string[] }>(opts: T[]): T[] => opts.filter((o) => !o.flags?.includes("exclusive") && !o.flags?.includes("other_specify"));
const codes = (xs: { code: string | number }[]) => xs.map((o) => String(o.code)).sort();
const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function simulateDynamics(def: SurveyDefinition, opts: { max?: number; intent?: DynamicIntent } = {}): DynamicSimulation {
  const out: DynamicScenario[] = [];
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const ctx = (st: ResponseState) => ({ def, state: st, loop: null });
  const max = opts.max ?? 80;

  /* ------------------------------------------------------------ carried and masked lists */
  for (const t of def.questions) {
    const said = opts.intent?.get(t.id);
    if ((!t.carryForward && !said) || out.length >= max) continue;
    /* what the source says, else what the definition says */
    const cf = { keepOwn: t.carryForward?.keepOwn ?? false, ...(said ?? t.carryForward!) };
    const src = byId.get(cf.sourceQuestionId);
    if (!src) { out.push({ id: `carry_forward:${t.code}:source`, feature: "carry_forward", target: t.code, scenario: "the source question", result: "fail", expected: `a list from ${cf.sourceQuestionId}`, observed: "that question is not in the survey" }); continue; }
    /* the chain of carries above the source, root first: each answered from what it shows */
    const chain: Question[] = [];
    for (let x: Question | undefined = src, k = 0; x && k < 6; x = x.carryForward ? byId.get(x.carryForward.sourceQuestionId) : undefined, k++) chain.unshift(x);
    const feature = cf.filter === "not_selected" ? "mask" : cf.filter === "all" ? "same_list" : "carry_forward";
    /* every question above the source answered broadly (its first three), so the source has a real list to vary;
       only the source's own answer follows the scenario */
    const answerChain = (st: ResponseState, pick: (shown: string[]) => string[], onlySource = false) => {
      for (const x of chain) {
        if (onlySource && x !== src) continue;
        const view = effectiveQuestion(x, ctx(st)).options;
        const shown = codes(plainOpts(view));
        const chosen = x === src ? pick(shown) : shown.slice(0, 3);
        if (!chosen.length) { delete st.answers[x.id]; continue; }
        const asCode = (c: string) => (x.options ?? []).concat(view).find((o) => String(o.code) === c)?.code ?? c;
        setAnswer(def, st, x.id, SINGLE.has(x.type) ? asCode(chosen[0]) : chosen.map(asCode), null);
      }
    };
    const expect = (st: ResponseState): string[] => {
      const shown = effectiveQuestion(src, ctx(st)).options;
      const raw = st.answers[src.id];
      const chosen = new Set((Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String));
      const carried = cf.filter === "selected" ? shown.filter((o) => chosen.has(String(o.code))) : cf.filter === "not_selected" ? shown.filter((o) => !chosen.has(String(o.code))) : shown;
      return [...new Set([...codes(carried), ...(cf.keepOwn ? codes(t.options ?? []) : [])])].sort();
    };
    const run = (name: string, pick: (shown: string[]) => string[], change?: (shown: string[]) => string[]) => {
      const st = createResponseState(def, { seed: 7 });
      answerChain(st, pick);
      if (change) answerChain(st, change, true);
      const got = codes(effectiveQuestion(t, ctx(st)).options).filter((x, i, a) => a.indexOf(x) === i);
      const want = expect(st);
      out.push({ id: `${feature}:${t.code}:${name}`, feature, target: t.code, scenario: `${src.code} ${name}`, result: eq(got, want) ? "pass" : "fail", expected: want.join(",") || "(none)", observed: got.join(",") || "(none)" });
    };
    run("answered with one answer", (s) => s.slice(0, 1));
    if (!SINGLE.has(src.type)) run("answered with several answers", (s) => s.slice(0, Math.min(3, s.length)));
    run("not answered", () => []);
    run("changed after the first answer", (s) => s.slice(0, 1), (s) => s.slice(-1));
  }

  /* ------------------------------------------------------------ loops */
  const loops: { id: string; source: { kind: string; questionId?: string; filter?: string }; members: string[] }[] = [];
  const find = (ns: unknown[]) => { for (const n of ns as { type: string; id: string; source?: { kind: string; questionId?: string; filter?: string }; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[]; questionIds?: string[] }[]) {
    if (n.type === "loop" && n.source) { const members: string[] = []; const w = (cs: unknown[]) => { for (const m of cs as { type: string; questionIds?: string[]; children?: unknown[] }[]) { if (m.type === "page") members.push(...(m.questionIds ?? [])); if (m.children) w(m.children); } }; w(n.children ?? []); loops.push({ id: n.id, source: n.source, members }); }
    if (n.children) find(n.children); for (const b of n.branches ?? []) find(b.children); if (n.otherwise) find(n.otherwise);
  } };
  find(def.flow as unknown[]);
  for (const lp of loops) {
    if (out.length >= max || lp.source.kind !== "question" || !lp.source.questionId) continue;
    const src = byId.get(lp.source.questionId);
    if (!src) continue;
    const members = lp.members.map((m) => byId.get(m)).filter((x): x is Question => !!x && x.type !== "html");
    if (!members.length) continue;
    /* the source's list as a respondent would see it, through any carry it has */
    const probe = createResponseState(def, { seed: 7 });
    const chainRoots: Question[] = [];
    for (let x: Question | undefined = src.carryForward ? byId.get(src.carryForward.sourceQuestionId) : undefined, k = 0; x && k < 6; x = x.carryForward ? byId.get(x.carryForward.sourceQuestionId) : undefined, k++) chainRoots.unshift(x);
    const force: Record<string, unknown> = {};
    for (const x of chainRoots) { const shown = plainOpts(effectiveQuestion(x, ctx(probe)).options); const v = shown.slice(0, 2).map((o) => o.code); force[x.id] = SINGLE.has(x.type) ? v[0] : v; setAnswer(def, probe, x.id, force[x.id], null); }
    const shown = plainOpts(effectiveQuestion(src, ctx(probe)).options);
    if (shown.length < 2 || SINGLE.has(src.type)) continue;
    const two = shown.slice(0, 2);
    force[src.id] = two.map((o) => o.code);
    const w = walkSurvey(def, "deepest", 7, { force, keepState: true });
    const keys = Object.keys(w.state?.answers ?? {});
    const storedFor = (m: Question) => two.filter((o) => keys.some((k) => k.startsWith(`${m.id}@`) && k.split("@")[1].split("__")[0] === String(o.code)));
    const per = members.map((m) => `${m.code}: ${storedFor(m).length} of 2`);
    const ok = !w.error && members.every((m) => storedFor(m).length === 2);
    out.push({ id: `loop:${lp.id}:two`, feature: "loop", target: members.map((m) => m.code).join(", "), scenario: `${src.code} with 2 answers selected (${two.map((o) => stripHtmlText(o.label)).join(", ")})`, result: ok ? "pass" : "fail", expected: "each looped question asked and stored once per answer: 2 each", observed: w.error ? `engine error: ${w.error}` : per.join("; ") });
    /* none selected: the looped questions are not asked */
    if (!src.required && !(src.options ?? []).some((o) => o.flags?.includes("exclusive"))) continue;
    const ex = (effectiveQuestion(src, ctx(probe)).options).find((o) => o.flags?.includes("exclusive"));
    if (ex) {
      const w0 = walkSurvey(def, "deepest", 7, { force: { ...force, [src.id]: [ex.code] }, keepState: true });
      const asked = members.filter((m) => Object.keys(w0.state?.answers ?? {}).some((k) => k.startsWith(`${m.id}@`)));
      out.push({ id: `loop:${lp.id}:none`, feature: "loop", target: members.map((m) => m.code).join(", "), scenario: `${src.code}: only “${stripHtmlText(ex.label)}”`, result: asked.length === 0 && !w0.error ? "pass" : "fail", expected: "the loop runs for the brands selected — none here, so nothing is asked", observed: asked.length ? `${asked.map((m) => m.code).join(", ")} asked` : "not asked" });
    }
  }

  /* ------------------------------------------------------------ pipes */
  for (const t of def.questions) {
    if (out.length >= max) break;
    const texts = [t.text, t.instruction ?? "", ...(t.options ?? []).map((o) => o.label)].join(" ");
    for (const m of texts.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)) {
      const src = def.questions.find((q) => q.code === m[1]);
      if (!src || src.id === t.id) continue;
      const st = createResponseState(def, { seed: 7 });
      /* the source's chain first, so a carried source has something to answer from */
      for (let x: Question | undefined = src.carryForward ? byId.get(src.carryForward.sourceQuestionId) : undefined, k = 0; x && k < 6; x = x.carryForward ? byId.get(x.carryForward.sourceQuestionId) : undefined, k++) { const o = plainOpts(effectiveQuestion(x, ctx(st)).options)[0]; if (o) setAnswer(def, st, x.id, SINGLE.has(x.type) ? o.code : [o.code], null); }
      let value: unknown, want: string;
      const shown = plainOpts(effectiveQuestion(src, ctx(st)).options);
      if (shown.length) { value = SINGLE.has(src.type) ? shown[0].code : [shown[0].code]; want = stripHtmlText(shown[0].label); }
      else if (src.type === "numeric") { value = 42; want = "42"; }
      else if (/text/.test(src.type)) { value = "fresh bread"; want = "fresh bread"; }
      else continue;
      setAnswer(def, st, src.id, value, null);
      const where = t.text.includes(m[0]) ? t.text : t.instruction?.includes(m[0]) ? t.instruction : (t.options ?? []).find((o) => o.label.includes(m[0]))?.label ?? t.text;
      const got = stripHtmlText(resolvePiping(where ?? "", ctx(st)));
      out.push({ id: `pipe:${t.code}:${src.code}`, feature: "pipe", target: t.code, scenario: `${src.code} answered “${want}”`, result: got.includes(want) ? "pass" : "fail", expected: `the text carries “${want}”`, observed: got.slice(0, 160) });
      if (out.length >= max) break;
    }
  }
  return { scenarios: out, passed: out.filter((x) => x.result === "pass").length, failed: out.filter((x) => x.result === "fail").length };
}
