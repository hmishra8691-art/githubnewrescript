"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import {
  type FlowDropTarget, canDropFlowNode, findNode, summarizeFlowNode,
  type FlowNodeSummary,
} from "@rescript/engine";

/**
 * The Survey Flow drag-and-drop surface (reqs §5–9).
 *
 * Pointer events, not the browser's native drag. Native drag gives no control
 * over the preview, fires no events over some children, cannot show a
 * "not allowed" state that means anything, and cannot be driven reliably from
 * a test. Everything here is ordinary DOM: a handle captures the pointer, a
 * preview follows it, and the element under the cursor is looked up on each
 * move.
 *
 * What can be dropped where is NOT decided here — every zone asks
 * `canDropFlowNode` in the engine, the same function the ⋮ menus use. This
 * component only draws the answer.
 */

interface DragState {
  id: string;
  summary: FlowNodeSummary;
  x: number;
  y: number;
  /** the zone under the cursor right now */
  overKey: string | null;
  ok: boolean;
  reason?: string;
}

interface FlowDragApi {
  /** null when nothing is being dragged */
  drag: DragState | null;
  beginDrag(id: string, e: React.PointerEvent): void;
  /** Register a zone so the hit test can resolve it back to a target. */
  registerZone(key: string, target: FlowDropTarget): void;
  /** Ask whether the current drag could land here — for painting zones. */
  verdictFor(key: string): { ok: boolean; reason?: string } | null;
  dragging: boolean;
}

const Ctx = React.createContext<FlowDragApi | null>(null);

export function useFlowDrag(): FlowDragApi {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useFlowDrag outside FlowDragProvider");
  return v;
}

/** How far the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

export function FlowDragProvider({ flow, onMove, children }: {
  flow: FlowNode[];
  onMove(id: string, target: FlowDropTarget): void;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const zones = React.useRef(new Map<string, FlowDropTarget>());
  /** verdicts are computed once per zone per drag, not per mouse move */
  const verdicts = React.useRef(new Map<string, { ok: boolean; reason?: string }>());
  const pending = React.useRef<{ id: string; x: number; y: number } | null>(null);
  const flowRef = React.useRef(flow);
  flowRef.current = flow;
  const dragRef = React.useRef<DragState | null>(null);
  dragRef.current = drag;

  const registerZone = React.useCallback((key: string, target: FlowDropTarget) => {
    zones.current.set(key, target);
  }, []);

  const verdictFor = React.useCallback((key: string) => {
    const d = dragRef.current;
    if (!d) return null;
    const cached = verdicts.current.get(key);
    if (cached) return cached;
    const target = zones.current.get(key);
    if (!target) return null;
    const v = canDropFlowNode(flowRef.current, d.id, target);
    verdicts.current.set(key, v);
    return v;
  }, []);

  /** Which zone is under the cursor. */
  const hitTest = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    const zone = el?.closest<HTMLElement>("[data-drop-key]");
    return zone?.dataset.dropKey ?? null;
  };

  const finish = React.useCallback((commit: boolean) => {
    const d = dragRef.current;
    pending.current = null;
    document.body.classList.remove("flow-dragging");
    if (d && commit && d.overKey && d.ok) {
      const target = zones.current.get(d.overKey);
      if (target) onMove(d.id, target);
    }
    verdicts.current.clear();
    setDrag(null);
  }, [onMove]);

  // The listeners live on the window for the whole drag: a pointer that leaves
  // the panel, or a key pressed mid-drag, must still be heard.
  React.useEffect(() => {
    const onMoveEvt = (e: PointerEvent) => {
      const start = pending.current;
      if (start && !dragRef.current) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD_PX) return;
        const node = findNode(flowRef.current, start.id);
        if (!node) { pending.current = null; return; }
        verdicts.current.clear();
        document.body.classList.add("flow-dragging");
        setDrag({
          id: start.id, summary: summarizeFlowNode(node),
          x: e.clientX, y: e.clientY, overKey: null, ok: false,
        });
        return;
      }
      if (!dragRef.current) return;
      e.preventDefault();
      const key = hitTest(e.clientX, e.clientY);
      const v = key ? verdictForKey(key) : null;
      setDrag((d) => d && ({
        ...d, x: e.clientX, y: e.clientY,
        overKey: key, ok: v?.ok ?? false, reason: v?.reason,
      }));
    };

    const verdictForKey = (key: string) => {
      const d = dragRef.current;
      if (!d) return null;
      const cached = verdicts.current.get(key);
      if (cached) return cached;
      const target = zones.current.get(key);
      if (!target) return null;
      const v = canDropFlowNode(flowRef.current, d.id, target);
      verdicts.current.set(key, v);
      return v;
    };

    const onUp = () => {
      if (!dragRef.current) { pending.current = null; return; }
      finish(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        e.preventDefault();
        finish(false);
      }
    };

    window.addEventListener("pointermove", onMoveEvt, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMoveEvt);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [finish]);

  const beginDrag = React.useCallback((id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pending.current = { id, x: e.clientX, y: e.clientY };
  }, []);

  const api: FlowDragApi = {
    drag, beginDrag, registerZone, verdictFor, dragging: !!drag,
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {drag && <DragPreview drag={drag} />}
    </Ctx.Provider>
  );
}

/** The card that follows the cursor, and the running answer to "what happens". */
function DragPreview({ drag }: { drag: DragState }) {
  return (
    <div className="flow-drag-preview" data-testid="flow-drag-preview"
      style={{ left: drag.x + 14, top: drag.y + 12 }}>
      <div className="fdp-card">
        <span className="fdp-grip">⠿</span>
        <span className="fdp-label">{drag.summary.label}</span>
        <span className="fdp-detail">{drag.summary.detail}</span>
      </div>
      <div className={`fdp-verdict ${drag.overKey ? (drag.ok ? "ok" : "bad") : "idle"}`}>
        {!drag.overKey
          ? "Drag over a drop line or a container"
          : drag.ok
            ? "Release to move here"
            : `Cannot drop here — ${drag.reason ?? "not allowed"}`}
      </div>
    </div>
  );
}

/**
 * The grab area (req §6). Only this starts a drag: a card that is draggable
 * everywhere fights every text field and toggle inside it.
 */
export function DragHandle({ id, title }: { id: string; title?: string }) {
  const { beginDrag, drag } = useFlowDrag();
  return (
    <button
      type="button"
      className={`flow-grip ${drag?.id === id ? "is-dragging" : ""}`}
      data-testid="flow-grip"
      data-grip-for={id}
      title={title ?? "Drag to move — or use the ⋮ menu"}
      aria-label="Move this element"
      onPointerDown={(e) => beginDrag(id, e)}
      onClick={(e) => e.preventDefault()}
    >⠿</button>
  );
}

/**
 * A line between two elements: "drop before this" / "drop after that".
 * Invisible until a drag starts, then it is a real target with a real answer.
 */
export function DropZone({ zoneKey, target, label }: {
  zoneKey: string; target: FlowDropTarget; label?: string;
}) {
  const { registerZone, verdictFor, drag } = useFlowDrag();
  registerZone(zoneKey, target);
  const verdict = drag ? verdictFor(zoneKey) : null;
  const over = drag?.overKey === zoneKey;
  const cls = [
    "flow-dropzone",
    drag ? (verdict?.ok ? "valid" : "invalid") : "",
    over ? "over" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} data-drop-key={zoneKey} data-testid="flow-dropzone">
      <span className="fdz-line" />
      {over && (
        <span className="fdz-label">
          {verdict?.ok ? (label ?? "Drop here") : "Drop not allowed here"}
        </span>
      )}
    </div>
  );
}

/**
 * A container's own target: drop INSIDE it, appended. Wraps the container's
 * header so the whole bar lights up — "put it in this thing", as distinct from
 * the thin lines that mean "put it between these two".
 */
export function InsideDropTarget({ zoneKey, target, children, className }: {
  zoneKey: string; target: FlowDropTarget; children: React.ReactNode; className?: string;
}) {
  const { registerZone, verdictFor, drag } = useFlowDrag();
  registerZone(zoneKey, target);
  const verdict = drag ? verdictFor(zoneKey) : null;
  const over = drag?.overKey === zoneKey;
  const cls = [
    className ?? "",
    "flow-inside-target",
    drag ? (verdict?.ok ? "valid" : "invalid") : "",
    over ? "over" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} data-drop-key={zoneKey} data-testid="flow-inside-target">
      {children}
      {over && (
        <div className={`fit-banner ${verdict?.ok ? "ok" : "bad"}`}>
          {verdict?.ok ? "DROP INSIDE" : (verdict?.reason ?? "Drop not allowed here")}
        </div>
      )}
    </div>
  );
}

/** The dashed panel an empty container shows so it is visibly a place to put things. */
export function EmptyContainerZone({ zoneKey, target, what }: {
  zoneKey: string; target: FlowDropTarget; what: string;
}) {
  const { registerZone, verdictFor, drag } = useFlowDrag();
  registerZone(zoneKey, target);
  const verdict = drag ? verdictFor(zoneKey) : null;
  const over = drag?.overKey === zoneKey;
  const cls = [
    "flow-empty-zone",
    drag ? (verdict?.ok ? "valid" : "invalid") : "",
    over ? "over" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} data-drop-key={zoneKey} data-testid="flow-empty-zone">
      {drag
        ? (verdict?.ok ? `↓ Drop element inside this ${what}` : (verdict?.reason ?? "Not allowed here"))
        : `Empty ${what} — drag an element in, or use + Add element`}
    </div>
  );
}
