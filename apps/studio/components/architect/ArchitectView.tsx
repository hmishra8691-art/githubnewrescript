"use client";
import React from "react";
import { buildDependencyIndex, objectStatus, parseObjectKey, referencesTo, removeQuestion, removeFlowNode, findNode, boundaryAfter, type ObjectKey, type QuestionReference } from "@rescript/engine";
import type { FlowNode } from "@rescript/schema";
import { useStudio } from "../studio/store";
import { useCommands } from "../studio/CommandContext";
import { DeleteQuestionDialog } from "../studio/DeleteQuestionDialog";
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
  // a new selection shows its workspace from the top: the scroll position of the previous object's
  // editor must not carry over (a question picked from the bottom of the outline opened half-scrolled)
  const workRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { workRef.current?.scrollTo({ top: 0 }); }, [primary]);

  /* ------------------------------------------------------------ structural editing (round 2, §2–3) */
  const cmd = useCommands();
  const [addOpen, setAddOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<{ id: string; code: string; refs: QuestionReference[] } | null>(null);
  const primaryKind = primary ? parseObjectKey(primary).kind : null;
  const primaryId = primary ? parseObjectKey(primary).id : null;
  const primaryFlowNode = primaryKind === "flowNode" && primaryId ? findNode(s.def.flow as FlowNode[], primaryId) : null;
  const deletableNode = primaryFlowNode && primaryFlowNode.type !== "end";
  const run = (id: string) => { setAddOpen(false); cmd?.run(id); };
  const askDelete = () => {
    if (s.readOnly || !primaryId) return;
    if (primaryKind === "question") {
      const q = s.def.questions.find((x) => x.id === primaryId);
      if (q) setPendingDelete({ id: q.id, code: q.code, refs: referencesTo(s.def, q.id) });
    } else if (deletableNode && primaryFlowNode) {
      const label = primaryNode?.label ?? primaryFlowNode.type;
      const inside = "children" in primaryFlowNode ? (primaryFlowNode as { children: unknown[] }).children.length : primaryFlowNode.type === "page" ? primaryFlowNode.questionIds.length : 0;
      if (!window.confirm(`Remove ${primaryFlowNode.type.replace(/_/g, " ")} “${label}”${inside ? ` and everything inside it (${inside} item${inside === 1 ? "" : "s"})` : ""}? Questions inside a removed page stay in the survey, unplaced.`)) return;
      s.labelNextEdit(`remove ${primaryFlowNode.type}`);
      s.update((d) => { const r = removeFlowNode(d.flow as FlowNode[], primaryId); d.flow = r.flow as never; });
      sel?.dispatch({ type: "clear" });
    }
  };
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { id, code } = pendingDelete;
    setPendingDelete(null);
    s.labelNextEdit(`delete ${code}`);
    s.update((d) => { removeQuestion(d, id); });
    sel?.dispatch({ type: "drop", keys: [`question:${id}` as ObjectKey] });
  };
  /* WHERE a new thing goes, in words — the same rule the commands apply (`insertionPoint`, `elementInsertionIndex`) */
  const canBreak = primaryKind === "question" && primaryId ? boundaryAfter(s.def, primaryId) : null;
  const where = React.useMemo(() => {
    const code = primaryNode?.code ?? primaryNode?.label ?? null;
    if (primaryKind === "question") return { summary: `after ${code}, in its block`, question: `after ${code}`, block: `after ${code}'s block`, element: `after ${code}'s block` };
    if (primaryKind === "flowNode") return { summary: `inside / after ${code ?? "the selected element"}`, question: `at the end of ${code ?? "the selected element"}`, block: `after ${code ?? "the selected element"}`, element: `after ${code ?? "the selected element"}` };
    return { summary: "at the end of the survey (nothing is selected)", question: "on the last page", block: "before the End", element: "before the End" };
  }, [primaryKind, primaryNode]);

  React.useEffect(() => {
    if (!addOpen) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.(".ar-add")) setAddOpen(false); };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [addOpen]);

  return (
    <>
    {pendingDelete && <DeleteQuestionDialog code={pendingDelete.code} refs={pendingDelete.refs} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />}
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
          {/* STRUCTURE IS EDITED HERE: add a question where the selection is, a block, a flow element; duplicate, move, remove the selection — every one an engine operation through the command registry, the same the Questions panel calls */}
          <div className="ar-tools" data-testid="ar-tools">
            <button className="ar-tool primary" data-testid="ar-add-question" disabled={s.readOnly} onClick={() => run("question.add")} title={`Add a question ${where.question}`}>
              <Icon name="plus" size={12} /> Question
            </button>
            <button className="ar-tool" data-testid="ar-add-block" disabled={s.readOnly} onClick={() => run("block.add")} title={`Add a block ${where.block}`}><Icon name="plus" size={12} /> Block</button>
            <div className="ar-add">
              <button className="ar-tool" data-testid="ar-add-element" disabled={s.readOnly} aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)} title="Add a page break, a flow element or a data object"><Icon name="plus" size={12} /> Add… <Icon name="chevron-down" size={11} /></button>
              {addOpen && (
                /*
                 * THE ADD MENU IS STRUCTURED (UI upgrade §6): what you are adding, where it goes,
                 * and what it does — STRUCTURE (the respondent's pages), FLOW (changes the path),
                 * DATA (changes what is recorded, not where the respondent goes).
                 */
                <div className="ar-add-menu" role="menu" data-testid="ar-add-menu">
                  <div className="ar-add-where" data-testid="ar-add-where"><span className="ar-add-kw">WHERE</span> {where.summary}</div>
                  <div className="ar-add-sec">Structure <span className="ar-add-sub">what the respondent sees, page by page</span></div>
                  <AddItem id="question.add" label="Question" hint={`a question ${where.question}`} run={run} testId="ar-add-question-item" />
                  <AddItem id="page.breakAfter" label="Page break" hint={canBreak === "none" ? `after ${primaryNode?.code ?? "the selected question"} — its page is split there` : canBreak === "page" ? "there is already a page break after the selected question" : "select a question in the middle of a page"} run={run} disabled={canBreak !== "none"} testId="ar-add-page_break" />
                  <AddItem id="block.add" label="Block" hint={`a new block (one page) ${where.block}`} run={run} testId="ar-add-block-item" />
                  <div className="ar-add-sec">Flow <span className="ar-add-sub">changes the path the respondent takes</span></div>
                  {[["flow.add.branch", "Branch / condition", "send respondents down different paths"], ["flow.add.randomizer", "Randomizer", "shuffle what comes next, or show N of M"], ["flow.add.loop", "Loop", "repeat what is inside, once per item"], ["flow.add.quota_check", "Quota check", "stop or redirect when a quota is full"]].map(([id, label, hint]) => (
                    <AddItem key={id} id={id} label={label} hint={`${hint} — ${where.element}`} run={run} />
                  ))}
                  <div className="ar-add-sec">Data <span className="ar-add-sub">changes what is recorded, not where the respondent goes</span></div>
                  <AddItem id="flow.add.embedded_data" label="Embedded data" hint={`capture URL, panel or computed values — ${where.element}`} run={run} />
                  <AddItem id="question.addHidden" label="Hidden variable" hint={`an invisible variable set by URL, scripts or piping — ${where.question}`} run={run} testId="ar-add-hidden" />
                  <AddItem id="question.addCalculated" label="Calculated value" hint={`a derived variable from an expression — ${where.question}`} run={run} testId="ar-add-calculated" />
                </div>
              )}
            </div>
            <span className="ar-tools-sep" />
            <button className="ar-tool" data-testid="ar-duplicate" disabled={s.readOnly || primaryKind !== "question"} onClick={() => run("question.duplicate")} title="Duplicate (⌘⇧D)"><Icon name="layers" size={12} /></button>
            <button className="ar-tool" data-testid="ar-move-up" disabled={s.readOnly || primaryKind !== "question"} onClick={() => run("question.moveUp")} title="Move up (⌥↑)">↑</button>
            <button className="ar-tool" data-testid="ar-move-down" disabled={s.readOnly || primaryKind !== "question"} onClick={() => run("question.moveDown")} title="Move down (⌥↓)">↓</button>
            <button className="ar-tool danger" data-testid="ar-delete" disabled={s.readOnly || !(primaryKind === "question" || deletableNode)} onClick={askDelete} title={primaryKind === "question" ? "Delete this question" : deletableNode ? "Remove this element" : "Select a question or element to remove"}><Icon name="close" size={12} /></button>
          </div>
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
        <div className="ar-work-body" ref={workRef}>
          <Workspace primary={primary} status={status} index={index} focusSet={focusSet} onSelect={(k) => select(k)} />
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
    </>
  );
}

/** one row of the Add menu: what, and where it goes */
function AddItem({ id, label, hint, run, disabled, testId }: { id: string; label: string; hint: string; run(id: string): void; disabled?: boolean; testId?: string }) {
  return (
    <button role="menuitem" className="ar-add-item" data-testid={testId ?? `ar-add-${id.split(".").pop()}`} disabled={disabled} onClick={() => run(id)} title={hint}>
      <span className="ar-add-label">{label}</span>
      <span className="ar-add-hint">{hint}</span>
    </button>
  );
}
