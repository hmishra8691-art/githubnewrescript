"use client";
import React from "react";
import type { Option, Question, QuestionRow } from "@rescript/schema";
import { stripHtmlText } from "@rescript/engine";
import { useStudio } from "../studio/store";
import { Icon } from "../ui/Icon";
import { OptionPreview } from "../studio/OptionPreview";
import { LiveCanvas, type CanvasDevice, type CanvasMode } from "./LiveCanvas";
import { useCanvas } from "./CanvasContext";
import { sampleTargets } from "./authoringView";
import { loopsFor, contextFor } from "./loopPreview";
import type { SelectedEntity } from "./selection";

/**
 * THE LIVE VIEW — the second half of the question editor, not a second place.
 *
 * This renders inside the Questions screen, in the same card the Standard
 * editor uses, for the question the programmer already has open. Switching
 * between them changes what is drawn in that card and nothing else: no
 * navigation, no reload, no second copy of the question. Both views mutate the
 * one definition through the one store, so an edit made in either is simply
 * the question changing, and the other view is already showing it.
 *
 * The rendered question comes from @rescript/renderer — the respondent's own
 * renderer — so what is on screen here is what will be on screen for them.
 */

export function LiveView({ q }: { q: Question }) {
  const s = useStudio();
  const canvas = useCanvas();
  const [device, setDevice] = React.useState<CanvasDevice>("desktop");
  const [mode, setMode] = React.useState<CanvasMode>("author");
  const [sample, setSample] = React.useState<Record<string, unknown>>({});
  const [seed, setSeed] = React.useState(12345);
  const [showHidden, setShowHidden] = React.useState(true);
  const [showIndicators, setShowIndicators] = React.useState(true);
  const [debug, setDebug] = React.useState(false);

  const [loopIndex, setLoopIndex] = React.useState(0);
  const [refOverrides, setRefOverrides] = React.useState<Record<string, string>>({});

  const sel = canvas?.selected ?? null;
  const select = canvas?.select ?? (() => {});
  const ann = canvas?.annotations ?? null;
  const setAnn = canvas?.setAnnotations ?? (() => {});

  const loops = React.useMemo(() => loopsFor(s.def, q), [s.def, q]);
  const loop = React.useMemo(
    () => (loops.length ? contextFor(loops[loops.length - 1], loopIndex, refOverrides) : null),
    [loops, loopIndex, refOverrides],
  );
  const deps = React.useMemo(() => sampleTargets(s.def, q), [s.def, q]);

  /* The question is selected as soon as the live view opens, so the property
     panel has something to talk about before the programmer clicks anything. */
  React.useEffect(() => {
    if (!sel || sel.questionId !== q.id) select({ type: "question", questionId: q.id });
  }, [q.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="lv" data-testid="live-view">
      <div className="lv-bar" data-testid="live-toolbar">
        <div className="lc-seg" role="group" aria-label="Live mode">
          <button className={mode === "author" ? "on" : ""} data-testid="live-author"
            onClick={() => setMode("author")} title="Program the question — every element is selectable">
            <Icon name="questions" size={14} /> Authoring
          </button>
          <button className={mode === "simulate" ? "on" : ""} data-testid="live-simulate"
            onClick={() => setMode("simulate")} title="Answer it as a respondent would, with the real engine">
            <Icon name="play" size={14} /> Simulation
          </button>
        </div>

        <div className="lc-seg" role="group" aria-label="Preview width">
          {(["desktop", "tablet", "mobile"] as CanvasDevice[]).map((d) => (
            <button key={d} className={device === d ? "on" : ""} data-testid={`live-${d}`}
              onClick={() => setDevice(d)} aria-label={`${d} width`}>{d}</button>
          ))}
          <button className={debug ? "on" : ""} data-testid="live-debug"
            onClick={() => setDebug((v) => !v)} title="Show how the engine builds this question's list">
            debug
          </button>
        </div>

        <span className="grow" />

        {mode === "author" ? (
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
        ) : (
          <button className="btn small" data-testid="reroll" onClick={() => setSeed((n) => n + 1)}
            title="A new respondent — re-rolls randomization">
            <Icon name="sparkle" size={14} /> Re-roll
          </button>
        )}
      </div>

      <LiveCanvas
        q={q} def={s.def} mode={mode} device={device}
        sample={sample} loop={loop} seed={seed}
        selected={sel} onSelect={select}
        showHidden={showHidden} showIndicators={showIndicators}
        onAnnotations={setAnn}
      />

      {mode === "author" && <StructureTools q={q} sel={sel} onSelect={select} />}

      {(deps.length > 0 || loops.length > 0) && (
        <Simulator
          q={q} deps={deps} sample={sample} setSample={setSample}
          loops={loops} loopIndex={loopIndex} setLoopIndex={setLoopIndex}
          refOverrides={refOverrides} setRefOverrides={setRefOverrides}
          loop={loop}
        />
      )}

      {debug && (
        <div className="lv-debug" data-testid="live-debug-panel">
          <div className="eyebrow">Debug — how the engine builds this list</div>
          <OptionPreview q={q} />
          {ann && (
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              For these sample answers the engine hides{" "}
              {ann.hiddenOptions.size} option{ann.hiddenOptions.size === 1 ? "" : "s"},{" "}
              {ann.hiddenRows.size} row{ann.hiddenRows.size === 1 ? "" : "s"} and{" "}
              {ann.hiddenColumns.size} column{ann.hiddenColumns.size === 1 ? "" : "s"}
              {ann.randomized ? "; the order is randomized per respondent." : "."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ structure ops */

/** what a reorder drag carries: which list, and which position in it */
const DRAG_MIME = "application/x-rescript-struct";

function dragged(e: React.DragEvent, kind: "option" | "row"): number | null {
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw) return null;
  const [k, i] = raw.split(":");
  const n = Number(i);
  return k === kind && Number.isFinite(n) ? n : null;
}

/**
 * Adding and reordering from the live view.
 *
 * The renderer draws what the definition says; it has no idea an option can be
 * added. So the structural affordances sit directly beneath the render, in the
 * programmed order, with drag handles — and every one is an ordinary store
 * mutation, so undo and autosave behave exactly as they do in Standard mode.
 */
function StructureTools({ q, sel, onSelect }: {
  q: Question; sel: SelectedEntity | null; onSelect(s: SelectedEntity | null): void;
}) {
  const s = useStudio();
  const [drag, setDrag] = React.useState<{ kind: "option" | "row"; index: number } | null>(null);

  const hasOptions = q.options.length > 0 ||
    ["single_select", "multi_select", "dropdown", "multi_dropdown", "image_select", "image_ranking", "ranking", "allocation"].includes(q.type);
  const hasRows = q.rows.length > 0 || q.type.startsWith("matrix") ||
    ["numeric_list", "text_list", "composite", "custom_table", "repeating_group"].includes(q.type);
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
      arr.splice(index + 1, 0, { ...structuredClone(arr[index]), code: nextCode(arr) } as never);
    });
  };

  const list = (kind: "option" | "row", items: { code: string | number; label: string }[]) => (
    <div className="lc-struct" data-testid={`live-struct-${kind}s`}>
      <div className="lc-struct-head">
        <span className="eyebrow">{kind === "option" ? "Options" : "Rows"} · programmed order</span>
        <span className="grow" />
        <button className="btn small" data-testid={`live-add-${kind}`} onClick={kind === "option" ? addOption : addRow}>
          <Icon name="plus" size={13} /> Add {kind}
        </button>
      </div>
      {items.map((it, i) => {
        const code = String(it.code);
        const active = sel != null &&
          ((sel.type === "option" && kind === "option" && sel.optionCode === code) ||
           (sel.type === "row" && kind === "row" && sel.rowCode === code));
        return (
          <div key={code}
            className={`lc-struct-row ${active ? "on" : ""} ${drag?.kind === kind && drag.index === i ? "dragging" : ""}`}
            data-testid={`live-struct-${kind}`} data-code={code}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragged(e, kind) ?? (drag?.kind === kind ? drag.index : null);
              if (from != null) move(kind, from, i);
              setDrag(null);
            }}
            onClick={() => onSelect(kind === "option"
              ? { type: "option", questionId: q.id, optionCode: code }
              : { type: "row", questionId: q.id, rowCode: code })}>
            {/* the handle owns the drag, not the row: the row is mostly a text
                input, and a drag begun there is a text selection instead */}
            <span className="lc-grip" role="button" tabIndex={-1}
              aria-label={`Reorder ${kind} ${code}`} data-testid={`live-grip-${kind}`}
              draggable
              onDragStart={(e) => {
                setDrag({ kind, index: i });
                e.dataTransfer.effectAllowed = "move";
                // the index travels with the drag itself, so a re-render
                // between grab and drop cannot lose it
                e.dataTransfer.setData(DRAG_MIME, `${kind}:${i}`);
                e.dataTransfer.setData("text/plain", code);
              }}
              onDragEnd={() => setDrag(null)}
              onClick={(e) => e.stopPropagation()}>⠿</span>
            <span className="mono lc-struct-code">{code}</span>
            <input className="lc-struct-label" data-lc-edit data-testid={`live-struct-${kind}-label`}
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
              <button className="btn small ghost danger" title="Delete" data-testid={`live-del-${kind}`}
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
 * Sample answers and loop context, fed to the real engine.
 *
 * Everything this question depends on — display logic, masking, carry forward,
 * list logic, piping — reads from the response state these values build, so
 * typing an answer here does to the question exactly what that answer would do
 * mid-interview. Nothing is evaluated twice or differently.
 */
function Simulator({ q, deps, sample, setSample, loops, loopIndex, setLoopIndex, refOverrides, setRefOverrides, loop }: {
  q: Question;
  deps: Question[];
  sample: Record<string, unknown>;
  setSample(v: Record<string, unknown>): void;
  loops: ReturnType<typeof loopsFor>;
  loopIndex: number;
  setLoopIndex(n: number): void;
  refOverrides: Record<string, string>;
  setRefOverrides(v: Record<string, string>): void;
  loop: ReturnType<typeof contextFor>;
}) {
  const active = loops[loops.length - 1];
  const item = active?.items[Math.min(loopIndex, active.items.length - 1)];

  return (
    <details className="lc-sim" data-testid="live-simulator" open>
      <summary>
        <Icon name="flask" size={14} /> Preview context
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
          {deps.length > 0 && `${deps.length} question${deps.length === 1 ? "" : "s"} this one reads`}
          {deps.length > 0 && active && " · "}
          {active && `loop ${active.loopVar}`}
        </span>
      </summary>

      {active && (
        <>
          <div className="lc-sim-row">
            <label className="f grow"><span>Loop iteration — from {active.sourceNote}</span>
              <select className="select small" data-testid="loop-iteration" value={loopIndex}
                onChange={(e) => { setLoopIndex(Number(e.target.value)); setRefOverrides({}); }}>
                {active.items.map((it, i) => (
                  <option key={it.code} value={i}>{i + 1}. {stripHtmlText(it.label)}</option>
                ))}
              </select></label>
            {loop && <span className="badge neutral" data-testid="loop-chip">{loop.loopVar} = {loop.label}</span>}
          </div>

          {active.columns.length > 0 && (
            <div className="lv-refs" data-testid="loop-references">
              <div className="eyebrow">Reference columns for this item</div>
              {active.columns.map((c) => {
                const base = item?.references?.[c.key];
                const value = refOverrides[c.key] ?? (base == null ? "" : String(base));
                return (
                  <label className="lv-ref" key={c.key}>
                    <span className="mono">{active.loopVar}.{c.key}</span>
                    <input className="input small" data-testid={`loop-ref-${c.key}`} value={value}
                      onChange={(e) => setRefOverrides({ ...refOverrides, [c.key]: e.target.value })} />
                  </label>
                );
              })}
              <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>
                These are the loop&apos;s own reference values. Editing one here only changes this
                preview — piping such as <span className="mono">{`{{${active.loopVar}.${active.columns[0].key}}}`}</span> resolves from it immediately.
              </p>
            </div>
          )}
        </>
      )}

      {deps.map((d) => (
        <div className="lc-sim-row" key={d.id}>
          <label className="f grow">
            <span>{d.code} · {stripHtmlText(d.text).slice(0, 60)}</span>
            {d.options.length > 0 ? (
              <select className="select small" data-testid={`sample-${d.code}`}
                value={String(sample[d.id] ?? "")}
                onChange={(e) => setSample({ ...sample, [d.id]: e.target.value || undefined })}>
                <option value="">— no answer —</option>
                {d.options.map((o) => (
                  <option key={String(o.code)} value={String(o.code)}>{stripHtmlText(o.label)}</option>
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

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn small" data-testid="clear-sample"
          onClick={() => { setSample({}); setRefOverrides({}); }}>Clear</button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Sample values drive this preview only — they never reach a respondent or the data.
        </span>
      </div>
    </details>
  );
}
