"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import {
  createResponseState, validatePage, setAnswer, answerKey, authoringQuestionView,
  otherKey, setOtherText, otherIsSelected,
  type ResponseState, type LoopContext,
} from "@rescript/engine";
import { QuestionRenderer } from "@rescript/renderer";
import { neutralised, annotate, withMarkedPiping, type AuthoringAnnotations } from "./authoringView";
import { resolveFromDom, findElement, sameSelection, type SelectedEntity } from "./selection";

/**
 * THE LIVE QUESTION CANVAS.
 *
 * The question the programmer is building, rendered by the SAME component the
 * respondent runtime uses — not a mock of it, not a screenshot, not a second
 * implementation kept in step by hand. @rescript/renderer is imported by both
 * apps, so a discrepancy between "what I am programming" and "what they will
 * answer" is not something that can quietly appear.
 *
 * On top of that render sits an authoring layer that is entirely non-visual to
 * the renderer: hover and selection outlines are drawn by a sibling overlay
 * positioned from `getBoundingClientRect`, and clicks are resolved by walking
 * up from the click target to the nearest element the renderer anchored. The
 * rendered markup is therefore identical in both surfaces.
 *
 * Two readings of the same definition:
 *   authoring   — logic neutralised so the whole structure is visible and
 *                 clickable; hidden items are drawn dimmed and labelled.
 *   simulation  — the real question, the real engine, the sample answers: what
 *                 a respondent would actually get.
 */

export type CanvasMode = "author" | "simulate";
export type CanvasDevice = "desktop" | "tablet" | "mobile";

export interface LiveCanvasProps {
  q: Question;
  def: import("@rescript/schema").SurveyDefinition;
  mode: CanvasMode;
  device: CanvasDevice;
  /** answers the programmer typed into the simulator, keyed by question id */
  sample: Record<string, unknown>;
  /** loop iteration being previewed, when the question sits inside a loop */
  loop: LoopContext | null;
  /** simulation seed — changing it re-rolls randomization */
  seed: number;
  selected: SelectedEntity | null;
  onSelect(sel: SelectedEntity | null): void;
  showHidden: boolean;
  showIndicators: boolean;
  onAnnotations?(a: AuthoringAnnotations): void;
}

/** Where an overlay box should sit, in canvas-local coordinates. */
interface Box { top: number; left: number; width: number; height: number }

export function LiveCanvas(p: LiveCanvasProps) {
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = React.useState<SelectedEntity | null>(null);
  const [selBox, setSelBox] = React.useState<Box | null>(null);
  const [hoverBox, setHoverBox] = React.useState<Box | null>(null);
  /**
   * THE SIMULATOR'S TYPED ANSWERS, KEYED THE WAY THE RUNTIME KEYS THEM.
   *
   * These were two bare `useState`s — one answer, one "Other, specify" text,
   * belonging to no question in particular. The canvas got away with it only
   * because the editor happens to remount when the selection changes; the
   * moment anything renders it in a stable position across two questions, the
   * text typed into Q1's Other box appears in Q2's, which is exactly the bug
   * that was reported. State that belongs to a question must be keyed by that
   * question — here, by `answerKey(q.id, loop)`, the same key the runner and
   * the validator use, so the canvas cannot disagree with either.
   */
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const slot = answerKey(p.q.id, p.loop ?? null);
  const value = draft[slot];
  const otherValue = typeof draft[otherKey(p.q.id, p.loop ?? null)] === "string"
    ? (draft[otherKey(p.q.id, p.loop ?? null)] as string)
    : "";

  const simulating = p.mode === "simulate";

  /**
   * The response state the renderer evaluates against. It is rebuilt whenever
   * the sample answers change so display logic, piping, masking and carry
   * forward all see them — the same `ResponseState` shape the runtime uses, so
   * the engine cannot tell the difference between this and a real interview.
   */
  const state: ResponseState = React.useMemo(() => {
    const st = createResponseState(p.def, { seed: p.seed, sessionId: "canvas" });
    for (const [qid, v] of Object.entries(p.sample)) {
      if (v === undefined || v === "") continue;
      if (!p.def.questions.some((x) => x.id === qid)) continue;
      try {
        setAnswer(p.def, st, qid, v, null);
      } catch {
        st.answers[answerKey(qid, null)] = v as never;
      }
    }
    if (simulating && value !== undefined) {
      try {
        setAnswer(p.def, st, p.q.id, value, p.loop);
      } catch { /* a value the engine rejects is still worth rendering */ }
    }
    /*
     * The other-specify text goes INTO the response state, not beside it.
     * It used to live only in a React state the validator could not see, so
     * "Please specify" stayed on screen while the programmer typed into the
     * box — the simulator disagreeing with the real validator about the same
     * answer. `setOtherText` writes the one key everything reads.
     */
    if (simulating && otherValue) setOtherText(st, p.q.id, otherValue, p.loop);
    return st;
  }, [p.def, p.sample, p.seed, p.q, p.loop, simulating, value, otherValue]);

  const ctx = React.useMemo(() => ({ def: p.def, state, loop: p.loop }), [p.def, state, p.loop]);

  /** Annotations always describe the REAL question, in both modes. */
  const annotations = React.useMemo(() => annotate(p.q, ctx), [p.q, ctx]);
  React.useEffect(() => { p.onAnnotations?.(annotations); }, [annotations]); // eslint-disable-line react-hooks/exhaustive-deps

  /** What actually goes to the renderer. */
  const rendered = React.useMemo(
    () => (simulating ? p.q : withMarkedPiping(authoringQuestionView(neutralised(p.q), p.def, ctx), ctx)),
    [simulating, p.q, p.def, ctx],
  );

  /** Real validation, from the real validator — never a preview-only copy. */
  const errors = React.useMemo(() => {
    if (!simulating) return [];
    try {
      return validatePage(p.def, [p.q], { def: p.def, state, loop: p.loop })
        .filter((e) => e.questionId === p.q.id)
        .map((e) => e.message);
    } catch {
      return [];
    }
  }, [simulating, p.def, p.q, state, p.loop]);

  /* ------------------------------------------------------- overlay geometry */

  const boxOf = React.useCallback((sel: SelectedEntity | null): Box | null => {
    const stage = stageRef.current;
    if (!stage || !sel) return null;
    const el = findElement(stage, sel);
    if (!el) return null;
    const a = el.getBoundingClientRect();
    const b = stage.getBoundingClientRect();
    if (a.width === 0 && a.height === 0) return null;
    /* The outlines live INSIDE the stage so they scroll with it — a wide matrix
       scrolls sideways here just as it does for a respondent — so the offsets
       are content coordinates, which means adding back what is scrolled away. */
    return {
      top: a.top - b.top + stage.scrollTop,
      left: a.left - b.left + stage.scrollLeft,
      width: a.width, height: a.height,
    };
  }, []);

  /* Re-measure after every render that can move things, and while the stage
     resizes — a device switch, an added option and a window resize all move
     the outline, and an outline that lags is worse than none.
     The measurement runs after EVERY render (there is no dependency list that
     could capture "the DOM moved"), so it must only write state when a box
     actually changed — otherwise each measurement would schedule the next. */
  const same = (a: Box | null, b: Box | null) =>
    a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

  const measure = React.useCallback(() => {
    const next = boxOf(p.selected);
    setSelBox((prev) => (same(prev, next) ? prev : next));
    const nextHover = boxOf(hover);
    setHoverBox((prev) => (same(prev, nextHover) ? prev : nextHover));
  }, [boxOf, p.selected, hover]);

  React.useLayoutEffect(measure);
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(stage);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure]);

  /* ------------------------------------------------------------ interaction */

  const pick = (e: React.MouseEvent) => {
    if (simulating) return; // simulation is the respondent's experience, untouched
    const sel = resolveFromDom(e.target as Element, p.q.id);
    p.onSelect(sel ?? { type: "question", questionId: p.q.id });
  };

  const track = (e: React.MouseEvent) => {
    if (simulating) { if (hover) setHover(null); return; }
    const sel = resolveFromDom(e.target as Element, p.q.id);
    if (!sameSelection(sel, hover)) setHover(sel);
  };

  /**
   * In authoring mode the rendered controls are targets to program, not
   * controls to answer: a click on a radio should select that option for
   * editing, not tick it. Interaction is therefore suppressed at the capture
   * phase — which leaves the renderer completely unmodified, and switching to
   * simulation gives every control straight back.
   */
  const swallow = (e: React.SyntheticEvent) => {
    if (simulating) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-lc-edit]")) return; // the inline editor is ours
    // preventDefault alone: it stops a label from ticking its checkbox while
    // still letting the event reach `pick` below. stopPropagation here would
    // cancel the selection too, since capture runs before the target handler.
    e.preventDefault();
  };

  const width = p.device === "mobile" ? 390 : p.device === "tablet" ? 780 : undefined;

  return (
    <div className={`lc-canvas ${simulating ? "simulating" : "authoring"}`} data-testid="live-canvas">
      <div className="lc-frame" style={width ? { width, maxWidth: "100%" } : undefined} data-device={p.device}>
        <div
          className={`lc-stage rs-shell ${p.showHidden ? "show-hidden" : ""} ${p.showIndicators ? "show-flags" : ""}`}
          ref={stageRef}
          onClickCapture={swallow}
          onMouseDownCapture={swallow}
          onKeyDownCapture={swallow}
          onClick={pick}
          onMouseMove={track}
          onMouseLeave={() => setHover(null)}
          data-testid="canvas-stage"
        >
          <QuestionRenderer
            def={p.def}
            q={rendered}
            state={state}
            loop={p.loop}
            value={simulating ? value : undefined}
            otherValue={otherValue}
            errors={errors}
            onChange={(v) => {
              if (!simulating) return;
              /* the answer, and — when Other is no longer among the selections — the text that belonged to it */
              setDraft((d) => {
                const next = { ...d, [slot]: v };
                if (!otherIsSelected(p.q, v)) delete next[otherKey(p.q.id, p.loop ?? null)];
                return next;
              });
            }}
            onOtherChange={(t) => simulating && setDraft((d) => ({ ...d, [otherKey(p.q.id, p.loop ?? null)]: t }))}
          />
          {!simulating && <Marks stage={stageRef} q={p.q} ann={annotations} show={p.showIndicators} hidden={p.showHidden} />}

          {!simulating && hoverBox && !sameSelection(hover, p.selected) && (
            <div className="lc-outline hover" style={hoverBox} aria-hidden />
          )}
          {!simulating && selBox && (
            <div className="lc-outline selected" style={selBox} aria-hidden data-testid="canvas-selection">
              <span className="lc-tag">{p.selected?.type}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Programming indicators, drawn as an overlay rather than injected into the
 * rendered markup — the renderer stays the respondent's renderer, and a
 * programmer sees which parts of the question carry configuration without any
 * of it reaching a respondent's screen.
 */
function Marks({ stage, q, ann, show, hidden }: {
  stage: React.RefObject<HTMLDivElement | null>;
  q: Question;
  ann: AuthoringAnnotations;
  show: boolean;
  hidden: boolean;
}) {
  const [marks, setMarks] = React.useState<{ key: string; box: Box; logic: boolean; hidden: boolean }[]>([]);

  React.useLayoutEffect(() => {
    const root = stage.current;
    if (!root) { setMarks([]); return; }
    const base = root.getBoundingClientRect();
    const out: { key: string; box: Box; logic: boolean; hidden: boolean }[] = [];
    const add = (kind: string, id: string, logic: boolean, isHidden: boolean) => {
      if (!logic && !isHidden) return;
      const el = root.querySelector<HTMLElement>(`[data-rs-el="${kind}"][data-rs-id="${CSS.escape(id)}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      out.push({
        key: `${kind}:${id}`,
        box: {
          top: r.top - base.top + root.scrollTop,
          left: r.left - base.left + root.scrollLeft,
          width: r.width, height: r.height,
        },
        logic, hidden: isHidden,
      });
    };
    for (const o of q.options) add("option", String(o.code), ann.programmedOptions.has(String(o.code)), ann.hiddenOptions.has(String(o.code)));
    for (const r of q.rows) add("row", String(r.code), ann.programmedRows.has(String(r.code)), ann.hiddenRows.has(String(r.code)));
    for (const c of q.columns) add("column", c.id, ann.programmedColumns.has(c.id), ann.hiddenColumns.has(c.id));
    const key = JSON.stringify(out);
    setMarks((prev) => (JSON.stringify(prev) === key ? prev : out));
  }, [stage, q, ann]);

  return (
    <>
      {marks.map((m) => (
        <React.Fragment key={m.key}>
          {hidden && m.hidden && (
            <div className="lc-hidden-veil" style={m.box} aria-hidden>
              <span className="lc-hidden-tag">Hidden by logic</span>
            </div>
          )}
          {show && m.logic && (
            <span
              className="lc-flag"
              style={{ top: m.box.top + 2, left: m.box.left + m.box.width - 18 }}
              title="This element carries programming"
              data-testid="lc-flag"
              aria-hidden
            >
              ⚙
            </span>
          )}
        </React.Fragment>
      ))}
    </>
  );
}
