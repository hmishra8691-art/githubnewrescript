"use client";
import React from "react";
import { QuestionsPanel } from "./QuestionsPanel";
import { GridView } from "../grid/GridView";
import { ArchitectView } from "../architect/ArchitectView";
import { FlowCanvas } from "../flow/FlowCanvas";
import { IntelligentView } from "../intelligent/IntelligentView";
import { useMode } from "./ModeContext";
import { Icon } from "../ui/Icon";
import { modeInfo, type ProgrammingMode } from "../../lib/programmingMode";

/**
 * THE RENDERER SLOTS. One table, five renderers, no other place that maps
 * a mode to a view — so the split screen and the single view cannot drift.
 */
export function ModeRenderer({ mode }: { mode: ProgrammingMode }) {
  switch (mode) {
    case "grid": return <GridView />;
    case "architect": return <ArchitectView />;
    case "flow": return <FlowCanvas />;
    case "intelligent": return <IntelligentView />;
    default: return <QuestionsPanel />;
  }
}

const PREFS_KEY = "rescript.split";
function loadRatio(): number {
  try { const v = Number(window.localStorage.getItem(PREFS_KEY)); return v > 0.2 && v < 0.8 ? v : 0.5; } catch { return 0.5; }
}

/**
 * DUAL-MODE SPLIT (§15). Two renderer slots in the centre column, over the
 * one store: an edit typed in the left pane is on screen in the right pane
 * on the same render, because both are views of `s.def` and neither owns
 * any state the other lacks. The divider drags; the ratio is remembered.
 * Each pane has its own small header naming the mode, with the swap and
 * close controls, so the pair reads as what it is — two windows on one
 * survey — rather than one wide screen that happens to be split.
 */
export function SplitCenter({ primary, secondary }: { primary: ProgrammingMode; secondary: ProgrammingMode }) {
  const m = useMode();
  const [ratio, setRatio] = React.useState(loadRatio);
  const ref = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<boolean>(false);
  React.useEffect(() => { try { window.localStorage.setItem(PREFS_KEY, String(ratio)); } catch { /* fine */ } }, [ratio]);

  const onDown = (e: React.PointerEvent) => { drag.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setRatio(Math.max(0.25, Math.min(0.75, (e.clientX - r.left) / r.width)));
  };
  const onUp = () => { drag.current = false; };

  return (
    <div className="split" ref={ref} data-testid="split-view" data-primary={primary} data-secondary={secondary} style={{ gridTemplateColumns: `minmax(0, ${ratio}fr) 6px minmax(0, ${1 - ratio}fr)` }}>
      <SplitPane mode={primary} slot="primary" onClose={() => { m?.setMode(secondary); m?.setSplit(null); }} onSwap={() => m?.setMode(secondary)} />
      <div className="split-divider" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} role="separator" aria-orientation="vertical" data-testid="split-divider" />
      <SplitPane mode={secondary} slot="secondary" onClose={() => m?.setSplit(null)} onSwap={() => m?.setMode(secondary)} />
    </div>
  );
}

function SplitPane({ mode, slot, onClose, onSwap }: { mode: ProgrammingMode; slot: "primary" | "secondary"; onClose(): void; onSwap(): void }) {
  const info = modeInfo(mode);
  return (
    <section className={`split-pane ${mode}`} data-testid={`split-${slot}`} data-mode={mode} aria-label={`${info.label} pane`}>
      <div className="split-head">
        <span className="split-index mono">0{info.index}</span>
        <span className="split-name">{info.label}</span>
        <span className="split-tagline">{info.tagline}</span>
        <span className="split-spacer" />
        <button type="button" className="split-btn" onClick={onSwap} title="Swap panes" data-testid={`split-swap-${slot}`}><Icon name="share" size={12} /></button>
        <button type="button" className="split-btn" onClick={onClose} title={`Close this pane — keep ${slot === "primary" ? "the right pane" : "the left pane"}`} data-testid={`split-close-${slot}`}><Icon name="close" size={12} /></button>
      </div>
      <div className="split-body">
        <ModeRenderer mode={mode} />
      </div>
    </section>
  );
}
