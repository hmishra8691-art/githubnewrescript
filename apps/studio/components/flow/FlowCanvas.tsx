"use client";
import React from "react";
import type { FlowNode, LogicFlow } from "@rescript/schema";
import {
  buildLogicFlow, buildDependencyIndex, objectStatus, flowNodeIndex, conditionSummary,
  type ObjectKey,
} from "@rescript/engine";
import { useStudio } from "../studio/store";
import { useSelection } from "../studio/SelectionContext";
import { useMode } from "../studio/ModeContext";
import { useCommands } from "../studio/CommandContext";
import { Inspector } from "../architect/Inspector";
import { Icon } from "../ui/Icon";
import {
  layoutFlow, upstream, downstream, edgesTouching, fitTransform, pageFrames,
  type Layout, type LaidOutNode, type LaidOutEdge,
} from "../../lib/flow/layout";
import { debugPath, type DebugResult } from "../../lib/flow/debug";

/**
 * FLOW — the survey's behaviour, drawn.
 *
 * The engine's `buildLogicFlow` is the graph: pages or questions as nodes,
 * and every way a respondent moves between them as a typed edge — the next
 * page, a branch arm, an otherwise, a skip, a loop's next iteration, a
 * quota's "full". This canvas lays it out (lib/flow/layout.ts) and lets a
 * programmer read it, select in it, rearrange it and debug it.
 *
 * Select a node and two questions are answered at once, in colour: WHAT CAN
 * REACH THIS (every node upstream, following the edges backwards) and WHAT
 * CAN THIS AFFECT (downstream, plus everything the dependency index says
 * reads it). Everything else recedes. Focus mode makes that receding
 * stronger, for the same reason it exists everywhere: in a 600-question
 * survey the twelve things that matter must stand out.
 *
 * Debug mode types hypothetical answers and lights the path a respondent
 * with those answers would take — a real walk through the real engine, so
 * skips fire and loops repeat.
 *
 * FLOW DOES NOT EDIT (UI upgrade §9). Nothing on this canvas moves a node,
 * reorders a question or changes the survey: a click selects, a drag pans,
 * a double-click opens the object in Studio. The layout is derived every
 * time from the programming, so the picture is the survey and never a
 * stale arrangement of it.
 *
 * WHAT THE READER SEES (§10–§15): every question in sequence, framed by
 * the page it is on; a badge on the objects that are not plain questions
 * (H hidden variable, embedded data, loop, quota, conjoint, MaxDiff,
 * screen-out); the display condition on a node shown only sometimes; and a
 * label on every edge that is a decision — the skip's condition, the
 * branch arm, "otherwise", "quota full" / "quota available".
 *
 * Hand-rolled: SVG, a `<g transform>`, wheel and pointer handlers. No graph
 * library — the layout is 200 lines and the canvas owes nothing to anyone.
 */

const INSPECTOR_W = 380;
/** the badge on a node that is not a plain question, and what the legend calls it (§14) */
const TAG_TEXT: Record<string, string> = {
  hidden: "H", calculated: "fx", conjoint: "CONJOINT", maxdiff: "MAXDIFF", embedded: "EMBEDDED", loop: "LOOP", quota: "QUOTA",
  randomizer: "RANDOM", branch: "BRANCH", gate: "IF", redirect: "REDIRECT", screened: "SCREEN OUT", quota_full: "QUOTA FULL", terminated: "TERMINATE", complete: "END",
};
const TAG_LEGEND: Record<string, string> = {
  hidden: "hidden variable", calculated: "calculated value", conjoint: "conjoint task", maxdiff: "MaxDiff task", embedded: "embedded data", loop: "loop", quota: "quota check",
  randomizer: "randomizer", branch: "branch", gate: "shown only when", redirect: "redirect", screened: "screened out", quota_full: "quota full", terminated: "terminated", complete: "complete",
};
const badgeWidth = (tag: string) => Math.max(18, (TAG_TEXT[tag]?.length ?? 1) * 6.4 + 8);
const PREFS_KEY = "rescript.flow";
interface Prefs { granularity: "auto" | "pages" | "questions"; inspector: boolean }
function loadPrefs(): Prefs {
  try { const raw = typeof window !== "undefined" ? window.localStorage.getItem(PREFS_KEY) : null; if (raw) return { ...{ granularity: "auto", inspector: true }, ...JSON.parse(raw) }; } catch { /* fine */ }
  return { granularity: "auto", inspector: true };
}

type View = { k: number; tx: number; ty: number };

export function FlowCanvas() {
  const s = useStudio();
  const sel = useSelection();
  const mode = useMode();
  const cmd = useCommands();
  const def = s.def;
  const focus = mode?.focus ?? false;

  /* ------------------------------------------------------------ graph + layout */
  const [prefs, setPrefs] = React.useState<Prefs>(loadPrefs);
  const savePrefs = (p: Prefs) => { setPrefs(p); try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* fine */ } };
  const questionsGranularity = prefs.granularity === "questions" || (prefs.granularity === "auto" && def.questions.length <= 150);
  // `layout: null` — the canvas is derived, never arranged by hand; positions stored on older surveys are left alone and ignored
  const graph = React.useMemo<LogicFlow>(() => buildLogicFlow(def, { questions: questionsGranularity, layout: null }), [def, questionsGranularity]);
  const layout = React.useMemo<Layout>(() => layoutFlow(graph), [graph]);
  const frames = React.useMemo(() => (questionsGranularity ? pageFrames(layout.nodes) : []), [layout, questionsGranularity]);
  const tagsPresent = React.useMemo(() => new Set(layout.nodes.map((n) => n.tag).filter((t): t is string => !!t && t in TAG_TEXT)), [layout]);
  const deferredDef = React.useDeferredValue(def);
  const index = React.useMemo(() => buildDependencyIndex(deferredDef), [deferredDef]);
  const status = React.useMemo(() => objectStatus(deferredDef), [deferredDef]);
  const flowIdx = React.useMemo(() => flowNodeIndex(def.flow as FlowNode[]), [def.flow]);
  const questionIds = React.useMemo(() => new Set(def.questions.map((q) => q.id)), [def.questions]);

  /** a graph node's engine key — questions by id, everything else a flow node */
  const keyOf = React.useCallback((nodeId: string): ObjectKey | null => {
    if (questionIds.has(nodeId)) return `question:${nodeId}`;
    if (flowIdx.has(nodeId)) return `flowNode:${nodeId}`;
    return null;
  }, [questionIds, flowIdx]);
  /** the graph node for an engine key, if it is drawn */
  const nodeOfKey = React.useCallback((key: ObjectKey | null): LaidOutNode | null => {
    if (!key) return null;
    const id = key.slice(key.indexOf(":") + 1);
    if (layout.byId.has(id)) return layout.byId.get(id)!;
    // a question selected elsewhere while the canvas shows pages: light its page
    if (key.startsWith("question:")) {
      for (const n of layout.nodes) { const fn = flowIdx.get(n.id); if (fn?.type === "page" && fn.questionIds.includes(id)) return n; }
    }
    return null;
  }, [layout, flowIdx]);

  /* ------------------------------------------------------------ selection + highlight */
  const primary = (sel?.primary ?? (s.selectedQuestionId ? `question:${s.selectedQuestionId}` : null)) as ObjectKey | null;
  const selectedNode = nodeOfKey(primary);
  const highlight = React.useMemo(() => {
    if (!selectedNode) return null;
    const up = upstream(graph, selectedNode.id);
    const down = downstream(graph, selectedNode.id);
    // the dependency index adds data effects the routing graph does not draw
    if (primary) for (const k of index.affects(primary)) { const n = nodeOfKey(k as ObjectKey); if (n) down.add(n.id); }
    const all = new Set([selectedNode.id, ...up, ...down]);
    return { up, down, all, edges: edgesTouching(graph, all) };
  }, [selectedNode, graph, index, primary, nodeOfKey]);

  const select = (nodeId: string, e?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const key = keyOf(nodeId);
    if (!key) return;
    if (!sel) { s.select(key.startsWith("question:") ? nodeId : null); return; }
    if (e?.metaKey || e?.ctrlKey) sel.dispatch({ type: "toggle", key });
    else sel.dispatch({ type: "select", key });
  };

  /* ------------------------------------------------------------ viewport */
  const hostRef = React.useRef<HTMLDivElement>(null);
  // 0×0 until measured: the first fit must use the real viewport, or a
  // canvas mounted in a split pane fits to a width it does not have
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  const [view, setView] = React.useState<View>({ k: 1, tx: 40, ty: 40 });
  const fitted = React.useRef(false);
  React.useEffect(() => {
    const el = hostRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const fit = React.useCallback(() => setView(fitTransform(layout.width, layout.height, size.w, size.h)), [layout.width, layout.height, size]);
  React.useEffect(() => { if (!fitted.current && size.w > 100) { fitted.current = true; fit(); } }, [size, fit]);
  const zoomBy = (factor: number, cx = size.w / 2, cy = size.h / 2) => setView((v) => {
    const k = Math.max(0.05, Math.min(3, v.k * factor));
    return { k, tx: cx - (cx - v.tx) * (k / v.k), ty: cy - (cy - v.ty) * (k / v.k) };
  });
  /** an exact scale (1 = 100 %), about the viewport's centre — the typed zoom and the reset */
  const zoomTo = (k0: number, cx = size.w / 2, cy = size.h / 2) => setView((v) => {
    const k = Math.max(0.05, Math.min(3, k0));
    return { k, tx: cx - (cx - v.tx) * (k / v.k), ty: cy - (cy - v.ty) * (k / v.k) };
  });
  const centreOn = React.useCallback((n: LaidOutNode) => setView((v) => ({ k: Math.max(v.k, 0.8), tx: size.w / 2 - (n.x + n.w / 2) * Math.max(v.k, 0.8), ty: size.h / 2 - (n.y + n.h / 2) * Math.max(v.k, 0.8) })), [size]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = hostRef.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    else setView((v) => ({ ...v, tx: v.tx - (e.shiftKey ? e.deltaY : e.deltaX), ty: v.ty - (e.shiftKey ? 0 : e.deltaY) }));
  };

  /*
   * DRAG PANS, CLICK SELECTS — nothing moves (UI upgrade §9). A press on a
   * node that travels more than a few pixels is a pan, like a press on the
   * background; one that does not is a click, and selects.
   */
  const drag = React.useRef<{ id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent, nodeId?: string) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: nodeId, sx: e.clientX, sy: e.clientY, ox: view.tx, oy: view.ty, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, tx: d.ox + dx, ty: d.oy + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (d.id && !d.moved) select(d.id, e);
  };
  /**
   * "Flow → click Q12 → Studio opens Q12" (round 2, §4). The selection is
   * already shared; what changes is which environment is on screen. In a
   * split that already shows Studio, nothing needs to change — the Studio
   * pane has followed the selection; otherwise the primary becomes Studio.
   */
  const openInStudio = () => {
    if (mode?.mode === "studio" || mode?.split === "studio") return;
    cmd?.run("mode.studio");
  };

  /* ------------------------------------------------------------ search, debug */
  const [search, setSearch] = React.useState("");
  const matches = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return new Set(layout.nodes.filter((n) => (n.label ?? "").toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id));
  }, [search, layout]);
  React.useEffect(() => { if (matches && matches.size) { const n = layout.byId.get([...matches][0]); if (n) centreOn(n); } }, [matches, layout, centreOn]);

  const [debugOn, setDebugOn] = React.useState(false);
  const [answers, setAnswers] = React.useState("");
  const debug = React.useMemo<DebugResult | null>(() => (debugOn ? debugPath(def, answers) : null), [debugOn, def, answers]);
  const debugNodes = React.useMemo(() => {
    if (!debug) return null;
    const set = new Set<string>(debug.pageIds);
    for (const q of debug.questionIds) set.add(q);
    return set;
  }, [debug]);

  /* ------------------------------------------------------------ keyboard */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.2); }
    else if (e.key === "-") { e.preventDefault(); zoomBy(1 / 1.2); }
    else if (e.key === "0") { e.preventDefault(); fit(); }
    else if (e.key === "Escape" && sel?.keys.length) { e.preventDefault(); sel.dispatch({ type: "clear" }); }
  };

  /* ------------------------------------------------------------ render */
  const showLabels = view.k >= 0.55;
  const inspectorOpen = prefs.inspector;
  const nodeClass = (n: LaidOutNode) => {
    const cls = [`fc-node fc-${n.kind}`];
    const key = keyOf(n.id);
    if (key && sel?.isSelected(key)) cls.push("selected");
    if (selectedNode?.id === n.id) cls.push("primary");
    if (highlight) {
      if (highlight.up.has(n.id)) cls.push("up");
      else if (highlight.down.has(n.id)) cls.push("down");
      else if (n.id !== selectedNode?.id) cls.push(focus ? "dim-hard" : "dim");
    }
    if (matches) cls.push(matches.has(n.id) ? "match" : "nomatch");
    if (debugNodes) cls.push(debugNodes.has(n.id) ? "taken" : "untaken");
    if (key && status.statusOf(key).level !== "ok") cls.push(`st-${status.statusOf(key).level}`);
    return cls.join(" ");
  };
  const edgeClass = (e: LaidOutEdge) => {
    const cls = [`fc-edge fc-e-${e.kind}`];
    if (e.back) cls.push("back");
    if (highlight) cls.push(highlight.edges.has(e.id) ? "lit" : (focus ? "dim-hard" : "dim"));
    if (debugNodes) cls.push(debugNodes.has(e.from) && debugNodes.has(e.to) ? "taken" : "untaken");
    return cls.join(" ");
  };
  const pos = (n: LaidOutNode) => ({ x: n.x, y: n.y });

  // minimap
  const mm = { w: 160, h: Math.max(60, Math.min(220, Math.round(160 * layout.height / Math.max(1, layout.width)))) };
  const mmk = Math.min(mm.w / Math.max(1, layout.width), mm.h / Math.max(1, layout.height));

  return (
    <div className="fc" data-testid="flow-view" style={{ gridTemplateColumns: inspectorOpen ? `minmax(0, 1fr) ${INSPECTOR_W}px` : "minmax(0, 1fr)" }}>
      <div className="fc-main">
        <div className="fc-toolbar">
          <div className="fc-seg" role="radiogroup" aria-label="Granularity" data-testid="flow-granularity">
            {(["auto", "pages", "questions"] as const).map((g) => (
              <button key={g} role="radio" aria-checked={prefs.granularity === g} className={prefs.granularity === g ? "on" : ""} data-granularity={g}
                onClick={() => { savePrefs({ ...prefs, granularity: g }); fitted.current = false; }}>{g === "auto" ? `Auto · ${questionsGranularity ? "questions" : "pages"}` : g}</button>
            ))}
          </div>
          <div className="fc-search">
            <Icon name="search" size={13} />
            <input className="fc-search-input" data-testid="flow-search" placeholder="Find a node…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            {matches && <span className="fc-search-n">{matches.size}</span>}
          </div>
          <span className="fc-count" data-testid="flow-count">{layout.nodes.length} nodes · {layout.edges.length} edges</span>
          <span className="grow" />
          <button className={`fc-chip${debugOn ? " on" : ""}`} data-testid="flow-debug-toggle" onClick={() => setDebugOn((v) => !v)} title="Type answers and see the path a respondent takes"><Icon name="flask" size={12} /> Debug</button>
          <button className={`fc-chip${focus ? " on" : ""}`} data-testid="focus-toggle" aria-pressed={focus} onClick={() => mode?.setFocus(!focus)} title="Focus (⌘⇧F)"><Icon name="sparkle" size={12} /> Focus</button>
          <div className="fc-seg fc-zoom" role="group" aria-label="Zoom">
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out (−)" data-testid="flow-zoom-out">−</button>
            <ZoomInput k={view.k} onApply={zoomTo} />
            <button onClick={() => zoomBy(1.2)} title="Zoom in (+)" data-testid="flow-zoom-in">+</button>
            <button onClick={fit} title="Fit to screen (0)" data-testid="flow-fit">Fit</button>
            <button onClick={() => zoomTo(1)} title="Reset to 100% (1)" data-testid="flow-zoom-reset">1:1</button>
          </div>
          <button className={`fc-chip${inspectorOpen ? " on" : ""}`} onClick={() => savePrefs({ ...prefs, inspector: !inspectorOpen })} title="Inspector" data-testid="flow-inspector-toggle"><Icon name="info" size={12} /></button>
        </div>
        {debugOn && (
          <div className="fc-debug" data-testid="flow-debug">
            <span className="fc-debug-kw">ANSWERS</span>
            <input className="fc-debug-input" data-testid="flow-debug-input" placeholder="Q2=A, Q1=30, Q11=1|3 — codes or labels; | separates a multi-select" value={answers} onChange={(e) => setAnswers(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            {debug && (
              <span className="fc-debug-out" data-testid="flow-debug-out">
                {debug.pageIds.length} page{debug.pageIds.length === 1 ? "" : "s"} · {debug.questionIds.size} questions
                {debug.endStatus ? ` · ends ${debug.endStatus}` : ""}
                {debug.unknown.length ? ` · unknown: ${debug.unknown.join(", ")}` : ""}
                {debug.truncated ? " · stopped at the page guard" : ""}
              </span>
            )}
          </div>
        )}
        {tagsPresent.size > 0 && (
          <div className="fc-tags" data-testid="flow-tag-legend">
            {[...tagsPresent].map((t) => <span key={t} className={`fc-tag-key fc-badge-${t}`}><i>{TAG_TEXT[t]}</i> {TAG_LEGEND[t] ?? t}</span>)}
          </div>
        )}
        {highlight && selectedNode && (
          <div className="fc-legend" data-testid="flow-legend">
            <span className="fc-lg up">◼ can reach {selectedNode.label?.split(" ")[0] ?? "this"} · {highlight.up.size}</span>
            <span className="fc-lg down">◼ {selectedNode.label?.split(" ")[0] ?? "this"} can affect · {highlight.down.size}</span>
            {focus && <span className="muted">focus: everything else dimmed</span>}
          </div>
        )}
        <div
          className={`fc-host${drag.current?.moved ? " panning" : ""}`}
          ref={hostRef}
          tabIndex={0}
          onWheel={onWheel}
          onPointerDown={(e) => { if ((e.target as Element).closest(".fc-node")) return; onPointerDown(e); }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          data-testid="flow-canvas"
        >
          <svg className="fc-svg" width="100%" height="100%">
            <defs>
              {(["sequence", "gate", "branch", "otherwise", "skip", "loop", "quota"] as const).map((k) => (
                <marker key={k} id={`fc-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className={`fc-arrow fc-e-${k}`} />
                </marker>
              ))}
            </defs>
            <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`} data-testid="flow-viewport">
              {/* PAGES: the questions a respondent sees together, framed (§15) */}
              {frames.map((f) => {
                const fn = flowIdx.get(f.id);
                const title = fn && fn.type === "page" ? fn.title : undefined;
                const lit = highlight ? layout.nodes.some((n) => n.page === f.id && highlight.all.has(n.id)) : true;
                return (
                  <g key={f.id} className={`fc-page${lit ? "" : (focus ? " dim-hard" : " dim")}`} data-testid="flow-page" data-page={f.id} onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, f.id); }}>
                    <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={12} />
                    {showLabels && <text x={f.x + 10} y={f.y + f.h - 7} className="fc-page-label">{`${title ? title : "Page"} · ${f.count} question${f.count === 1 ? "" : "s"}`}</text>}
                  </g>
                );
              })}
              {layout.edges.map((e) => {
                const a = layout.byId.get(e.from), b = layout.byId.get(e.to);
                if (!a || !b) return null;
                return (
                  <g key={e.id} className={edgeClass(e)} data-testid="flow-edge" data-kind={e.kind} data-from={e.from} data-to={e.to} data-label={e.label ?? ""}>
                    <path d={e.d} markerEnd={`url(#fc-arrow-${e.kind})`} />
                    {/* every decision says why it is taken: the arm, the skip's condition, "otherwise", "quota full" (§11–§12) */}
                    {showLabels && e.label && (
                      <text x={e.lx} y={e.ly} className={`fc-edge-label fc-el-${e.kind}`} data-testid="flow-edge-label" data-when={e.when ? conditionSummary(def, e.when) : ""}><title>{e.when ? `${e.label} — when ${conditionSummary(def, e.when)}` : e.label}</title>{e.label.length > 42 ? `${e.label.slice(0, 40)}…` : e.label}</text>
                    )}
                  </g>
                );
              })}
              {layout.nodes.map((n) => {
                const p = pos(n);
                const key = keyOf(n.id);
                const st = key ? status.statusOf(key).level : "ok";
                return (
                  <g key={n.id} className={nodeClass(n)} transform={`translate(${p.x} ${p.y})`}
                    data-testid="flow-node" data-node={n.id} data-kind={n.kind}
                    onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, n.id); }}
                    onDoubleClick={() => { if (key) { select(n.id); openInStudio(); } }}
                  >
                    <rect width={n.w} height={n.h} rx={n.kind === "decision" ? 6 : 8} />
                    {n.kind === "decision" && <rect className="fc-accent" width={4} height={n.h} rx={2} />}
                    {st !== "ok" && <circle className={`fc-status ${st}`} cx={n.w - 10} cy={n.h - 10} r={4} />}
                    <text x={12} y={n.kind === "decision" ? 21 : 18} className="fc-node-title">
                      {n.kind === "decision" ? n.label?.split(" — ")[0] : n.label?.split(" ")[0]}
                    </text>
                    {/* THE BADGE: what this object is, when it is not a plain question (§14) */}
                    {n.tag && TAG_TEXT[n.tag] && (
                      <g className={`fc-badge fc-badge-${n.tag}`} transform={`translate(${n.w - 8 - badgeWidth(n.tag)} 6)`} data-testid="flow-badge" data-tag={n.tag}>
                        <rect width={badgeWidth(n.tag)} height={14} rx={3} />
                        <text x={badgeWidth(n.tag) / 2} y={10.5} textAnchor="middle">{TAG_TEXT[n.tag]}</text>
                      </g>
                    )}
                    {showLabels && (
                      <text x={12} y={n.kind === "decision" ? 38 : 34} className="fc-node-sub">
                        {(n.kind === "decision" ? (n.label?.split(" — ")[1] ?? "") : (n.label?.split(" ").slice(1).join(" ").replace(/\s*\((?:conditional|\d+ skip)(?:, (?:conditional|\d+ skip))*\)$/, "") ?? "")).slice(0, 34)}
                      </text>
                    )}
                    {/* WHY IT SHOWS: the display condition, on the node (§11) */}
                    {showLabels && n.condition && n.kind === "question" && (
                      <text x={12} y={n.h - 6} className="fc-node-cond" data-testid="flow-node-condition"><tspan className="fc-node-if">IF </tspan>{n.condition.length > 36 ? `${n.condition.slice(0, 34)}…` : n.condition}</text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          {/* minimap */}
          <svg className="fc-minimap" width={mm.w} height={mm.h} data-testid="flow-minimap"
            onClick={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const x = (e.clientX - r.left) / mmk, y = (e.clientY - r.top) / mmk; setView((v) => ({ ...v, tx: size.w / 2 - x * v.k, ty: size.h / 2 - y * v.k })); }}>
            <g transform={`scale(${mmk})`}>
              {layout.nodes.map((n) => <rect key={n.id} x={n.x} y={n.y} width={n.w} height={n.h} className={`fc-mm-node${highlight?.all.has(n.id) ? " lit" : ""}`} />)}
              <rect className="fc-mm-view" x={-view.tx / view.k} y={-view.ty / view.k} width={size.w / view.k} height={size.h / view.k} />
            </g>
          </svg>
          {layout.nodes.length === 0 && <div className="fc-empty">The survey has no flow yet.</div>}
        </div>
      </div>
      {inspectorOpen && (
        <aside className="fc-inspector" data-testid="flow-inspector">
          <div className="ar-pane-head"><span className="ar-pane-title">Inspector</span></div>
          <div className="ar-inspector-body">
            <Inspector primary={primary} index={index} status={status} readOnly onOpenInStudio={() => openInStudio()} onSelect={(k) => { if (sel) sel.dispatch({ type: "select", key: k }); const n = nodeOfKey(k); if (n) centreOn(n); }} />
          </div>
        </aside>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ zoom input */

/**
 * The zoom as a number you can type (round 2, §5): click the percentage,
 * type 25, 50, 100 or 150, Enter applies; Escape restores; anything that
 * is not a number between 5 and 300 is refused and the field snaps back.
 */
function ZoomInput({ k, onApply }: { k: number; onApply(k: number): void }) {
  const [text, setText] = React.useState<string | null>(null);
  const shown = text ?? `${Math.round(k * 100)}%`;
  const commit = () => {
    if (text === null) return;
    const n = Number(text.replace(/[%\s]/g, ""));
    if (Number.isFinite(n) && n >= 5 && n <= 300) onApply(n / 100);
    setText(null);
  };
  return (
    <input
      className="fc-zoom-input" data-testid="flow-zoom-input" value={shown} inputMode="numeric" aria-label="Zoom percentage" title="Type a zoom level, 5–300 %, then Enter"
      onFocus={(e) => { setText(`${Math.round(k * 100)}`); requestAnimationFrame(() => e.target.select()); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setText(null); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
