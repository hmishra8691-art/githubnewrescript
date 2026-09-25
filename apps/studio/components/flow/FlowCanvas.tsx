"use client";
import React from "react";
import type { FlowNode, LogicFlow } from "@rescript/schema";
import {
  buildLogicFlow, buildDependencyIndex, objectStatus, flowNodeIndex,
  type ObjectKey,
} from "@rescript/engine";
import { useStudio } from "../studio/store";
import { useSelection } from "../studio/SelectionContext";
import { useMode } from "../studio/ModeContext";
import { useCommands } from "../studio/CommandContext";
import { Inspector } from "../architect/Inspector";
import { Icon } from "../ui/Icon";
import {
  layoutFlow, upstream, downstream, edgesTouching, fitTransform,
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
 * Editing goes through the same functions the Survey Flow panel uses:
 * `moveFlowNode` with `canDropFlowNode`'s verdict when a node is dropped on
 * another; a dragged position is stored on `def.logicFlow` by id so it
 * survives a reload and every other environment leaves it alone.
 *
 * Hand-rolled: SVG, a `<g transform>`, wheel and pointer handlers. No graph
 * library — the layout is 200 lines and the canvas owes nothing to anyone.
 */

const INSPECTOR_W = 380;
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
  const graph = React.useMemo<LogicFlow>(() => buildLogicFlow(def, { questions: questionsGranularity, layout: def.logicFlow }), [def, questionsGranularity]);
  const layout = React.useMemo<Layout>(() => layoutFlow(graph), [graph]);
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

  /* drag: background pans; a node moves (and pins) or drops onto another */
  const drag = React.useRef<{ kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [dragPos, setDragPos] = React.useState<{ id: string; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent, nodeId?: string) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const n = nodeId ? layout.byId.get(nodeId) : undefined;
    drag.current = { kind: nodeId ? "node" : "pan", id: nodeId, sx: e.clientX, sy: e.clientY, ox: n ? n.x : view.tx, oy: n ? n.y : view.ty, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === "pan") setView((v) => ({ ...v, tx: d.ox + dx, ty: d.oy + dy }));
    else if (d.id && d.moved) {
      const x = d.ox + dx / view.k, y = d.oy + dy / view.k;
      setDragPos({ id: d.id, x, y });
    }
  };
  /*
   * FLOW IS FOR UNDERSTANDING (round 2, §4). A click selects — the one
   * shared selection, so a Studio pane beside this one lands on the same
   * question; a drag repositions the node on the canvas (a view concern,
   * stored by id). Nothing here changes the survey's structure: dropping a
   * node onto a container used to move it there; that is Architect's and
   * Studio's work now, and a drop is simply a reposition.
   */
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    if (d.kind === "node" && d.id) {
      if (!d.moved) { select(d.id, e); }
      else if (dragPos && !s.readOnly) { pin(d.id, Math.round(dragPos.x), Math.round(dragPos.y)); }
    }
    setDragPos(null);
  };

  /** store a dragged position on the survey, by node id */
  const pin = (id: string, x: number, y: number) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    s.labelNextEdit("move flow node");
    s.update((dd) => {
      const lf = dd.logicFlow ?? { nodes: [], edges: [] };
      const i = lf.nodes.findIndex((n) => n.id === id);
      const stored = { id, kind: node.kind, ref: node.ref, label: node.label, x, y };
      if (i >= 0) lf.nodes[i] = { ...lf.nodes[i], x, y }; else lf.nodes.push(stored);
      dd.logicFlow = lf;
    });
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
  const autoArrange = () => {
    s.labelNextEdit("auto-arrange flow");
    s.update((dd) => { dd.logicFlow = { nodes: [], edges: [] }; });
    setTimeout(fit, 0);
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
  const pos = (n: LaidOutNode) => (dragPos?.id === n.id ? { x: dragPos.x, y: dragPos.y } : { x: n.x, y: n.y });

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
          <button className="fc-chip" onClick={autoArrange} disabled={s.readOnly} title="Forget dragged positions and lay out afresh" data-testid="flow-arrange">Auto-arrange</button>
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
        {highlight && selectedNode && (
          <div className="fc-legend" data-testid="flow-legend">
            <span className="fc-lg up">◼ can reach {selectedNode.label?.split(" ")[0] ?? "this"} · {highlight.up.size}</span>
            <span className="fc-lg down">◼ {selectedNode.label?.split(" ")[0] ?? "this"} can affect · {highlight.down.size}</span>
            {focus && <span className="muted">focus: everything else dimmed</span>}
          </div>
        )}
        <div
          className={`fc-host${drag.current?.kind === "pan" ? " panning" : ""}`}
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
              {layout.edges.map((e) => {
                const a = layout.byId.get(e.from), b = layout.byId.get(e.to);
                if (!a || !b) return null;
                // re-route while a node is being dragged
                let d = e.d;
                if (dragPos && (dragPos.id === e.from || dragPos.id === e.to)) {
                  const pa = pos(a), pb = pos(b);
                  const x1 = pa.x + a.w / 2, y1 = pa.y + a.h, x2 = pb.x + b.w / 2, y2 = pb.y;
                  const c = Math.max(24, Math.abs(y2 - y1) / 2);
                  d = `M ${x1} ${y1} C ${x1} ${y1 + c}, ${x2} ${y2 - c}, ${x2} ${y2}`;
                }
                return (
                  <g key={e.id} className={edgeClass(e)} data-testid="flow-edge" data-kind={e.kind} data-from={e.from} data-to={e.to}>
                    <path d={d} markerEnd={`url(#fc-arrow-${e.kind})`} />
                    {showLabels && e.label && e.kind !== "sequence" && (
                      <text x={e.lx} y={e.ly} className="fc-edge-label">{e.label.length > 42 ? `${e.label.slice(0, 40)}…` : e.label}</text>
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
                    {n.pinned && <circle className="fc-pin" cx={n.w - 8} cy={8} r={2.5} />}
                    {st !== "ok" && <circle className={`fc-status ${st}`} cx={n.w - 10} cy={n.h - 10} r={4} />}
                    <text x={12} y={n.kind === "decision" ? 21 : 18} className="fc-node-title">
                      {n.kind === "decision" ? n.label?.split(" — ")[0] : n.label?.split(" ")[0]}
                    </text>
                    {showLabels && (
                      <text x={12} y={n.kind === "decision" ? 38 : 34} className="fc-node-sub">
                        {(n.kind === "decision" ? (n.label?.split(" — ")[1] ?? "") : (n.label?.split(" ").slice(1).join(" ") ?? "")).slice(0, 34)}
                      </text>
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
