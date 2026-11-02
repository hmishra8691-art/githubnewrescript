import type { CanonicalSurvey, CExpr, CFlow, CanonicalCustom } from "./canonical.js";

/**
 * THE IMPORT DEPENDENCY GRAPH (import brief §6, I2) — built over the
 * CANONICAL survey, before anything is mapped, so it describes the source as
 * the source wrote it.
 *
 *   nodes   q:<sourceId>  block:<id>  branch:<flowId>  ed:<field>  end:<flowId>  quota:<id>  script:<location>
 *   edges   FROM the element that depends TO what it depends on, with the kind of dependency:
 *             display        a question's (or a choice's / row's) display logic reads it
 *             skip           a skip rule reads it (condition) — `skip_target` for where it jumps
 *             branch         a flow branch reads it; `inside` ties a question to the branch it sits in
 *             piping         text pipes it in
 *             carry_forward  choices are carried from it
 *             loop           a loop block iterates over its choices
 *             quota          a quota counts it
 *             ed_assign      an embedded field takes its value from it (an expression)
 *             script_read / script_write   custom code reads / sets it
 *             redirect       a redirect URL carries it
 *   order   the execution order of questions the flow places (first appearance)
 *
 * Findings are facts about the source, each with where it is and why it
 * matters. Nothing here changes the survey.
 */
export type GEdgeKind = "display" | "skip" | "skip_target" | "branch" | "inside" | "piping" | "carry_forward" | "loop" | "quota" | "ed_assign" | "script_read" | "script_write" | "redirect";
export interface GNode { id: string; kind: "question" | "block" | "branch" | "embedded" | "end" | "quota" | "script"; label: string }
export interface GEdge { from: string; to: string; kind: GEdgeKind; location: string }

export type GraphFindingKind =
  | "missing_reference" | "circular_dependency" | "forward_reference" | "unreachable" | "undefined_embedded"
  | "embedded_used_before_assignment" | "unused_embedded" | "invalid_redirect" | "broken_branch";
export interface GraphFinding { kind: GraphFindingKind; severity: "high" | "medium" | "low" | "info"; location: string; message: string; refs: string[] }

export interface EmbeddedUse { location: string; how: "condition" | "piping" | "redirect" | "script" | "quota" | "expression" }
export interface EmbeddedVarInfo {
  name: string;
  /** where the flow (or the survey's sample list) sets it, and when: before any question is asked, or part-way through */
  assigned: { location: string; by: "url" | "panel" | "static" | "expression" | "script"; stage: "before_questions" | "during"; value?: string }[];
  readBy: EmbeddedUse[];
  /** set somewhere (flow, sample list or script) — false means every read sees an empty value */
  defined: boolean;
}

export interface ImportGraph {
  nodes: GNode[];
  edges: GEdge[];
  /** source question ids in execution order */
  order: string[];
  embedded: EmbeddedVarInfo[];
  findings: GraphFinding[];
  stats: { nodes: number; edges: number; byKind: Partial<Record<GEdgeKind, number>>; findings: Partial<Record<GraphFindingKind, number>> };
}

const QID_TOKEN = /\{\{@([\w.-]+?)(?:[.[][^}]*)?\}\}|\$\{q:\/\/([\w-]+)\//g;
const ED_TOKEN = /\{\{ed\.([\w]+)\}\}|\$\{e:\/\/Field\/([\w.-]+)\}/g;
/** a piped embedded name, as the canonical text writes it (`{{ed.X}}` — non-word characters were made `_`) */
const edKey = (name: string) => name.replace(/[^\w]/g, "_").toUpperCase();

export function buildImportGraph(c: CanonicalSurvey): ImportGraph {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const findings: GraphFinding[] = [];
  const node = (id: string, kind: GNode["kind"], label: string) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label }); return id; };
  const edge = (from: string, to: string, kind: GEdgeKind, location: string) => edges.push({ from, to, kind, location });
  const qById = new Map(c.questions.map((q) => [q.sourceId, q]));
  for (const q of c.questions) node(`q:${q.sourceId}`, "question", q.variable);

  /* ---------------------------------------------------------------- embedded data: declarations */
  const ed = new Map<string, EmbeddedVarInfo>();
  const edOf = (name: string): EmbeddedVarInfo => {
    const k = edKey(name);
    let v = ed.get(k);
    if (!v) { v = { name, assigned: [], readBy: [], defined: false }; ed.set(k, v); node(`ed:${k}`, "embedded", name); }
    return v;
  };
  for (const f of c.embedded) edOf(f.name).assigned.push({ location: "survey sample list", by: f.source === "expression" ? "expression" : f.source, stage: "before_questions", ...(f.value !== undefined ? { value: f.value } : {}) });

  /* ---------------------------------------------------------------- flow walk: order, placement, branches, ends */
  const order: string[] = [];
  const position = new Map<string, number>();
  const placedBlocks = new Set<string>();
  /** embedded fields readable at this point of the walk: flow position (questions asked so far) at which each was first assigned */
  const edAssignedAt = new Map<string, number>();
  const unreachable: { id: string; why: string }[] = [];
  const ends: { id: string; url?: string }[] = [];
  const readsOf = (e: CExpr | undefined, from: string, kind: GEdgeKind, location: string, how: EmbeddedUse["how"] = "condition") => {
    if (!e) return;
    if (e.t === "group") for (const ch of e.children) readsOf(ch, from, kind, location, how);
    else if (e.t === "cmp") {
      if (e.ref.kind === "question") {
        const to = `q:${e.ref.id}`;
        if (!qById.has(e.ref.id)) findings.push({ kind: "missing_reference", severity: "high", location, message: `${location} reads question ${e.ref.id}, which is not in the survey.`, refs: [e.ref.id] });
        else {
          edge(from, to, kind, location);
          const q = qById.get(e.ref.id)!;
          if (e.ref.choice && q.options.length && !q.options.some((o) => o.sourceId === e.ref.choice) && !(q.columns ?? []).some((col) => col.options.some((o) => o.sourceId === e.ref.choice)))
            findings.push({ kind: "missing_reference", severity: "high", location, message: `${location} reads choice ${e.ref.choice} of ${q.variable}, which has no such choice.`, refs: [e.ref.id] });
          if (e.ref.row && q.rows.length && !q.rows.some((r) => r.sourceId === e.ref.row))
            findings.push({ kind: "missing_reference", severity: "high", location, message: `${location} reads row ${e.ref.row} of ${q.variable}, which has no such row.`, refs: [e.ref.id] });
        }
      } else if (e.ref.kind === "embedded") {
        const v = edOf(e.ref.id); v.readBy.push({ location, how });
        edge(from, `ed:${edKey(e.ref.id)}`, kind, location);
      }
    } else if (e.t === "raw") {
      for (const r of e.refs) if (qById.has(r)) edge(from, `q:${r}`, kind, location);
    }
  };
  const textReads = (text: string | undefined, from: string, location: string, kind: GEdgeKind = "piping", how: EmbeddedUse["how"] = "piping") => {
    if (!text) return;
    for (const m of text.matchAll(QID_TOKEN)) {
      const id = m[1] ?? m[2];
      if (!qById.has(id)) { if (/^QID\d+$/.test(id) || id.startsWith("q")) findings.push({ kind: "missing_reference", severity: "medium", location, message: `${location} pipes ${id}, which is not in the survey; respondents would see an empty value.`, refs: [id] }); continue; }
      edge(from, `q:${id}`, kind, location);
    }
    for (const m of text.matchAll(ED_TOKEN)) { const name = m[1] ?? m[2]; edOf(name).readBy.push({ location, how }); edge(from, `ed:${edKey(name)}`, kind, location); }
  };

  const walk = (fs: CFlow[], reachable: boolean, parent: string | null, why = "it sits in a flow branch whose condition can never be true") => {
    for (const f of fs) {
      switch (f.t) {
        case "block": {
          placedBlocks.add(f.sourceId);
          const bid = node(`block:${f.sourceId}`, "block", f.title ?? f.sourceId);
          if (f.displayLogic) readsOf(f.displayLogic, bid, "display", `Block ${f.title ?? f.sourceId} · display logic`);
          if (f.loop?.kind === "question" && f.loop.questionId) {
            if (!qById.has(f.loop.questionId)) findings.push({ kind: "missing_reference", severity: "high", location: `Block ${f.title ?? f.sourceId} · loop`, message: `The loop iterates over question ${f.loop.questionId}, which is not in the survey.`, refs: [f.loop.questionId] });
            else edge(bid, `q:${f.loop.questionId}`, "loop", `Block ${f.title ?? f.sourceId} · loop`);
          }
          for (const page of f.pages) for (const qid of page) {
            if (!qById.has(qid)) continue;
            if (!position.has(qid)) { position.set(qid, order.length); order.push(qid); }
            edge(`q:${qid}`, bid, "inside", `Block ${f.title ?? f.sourceId}`);
            if (parent) edge(`q:${qid}`, parent, "inside", `Block ${f.title ?? f.sourceId}`);
            if (!reachable) unreachable.push({ id: qid, why });
          }
          break;
        }
        case "embedded":
          for (const fld of f.fields) {
            const v = edOf(fld.name);
            v.assigned.push({ location: `Flow · Embedded data ${f.sourceId}`, by: fld.source === "expression" ? "expression" : fld.source, stage: order.length ? "during" : "before_questions", ...(fld.value !== undefined ? { value: fld.value } : {}) });
            if (!edAssignedAt.has(edKey(fld.name))) edAssignedAt.set(edKey(fld.name), order.length);
            if (fld.value) textReads(fld.value, `ed:${edKey(fld.name)}`, `Embedded ${fld.name}`, "ed_assign", "expression");
          }
          break;
        case "branch": {
          const id = node(`branch:${f.sourceId}`, "branch", f.description ?? `Branch ${f.sourceId}`);
          readsOf(f.when, id, "branch", `Flow · Branch ${f.description ?? f.sourceId}`);
          const never = f.when.t === "const" && f.when.value === false;
          /* the adapter parks blocks that are not in the source's flow inside a never-true branch, so the programmer still sees them */
          const parked = never && f.sourceId.startsWith("unused_");
          if (never && !parked) findings.push({ kind: "broken_branch", severity: "medium", location: `Flow · Branch ${f.sourceId}`, message: "This branch's condition is always false, so nothing inside it is ever shown.", refs: [] });
          if (f.when.t === "raw") findings.push({ kind: "broken_branch", severity: "high", location: `Flow · Branch ${f.description ?? f.sourceId}`, message: `This branch's condition could not be read (${f.when.reason}); respondents' paths through it cannot be reproduced until it is rebuilt.`, refs: f.when.refs });
          walk(f.children, reachable && !never, id, parked ? "its block is not in the source's survey flow (kept at the end for reference, never shown)" : undefined);
          break;
        }
        case "randomizer": case "group": walk(f.children, reachable, parent); break;
        case "end": {
          const id = node(`end:${f.sourceId}`, "end", `End (${f.status})`);
          ends.push({ id: f.sourceId, url: f.redirectUrl });
          if (f.redirectUrl) checkRedirect(f.redirectUrl, id, `Flow · End ${f.sourceId} · redirect`);
          break;
        }
        case "quota_check": case "unsupported": break;
      }
    }
  };
  const checkRedirect = (url: string, from: string, location: string) => {
    textReads(url, from, location, "redirect", "redirect");
    const plain = url.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, "x");
    let ok = /^https?:\/\//i.test(plain);
    if (ok) { try { new URL(plain); } catch { ok = false; } }
    if (!ok) findings.push({ kind: "invalid_redirect", severity: "high", location, message: `The redirect “${url.slice(0, 120)}” is not a valid http(s) URL; respondents would not reach it.`, refs: [] });
  };
  walk(c.flow, true, null);

  /* ---------------------------------------------------------------- per question: logic, skips, piping, carry-forward */
  for (const q of c.questions) {
    const from = `q:${q.sourceId}`;
    readsOf(q.displayLogic, from, "display", `${q.variable} · display logic`);
    for (const o of q.options) if (o.displayLogic) readsOf(o.displayLogic, from, "display", `${q.variable} · choice ${o.sourceId} display logic`);
    for (const r of q.rows) if (r.displayLogic) readsOf(r.displayLogic, from, "display", `${q.variable} · row ${r.sourceId} display logic`);
    q.skips.forEach((s, i) => {
      const location = `${q.variable} · skip ${i + 1}`;
      readsOf(s.when, from, "skip", location);
      if (s.to.kind === "question") {
        if (!qById.has(s.to.id)) findings.push({ kind: "missing_reference", severity: "high", location, message: `${location} jumps to question ${s.to.id}, which is not in the survey.`, refs: [s.to.id] });
        else {
          edge(from, `q:${s.to.id}`, "skip_target", location);
          const a = position.get(q.sourceId), b = position.get(s.to.id);
          if (a !== undefined && b !== undefined && b <= a) findings.push({ kind: "circular_dependency", severity: "high", location, message: `${location} jumps BACK to ${qById.get(s.to.id)!.variable}, which comes earlier; a respondent who meets the condition again would loop.`, refs: [s.to.id] });
        }
      } else if (s.to.kind === "block" && !placedBlocks.has(s.to.id)) findings.push({ kind: "missing_reference", severity: "high", location, message: `${location} jumps to block ${s.to.id}, which is not in the survey flow.`, refs: [s.to.id] });
      else if (s.to.kind === "url") checkRedirect(s.to.url, from, `${location} · redirect`);
    });
    textReads(q.text, from, `${q.variable} · text`);
    for (const o of q.options) textReads(o.label, from, `${q.variable} · choice ${o.sourceId}`);
    if (q.carryForward) {
      if (!qById.has(q.carryForward.questionId)) findings.push({ kind: "missing_reference", severity: "high", location: `${q.variable} · carry forward`, message: `${q.variable} carries choices from ${q.carryForward.questionId}, which is not in the survey.`, refs: [q.carryForward.questionId] });
      else edge(from, `q:${q.carryForward.questionId}`, "carry_forward", `${q.variable} · carry forward`);
    }
    for (const code of q.custom) scriptEdges(code, `script:${q.sourceId}`);
  }
  for (const code of c.custom) scriptEdges(code, `script:${code.location}`);
  function scriptEdges(code: CanonicalCustom, id: string) {
    if (code.language !== "javascript") return;
    node(id, "script", `${code.role} (${code.location})`);
    for (const m of code.code.matchAll(/setEmbeddedData\s*\(\s*["']([\w.-]+)["']/g)) {
      const v = edOf(m[1]); v.assigned.push({ location: `${code.location} · ${code.role}`, by: "script", stage: "during" });
      if (!edAssignedAt.has(edKey(m[1]))) edAssignedAt.set(edKey(m[1]), position.get(code.location) ?? 0);
      edge(id, `ed:${edKey(m[1])}`, "script_write", code.location);
    }
    for (const m of code.code.matchAll(/getEmbeddedData\s*\(\s*["']([\w.-]+)["']|\$\{e:\/\/Field\/([\w.-]+)\}/g)) { const name = m[1] ?? m[2]; edOf(name).readBy.push({ location: `${code.location} · ${code.role}`, how: "script" }); edge(id, `ed:${edKey(name)}`, "script_read", code.location); }
    for (const r of code.refs ?? []) if (qById.has(r)) edge(id, `q:${r}`, "script_read", code.location);
  }
  for (const qu of c.quotas) {
    const id = node(`quota:${qu.sourceId}`, "quota", qu.name);
    readsOf(qu.when, id, "quota", `Quota ${qu.name}`, "quota");
    if (qu.onFull === "redirect" && qu.redirectUrl) checkRedirect(qu.redirectUrl, id, `Quota ${qu.name} · redirect`);
  }

  /* ---------------------------------------------------------------- findings over the whole graph */
  /* forward references: display logic reading a question the respondent has not reached yet can only see it unanswered */
  for (const e of edges) {
    if (e.kind !== "display" && e.kind !== "piping" && e.kind !== "carry_forward") continue;
    if (!e.from.startsWith("q:") || !e.to.startsWith("q:") || e.from === e.to) continue;
    const a = position.get(e.from.slice(2)), b = position.get(e.to.slice(2));
    if (a !== undefined && b !== undefined && b > a) findings.push({ kind: "forward_reference", severity: "medium", location: e.location, message: `${e.location} reads ${qById.get(e.to.slice(2))!.variable}, which is asked LATER; at that point it is always unanswered.`, refs: [e.to.slice(2)] });
  }
  /* cycles among question→question dependencies (display, piping, carry-forward) */
  const adj = new Map<string, string[]>();
  for (const e of edges) if ((e.kind === "display" || e.kind === "piping" || e.kind === "carry_forward") && e.from.startsWith("q:") && e.to.startsWith("q:") && e.from !== e.to) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const state = new Map<string, 1 | 2>(); const seenCycles = new Set<string>();
  const dfs = (n: string, stack: string[]) => {
    state.set(n, 1); stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) {
        const cyc = stack.slice(stack.indexOf(m)).map((x) => x.slice(2));
        const key = [...cyc].sort().join(",");
        if (!seenCycles.has(key)) { seenCycles.add(key); findings.push({ kind: "circular_dependency", severity: "high", location: cyc.map((x) => qById.get(x)?.variable ?? x).join(" → "), message: `These questions depend on each other in a circle (${cyc.map((x) => qById.get(x)?.variable ?? x).join(" → ")} → ${qById.get(cyc[0])?.variable ?? cyc[0]}); none of them can be decided first.`, refs: cyc }); }
      } else if (!state.has(m)) dfs(m, stack);
    }
    stack.pop(); state.set(n, 2);
  };
  for (const n of adj.keys()) if (!state.has(n)) dfs(n, []);
  /* unreachable: not placed by the flow, or only inside never-true branches */
  if (c.flow.length) for (const q of c.questions) if (!position.has(q.sourceId)) findings.push({ kind: "unreachable", severity: "medium", location: q.variable, message: `${q.variable} is not placed anywhere in the survey flow (its block is not in the flow), so no respondent sees it.`, refs: [q.sourceId] });
  for (const u of unreachable) findings.push({ kind: "unreachable", severity: "medium", location: qById.get(u.id)?.variable ?? u.id, message: `${qById.get(u.id)?.variable ?? u.id} can never be shown: ${u.why}.`, refs: [u.id] });
  /* embedded data: undefined, read before set, never used */
  for (const v of ed.values()) {
    v.defined = v.assigned.length > 0;
    if (!v.defined && v.readBy.length) findings.push({ kind: "undefined_embedded", severity: "medium", location: v.readBy[0].location, message: `Embedded field ${v.name} is read (${v.readBy.length}×) but never set by the flow, the sample list or a script; every read sees an empty value unless it arrives in the link.`, refs: [v.name] });
    const at = edAssignedAt.get(edKey(v.name));
    if (v.defined && at !== undefined && at > 0 && !v.assigned.some((a) => a.stage === "before_questions")) {
      for (const r of v.readBy) {
        const qid = r.location.split(" · ")[0];
        const q = c.questions.find((x) => x.variable === qid);
        const p = q ? position.get(q.sourceId) : undefined;
        if (p !== undefined && p < at) { findings.push({ kind: "embedded_used_before_assignment", severity: "medium", location: r.location, message: `${r.location} reads ${v.name} before the flow sets it (it is set after question ${at}); the value is empty there.`, refs: [v.name] }); break; }
      }
    }
    if (v.defined && !v.readBy.length && v.assigned.every((a) => a.by !== "url" && a.by !== "panel")) findings.push({ kind: "unused_embedded", severity: "info", location: `Embedded ${v.name}`, message: `Embedded field ${v.name} is set but never read by logic, piping, a redirect or a script; it is still saved with the response.`, refs: [v.name] });
  }

  const byKind: ImportGraph["stats"]["byKind"] = {};
  for (const e of edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const fk: ImportGraph["stats"]["findings"] = {};
  for (const f of findings) fk[f.kind] = (fk[f.kind] ?? 0) + 1;
  return { nodes: [...nodes.values()], edges, order, embedded: [...ed.values()], findings, stats: { nodes: nodes.size, edges: edges.length, byKind, findings: fk } };
}

/** the questions (by source id) a question depends on, directly — for "why does Q8 depend on…" */
export function dependenciesOf(g: ImportGraph, sourceId: string): { to: string; kind: GEdgeKind; location: string }[] {
  return g.edges.filter((e) => e.from === `q:${sourceId}` && e.kind !== "inside").map((e) => ({ to: e.to, kind: e.kind, location: e.location }));
}

/** the elements that depend on this question — what breaks if it is removed */
export function dependentsOf(g: ImportGraph, sourceId: string): { from: string; kind: GEdgeKind; location: string }[] {
  return g.edges.filter((e) => e.to === `q:${sourceId}` && e.kind !== "inside").map((e) => ({ from: e.from, kind: e.kind, location: e.location }));
}

