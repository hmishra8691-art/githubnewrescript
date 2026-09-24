"use client";
import React from "react";
import { buildDependencyIndex, objectStatus, parseObjectKey, type ObjectKey } from "@rescript/engine";
import { useStudio } from "../studio/store";
import { useSelection } from "../studio/SelectionContext";
import { useMode } from "../studio/ModeContext";
import { buildSurveyMap, flattenMap, ancestorKeys, containerKeys, findMapNode } from "../../lib/architect/map";
import { SurveyMap } from "./SurveyMap";
import { Workspace } from "./Workspace";
import { Inspector } from "./Inspector";
import { Icon } from "../ui/Icon";

/**
 * ARCHITECT — a development environment for survey programming.
 *
 *   ┌────────────────┬──────────────────────────────┬─────────────────┐
 *   │ SURVEY MAP     │ PROGRAMMING WORKSPACE       │ INSPECTOR       │
 *   └────────────────┴──────────────────────────────┴─────────────────┘
 *
 * Three panes over one survey. The map is the structure (lib/architect/
 * map.ts); the workspace is the editor for whatever is selected; the
 * inspector is how it is wired. Selection is the Studio's shared selection,
 * so a question picked here is the question Grid has selected and the
 * question the Studio's property panel would show.
 *
 * Focus mode dims everything in the map outside the selection's dependency
 * neighbourhood — what it reads, what reads it, transitively — so in a
 * 600-question survey the twelve objects that matter to Q14 stand out.
 *
 * Panes resize by dragging their divider; widths are remembered per browser.
 */

const PREFS_KEY = "rescript.architect";
interface Prefs { map: number; inspector: number }
const DEFAULT_PREFS: Prefs = { map: 300, inspector: 400 };
function loadPrefs(): Prefs {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(PREFS_KEY) : null;
    if (raw) { const p = JSON.parse(raw); if (typeof p.map === "number" && typeof p.inspector === "number") return p; }
  } catch { /* fine */ }
  return DEFAULT_PREFS;
}

export function ArchitectView() {
  const s = useStudio();
  const sel = useSelection();
  const mode = useMode();
  const focus = mode?.focus ?? false;

  /* ------------------------------------------------------------ derived */
  const deferredDef = React.useDeferredValue(s.def);
  const status = React.useMemo(() => objectStatus(deferredDef), [deferredDef]);
  const index = React.useMemo(() => buildDependencyIndex(deferredDef), [deferredDef]);
  const root = React.useMemo(() => buildSurveyMap(s.def, { status, index }), [s.def, status, index]);

  const primary = (sel?.primary ?? (s.selectedQuestionId ? `question:${s.selectedQuestionId}` : null)) as ObjectKey | null;
  const selectedKeys = React.useMemo(() => new Set<string>(sel?.keys ?? (primary ? [primary] : [])), [sel?.keys, primary]);

  /* ------------------------------------------------------------ collapse + search */
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const [search, setSearch] = React.useState("");
  const toggle = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  // a selection made elsewhere (Grid, palette, a dependency link) must be visible: expand its ancestors
  React.useEffect(() => {
    if (!primary) return;
    const path = ancestorKeys(root, primary);
    if (path.some((k) => collapsed.has(k))) setCollapsed((c) => { const n = new Set(c); for (const k of path) n.delete(k); return n; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, root]);

  const rows = React.useMemo(() => {
    const all = flattenMap(root, search ? new Set() : collapsed);
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    // keep a row when it matches, or when a descendant matches (so the path stays visible)
    const matches = new Set<string>();
    const visit = (n: typeof root): boolean => {
      const self = `${n.label} ${n.code ?? ""} ${n.detail ?? ""}`.toLowerCase().includes(q);
      let any = self;
      for (const c of n.children) if (visit(c)) any = true;
      if (any) matches.add(n.key);
      return any;
    };
    visit(root);
    return all.filter((r) => matches.has(r.key));
  }, [root, collapsed, search]);

  /* ------------------------------------------------------------ focus */
  const focusSet = React.useMemo(() => {
    if (!focus || !primary) return null;
    const set = new Set<string>([primary, ...index.reach(primary), ...index.affects(primary)]);
    // containers on the path to any focused object stay legible too
    for (const k of [...set]) for (const a of ancestorKeys(root, k)) set.add(a);
    return set;
  }, [focus, primary, index, root]);

  /* ------------------------------------------------------------ selection */
  const select = (key: ObjectKey, e?: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (!sel) { const { kind, id } = parseObjectKey(key); s.select(kind === "question" ? id : null); return; }
    if (e?.metaKey || e?.ctrlKey) sel.dispatch({ type: "toggle", key });
    else if (e?.shiftKey) sel.dispatch({ type: "range", key, order: rows.filter((r) => r.selectable).map((r) => r.key as ObjectKey) });
    else sel.dispatch({ type: "select", key });
  };

  /* ------------------------------------------------------------ panes */
  const [prefs, setPrefs] = React.useState<Prefs>(loadPrefs);
  const save = (p: Prefs) => { setPrefs(p); try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* fine */ } };
  const startDrag = (which: "map" | "inspector") => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = prefs[which];
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = which === "map" ? start + dx : start - dx;
      setPrefs((p) => ({ ...p, [which]: Math.max(200, Math.min(720, next)) }));
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); setPrefs((p) => { save(p); return p; }); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const primaryNode = primary ? findMapNode(root, primary) : null;

  return (
    <div className="ar" data-testid="architect-view" style={{ gridTemplateColumns: `${prefs.map}px 6px minmax(0, 1fr) 6px ${prefs.inspector}px` }}>
      <aside className="ar-map">
        <div className="ar-pane-head">
          <span className="ar-pane-title">Survey map</span>
          <span className="ar-pane-meta">{s.def.questions.length} questions</span>
        </div>
        <SurveyMap
          rows={rows} selectedKeys={selectedKeys} primary={primary} focusSet={focusSet}
          onSelect={select} onToggle={toggle} onOpen={(k) => select(k)}
          search={search} onSearch={setSearch}
          onCollapseAll={() => setCollapsed(new Set(containerKeys(root)))}
          onExpandAll={() => setCollapsed(new Set())}
        />
      </aside>
      <div className="ar-divider" onPointerDown={startDrag("map")} role="separator" aria-orientation="vertical" data-testid="ar-divider-map" />
      <main className="ar-work">
        <div className="ar-pane-head">
          <span className="ar-pane-title">Workspace</span>
          {primaryNode && <span className="ar-crumb mono">{primaryNode.code ?? primaryNode.label}</span>}
          <span className="grow" />
          <button
            className={`ar-focus${focus ? " on" : ""}`}
            data-testid="focus-toggle"
            aria-pressed={focus}
            title="Focus mode — dim everything outside this object's dependencies (⌘⇧F)"
            onClick={() => mode?.setFocus(!focus)}
          >
            <Icon name="sparkle" size={13} /> Focus
          </button>
        </div>
        {focus && (
          <div className="ar-focus-bar" data-testid="focus-bar">
            <span className="ar-focus-kw">FOCUSING ON</span>
            {primaryNode
              ? <><span className="mono">{primaryNode.code ?? primaryNode.label}</span><span className="muted"> · {focusSet ? focusSet.size - 1 : 0} related objects, everything else dimmed</span></>
              : <span className="muted">select something to focus on</span>}
          </div>
        )}
        <div className="ar-work-body">
          <Workspace primary={primary} status={status} onSelect={(k) => select(k)} />
        </div>
      </main>
      <div className="ar-divider" onPointerDown={startDrag("inspector")} role="separator" aria-orientation="vertical" data-testid="ar-divider-inspector" />
      <aside className="ar-inspector">
        <div className="ar-pane-head"><span className="ar-pane-title">Inspector</span></div>
        <div className="ar-inspector-body">
          <Inspector primary={primary} index={index} status={status} onSelect={(k) => select(k)} />
        </div>
      </aside>
    </div>
  );
}
