"use client";
import React from "react";
import type { Option, Question, QuestionRow } from "@rescript/schema";
import { flattenVariables, type LoopContext } from "@rescript/engine";
import { useStudio } from "../studio/store";
import { Icon } from "../ui/Icon";
import { LiveCanvas, type CanvasDevice, type CanvasMode } from "./LiveCanvas";
import { ElementPanel } from "./ElementPanel";
import { sampleTargets, type AuthoringAnnotations } from "./authoringView";
import { selectionExists, type SelectedEntity } from "./selection";

/**
 * THE CANVAS TAB — a visual survey-programming IDE for one question.
 *
 * Left: the questions in the survey, so moving between them never leaves this
 * surface. Middle: the question rendered by the respondent's own renderer,
 * clickable element by element. Right: the configuration for whatever is
 * selected. Editing anywhere goes through the same store, so the canvas, this
 * panel, the Questions tab, the JSON and the autosave are all the one
 * definition — there is no second copy of a question anywhere in the Studio.
 *
 * The existing Questions tab is untouched and remains the place for bulk
 * editing, blocks and pages; this is the place for programming a question
 * while looking at it.
 */

export function CanvasPanel() {
  const s = useStudio();
  const [mode, setMode] = React.useState<CanvasMode>("author");
  const [device, setDevice] = React.useState<CanvasDevice>("desktop");
  const [sel, setSel] = React.useState<SelectedEntity | null>(null);
  const [sample, setSample] = React.useState<Record<string, unknown>>({});
  const [seed, setSeed] = React.useState(12345);
  const [showHidden, setShowHidden] = React.useState(true);
  const [showIndicators, setShowIndicators] = React.useState(true);
  const [ann, setAnn] = React.useState<AuthoringAnnotations | null>(null);
  const [loopIndex, setLoopIndex] = React.useState(0);
  const [filter, setFilter] = React.useState("");

  const questions = s.def.questions;
  const current = questions.find((q) => q.id === s.selectedQuestionId) ?? questions[0];

  /* Selection follows the question, and never outlives the thing it names. */
  React.useEffect(() => {
    if (!current) { setSel(null); return; }
    setSel((prev) => {
      if (prev && prev.questionId === current.id && selectionExists(prev, s.def)) return prev;
      return { type: "question", questionId: current.id };
    });
  }, [current?.id, s.def]); // eslint-disable-line react-hooks/exhaustive-deps

  const loop = useLoopContext(current, loopIndex);
  const deps = React.useMemo(() => (current ? sampleTargets(s.def, current) : []), [s.def, current]);

  const shown = React.useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return questions;
    return questions.filter((q) =>
      q.code.toLowerCase().includes(f) ||
      q.variableName.toLowerCase().includes(f) ||
      q.text.replace(/<[^>]*>/g, "").toLowerCase().includes(f));
  }, [questions, filter]);

  if (!current) {
    return (
      <div className="empty" data-testid="canvas-empty">
        <div className="empty-icon"><Icon name="questions" size={22} /></div>
        <h3>No questions yet</h3>
        <p className="muted">Add a question on the Questions tab and it will appear here, live, as you program it.</p>
        <button className="btn primary" onClick={() => s.goToTab?.("questions")}>Go to Questions</button>
      </div>
    );
  }

  return (
    <div className="lc-wrap" data-testid="canvas-panel">
      {/* ---------------------------------------------------- question list */}
      <aside className="lc-list" aria-label="Questions">
        <input className="input small" placeholder="Filter…" value={filter} data-testid="canvas-filter"
          onChange={(e) => setFilter(e.target.value)} />
        <div className="lc-list-scroll">
          {shown.map((q) => (
            <button key={q.id}
              className={`lc-qitem ${q.id === current.id ? "on" : ""}`}
              data-testid="canvas-qitem" data-qid={q.id}
              onClick={() => s.select(q.id)}>
              <span className="mono lc-qcode">{q.code}</span>
              <span className="lc-qtext" dangerouslySetInnerHTML={{ __html: q.text || "<em>untitled</em>" }} />
            </button>
          ))}
          {shown.length === 0 && <p className="muted" style={{ padding: "8px 6px" }}>Nothing matches.</p>}
        </div>
      </aside>

      {/* --------------------------------------------------------- the canvas */}
      <div className="lc-main">
        <div className="lc-toolbar" data-testid="canvas-toolbar">
          <div className="lc-seg" role="group" aria-label="Canvas mode">
            <button className={mode === "author" ? "on" : ""} data-testid="mode-author"
              onClick={() => setMode("author")} title="Program the question — every element selectable">
              <Icon name="questions" size={14} /> Authoring
            </button>
            <button className={mode === "simulate" ? "on" : ""} data-testid="mode-simulate"
              onClick={() => setMode("simulate")} title="Answer it as a respondent would, with the real engine">
              <Icon name="play" size={14} /> Simulate
            </button>
          </div>

          <div className="lc-seg" role="group" aria-label="Preview width">
            {(["desktop", "tablet", "mobile"] as CanvasDevice[]).map((d) => (
              <button key={d} className={device === d ? "on" : ""} data-testid={`canvas-${d}`}
                onClick={() => setDevice(d)} aria-label={`${d} width`}>{d}</button>
            ))}
          </div>

          <span className="grow" />

          {mode === "author" && (
            <>
              <label className="lc-check" title="Draw the options, rows and columns today's logic would hide">
                <input type="checkbox" checked={showHidden} data-testid="toggle-hidden"
                  onChange={(e) => setShowHidden(e.target.checked)} /> Hidden
              </label>
              <label className="lc-check" title="Mark elements that carry programming">
                <input type="checkbox" checked={showIndicators} data-testid="toggle-flags"
                  onChange={(e) => setShowIndicators(e.target.checked)} /> Programming
              </label>
            </>
          )}
          {mode === "simulate" && (
            <button className="btn small" data-testid="reroll" onClick={() => setSeed((n) => n + 1)}
              title="New respondent — re-rolls randomization">
              <Icon name="sparkle" size={14} /> Re-roll
            </button>
          )}
          <SaveChip />
        </div>

        <div className="lc-scroll">
          <LiveCanvas
            q={current} def={s.def} mode={mode} device={device}
            sample={sample} loop={loop} seed={seed}
            selected={sel} onSelect={setSel}
            showHidden={showHidden} showIndicators={showIndicators}
            onAnnotations={setAnn}
          />

          {mode === "author" && <StructureTools q={current} sel={sel} onSelect={setSel} />}

          <Simulator
            q={current} deps={deps} sample={sample} setSample={setSample}
            loopIndex={loopIndex} setLoopIndex={setLoopIndex} loop={loop} mode={mode}
          />
        </div>
      </div>

      {/* ------------------------------------------------- contextual panel */}
      <aside className="lc-side" aria-label="Element properties">
        {sel
          ? <ElementPanel q={current} sel={sel} ann={ann} onSelect={setSel} />
          : <p className="muted">Click any part of the question to program it.</p>}
      </aside>
    </div>
  );
}

/** The existing save state, shown where the editing happens. */
function SaveChip() {
  const s = useStudio();
  const k = s.saveState.kind;
  const label = k === "saving" ? "Saving…" : k === "saved" ? "Saved" : k === "dirty" ? "Unsaved" : k === "clean" ? "Saved" : k;
  return <span className={`lc-save ${k}`} data-testid="canvas-save-state">{k === "saved" || k === "clean" ? "✓ " : ""}{label}</span>;
}

/* ------------------------------------------------------------ structure ops */

/**
 * Adding and reordering from the canvas.
 *
 * The renderer draws what the definition says; it has no idea an option can be
 * added. So the structural affordances live directly beneath the render, in the
 * programmed order, with drag handles — and every one of them is an ordinary
 * store mutation, so undo and autosave behave exactly as they do elsewhere.
 */
function StructureTools({ q, sel, onSelect }: {
  q: Question; sel: SelectedEntity | null; onSelect(s: SelectedEntity | null): void;
}) {
  const s = useStudio();
  const [drag, setDrag] = React.useState<{ kind: "option" | "row"; index: number } | null>(null);

  const hasOptions = q.options.length > 0 || ["single_select", "multi_select", "dropdown", "multi_dropdown", "image_select", "ranking", "allocation"].includes(q.type);
  const hasRows = q.rows.length > 0 || q.type.startsWith("matrix") || ["numeric_list", "text_list", "composite", "custom_table"].includes(q.type);
  if (!hasOptions && !hasRows) return null;

  const nextCode = (xs: { code: string | number }[]) => {
    const nums = xs.map((x) => Number(x.code)).filter((n) => Number.isFinite(n));
    return nums.length ? String(Math.max(...nums) + 1) : String(xs.length + 1);
  };

  const addOption = () => {
    const code = nextCode(q.options);
    s.labelNextEdit("add option");
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (t) t.options.push({ code, label: `Option ${code}`, flags: [] } as Option);
    });
    onSelect({ type: "option", questionId: q.id, optionCode: code });
  };

  const addRow = () => {
    const code = nextCode(q.rows);
    s.labelNextEdit("add row");
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (t) t.rows.push({ code, label: `Row ${code}`, flags: [], validation: [], required: false } as QuestionRow);
    });
    onSelect({ type: "row", questionId: q.id, rowCode: code });
  };

  const move = (kind: "option" | "row", from: number, to: number) => {
    if (from === to || to < 0) return;
    s.labelNextEdit(`reorder ${kind}s`);
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (!t) return;
      const arr = kind === "option" ? t.options : t.rows;
      if (to >= arr.length) return;
      const [x] = arr.splice(from, 1);
      arr.splice(to, 0, x);
    });
  };

  const remove = (kind: "option" | "row", index: number) => {
    s.labelNextEdit(`delete ${kind}`);
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (!t) return;
      (kind === "option" ? t.options : t.rows).splice(index, 1);
    });
    onSelect({ type: "question", questionId: q.id });
  };

  const duplicate = (kind: "option" | "row", index: number) => {
    s.labelNextEdit(`duplicate ${kind}`);
    s.update((d) => {
      const t = d.questions.find((x) => x.id === q.id);
      if (!t) return;
      const arr = kind === "option" ? t.options : t.rows;
      const src = arr[index];
      arr.splice(index + 1, 0, { ...structuredClone(src), code: nextCode(arr) } as never);
    });
  };

  const list = (kind: "option" | "row", items: { code: string | number; label: string }[]) => (
    <div className="lc-struct" data-testid={`struct-${kind}s`}>
      <div className="lc-struct-head">
        <span className="eyebrow">{kind === "option" ? "Options" : "Rows"} · programmed order</span>
        <span className="grow" />
        <button className="btn small" data-testid={`add-${kind}`} onClick={kind === "option" ? addOption : addRow}>
          <Icon name="plus" size={13} /> Add {kind}
        </button>
      </div>
      {items.map((it, i) => {
        const code = String(it.code);
        const active = sel != null && sel.type === kind &&
          (sel.type === "option" ? sel.optionCode : sel.type === "row" ? sel.rowCode : "") === code;
        return (
          <div key={code}
            className={`lc-struct-row ${active ? "on" : ""} ${drag?.kind === kind && drag.index === i ? "dragging" : ""}`}
            data-testid={`struct-${kind}`} data-code={code}
            draggable
            onDragStart={() => setDrag({ kind, index: i })}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (drag?.kind === kind) move(kind, drag.index, i); setDrag(null); }}
            onDragEnd={() => setDrag(null)}
            onClick={() => onSelect(kind === "option"
              ? { type: "option", questionId: q.id, optionCode: code }
              : { type: "row", questionId: q.id, rowCode: code })}>
            <span className="lc-grip" aria-hidden>⠿</span>
            <span className="mono lc-struct-code">{code}</span>
            <input className="lc-struct-label" data-lc-edit data-testid={`struct-${kind}-label`}
              value={it.label}
              aria-label={`${kind} ${code} label`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const v = e.target.value;
                s.update((d) => {
                  const t = d.questions.find((x) => x.id === q.id);
                  if (!t) return;
                  const target = (kind === "option" ? t.options : t.rows).find((o) => String(o.code) === code);
                  if (target) target.label = v;
                });
              }} />
            <span className="lc-struct-acts" onClick={(e) => e.stopPropagation()}>
              <button className="btn small ghost" title="Move up" onClick={() => move(kind, i, i - 1)}>↑</button>
              <button className="btn small ghost" title="Move down" onClick={() => move(kind, i, i + 1)}>↓</button>
              <button className="btn small ghost" title="Duplicate" onClick={() => duplicate(kind, i)}>⧉</button>
              <button className="btn small ghost danger" title="Delete" data-testid={`del-${kind}`}
                onClick={() => remove(kind, i)}>×</button>
            </span>
          </div>
        );
      })}
      {items.length === 0 && <p className="muted" style={{ fontSize: 13, margin: "6px 2px" }}>None yet.</p>}
    </div>
  );

  return (
    <div className="lc-structs">
      {hasOptions && list("option", q.options)}
      {hasRows && list("row", q.rows)}
    </div>
  );
}

/* --------------------------------------------------------------- simulator */

/**
 * Sample answers, fed to the real engine.
 *
 * Everything the question depends on — display logic, masking, carry forward,
 * list logic, piping — reads from the response state these values build, so
 * typing an answer here reproduces exactly what that answer would do to this
 * question in a live interview. There is no separate preview evaluation.
 */
function Simulator({ q, deps, sample, setSample, loopIndex, setLoopIndex, loop, mode }: {
  q: Question;
  deps: Question[];
  sample: Record<string, unknown>;
  setSample(v: Record<string, unknown>): void;
  loopIndex: number;
  setLoopIndex(n: number): void;
  loop: LoopContext | null;
  mode: CanvasMode;
}) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const loops = React.useMemo(() => loopSourcesFor(s.def, q), [s.def, q]);
  const relevant = deps.length > 0 || loops.length > 0;
  if (!relevant) return null;

  return (
    <details className="lc-sim" open={open || mode === "simulate"} data-testid="canvas-simulator"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="flask" size={14} /> Sample answers
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          {deps.length > 0 && `${deps.length} question${deps.length === 1 ? "" : "s"} this one depends on`}
          {deps.length > 0 && loops.length > 0 && " · "}
          {loops.length > 0 && "loop iteration"}
        </span>
      </summary>

      {loops.length > 0 && (
        <div className="lc-sim-row">
          <label className="f grow"><span>Loop iteration</span>
            <select className="select small" data-testid="loop-iteration" value={loopIndex}
              onChange={(e) => setLoopIndex(Number(e.target.value))}>
              {loops[0].items.map((it, i) => (
                <option key={String(it.code)} value={i}>{i + 1}. {it.label.replace(/<[^>]*>/g, "")}</option>
              ))}
            </select></label>
          {loop && <span className="badge neutral" data-testid="loop-chip">{loop.loopVar} = {loop.label}</span>}
        </div>
      )}

      {deps.map((d) => (
        <div className="lc-sim-row" key={d.id}>
          <label className="f grow">
            <span>{d.code} · {d.text.replace(/<[^>]*>/g, "").slice(0, 60)}</span>
            {d.options.length > 0 ? (
              <select className="select small" data-testid={`sample-${d.code}`}
                value={String(sample[d.id] ?? "")}
                onChange={(e) => setSample({ ...sample, [d.id]: e.target.value || undefined })}>
                <option value="">— no answer —</option>
                {d.options.map((o) => (
                  <option key={String(o.code)} value={String(o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>
                ))}
              </select>
            ) : (
              <input className="input small" data-testid={`sample-${d.code}`}
                value={String(sample[d.id] ?? "")}
                onChange={(e) => setSample({ ...sample, [d.id]: e.target.value || undefined })} />
            )}
          </label>
        </div>
      ))}

      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <button className="btn small" data-testid="clear-sample" onClick={() => setSample({})}>Clear</button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Sample values never reach a respondent or the data — they only drive this preview.
        </span>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------- loop context */

interface LoopSource { loopVar: string; items: { code: string | number; label: string }[] }

/** Loops whose scope contains this question, with the items they iterate. */
function loopSourcesFor(def: import("@rescript/schema").SurveyDefinition, q: Question): LoopSource[] {
  const out: LoopSource[] = [];
  const walk = (nodes: unknown[]) => {
    for (const raw of nodes) {
      const n = raw as Record<string, any>;
      if (!n || typeof n !== "object") continue;
      if (n.type === "loop") {
        const inside = JSON.stringify(n).includes(`"${q.id}"`);
        if (inside) {
          const src = def.questions.find((x) => x.id === n.source?.questionId);
          const items = (src?.options ?? []).map((o) => ({ code: o.code, label: o.label }));
          out.push({ loopVar: n.loopVar ?? n.variable ?? "loop", items: items.length ? items : [{ code: "1", label: "Item 1" }] });
        }
      }
      for (const k of ["children", "nodes", "body", "branches"]) if (Array.isArray(n[k])) walk(n[k]);
    }
  };
  walk((def.flow ?? []) as unknown[]);
  return out;
}

function useLoopContext(q: Question | undefined, index: number): LoopContext | null {
  const s = useStudio();
  return React.useMemo(() => {
    if (!q) return null;
    const srcs = loopSourcesFor(s.def, q);
    if (!srcs.length) return null;
    const src = srcs[0];
    const item = src.items[Math.min(index, src.items.length - 1)] ?? src.items[0];
    if (!item) return null;
    return {
      loopVar: src.loopVar,
      code: item.code,
      label: item.label.replace(/<[^>]*>/g, ""),
      index: Math.min(index, src.items.length - 1),
      count: src.items.length,
    } as LoopContext;
  }, [s.def, q, index]);
}

/** Exported for the variables lint — keeps the import honest. */
export const __canvasUsesFlatten = flattenVariables;
