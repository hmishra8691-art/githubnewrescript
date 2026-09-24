"use client";
import React from "react";
import { useMode } from "./ModeContext";
import { Icon } from "../ui/Icon";

/**
 * PROGRAMMING MODE — the selector in the top bar.
 *
 * Five environments over one survey, numbered like an instrument's ranges
 * so the eye finds "03 Architect" as fast as the word. Beside them, the
 * view-level switches that apply in every mode: Split (a second renderer,
 * §15), Focus (dependency neighbourhood only, §14) and the chooser (§10)
 * for a person who wants the five explained again. Switching is instant
 * and changes nothing but the view.
 */
export function ModeSelector() {
  const m = useMode();
  const [splitMenu, setSplitMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!splitMenu) return;
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setSplitMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSplitMenu(false); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey, true); };
  }, [splitMenu]);
  if (!m) return null;
  const splitInfo = m.split ? m.modes.find((x) => x.id === m.split) : null;

  return (
    <div className="mode-cluster" data-testid="mode-cluster">
      <div className="mode-selector" role="radiogroup" aria-label="Programming mode" data-testid="mode-selector">
        <span className="mode-selector-label">Mode</span>
        {m.modes.map((info) => {
          const active = m.mode === info.id;
          const paired = m.split === info.id;
          return (
            <button
              key={info.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`mode-option${active ? " active" : ""}${paired ? " paired" : ""}${info.available ? "" : " soon"}`}
              data-testid={`mode-${info.id}`}
              data-mode={info.id}
              data-available={info.available ? "1" : "0"}
              disabled={!info.available}
              title={info.available ? `${info.label} — ${info.tagline}. ${info.audience}${paired ? " (open in the split)" : ""}` : `${info.label} — ${info.tagline}. Coming soon.`}
              onClick={() => m.setMode(info.id)}
            >
              <span className="mode-index">0{info.index}</span>
              <span className="mode-name">{info.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mode-tools" ref={menuRef}>
        <button
          type="button"
          className={`mode-tool${m.split ? " on" : ""}`}
          data-testid="split-toggle"
          aria-pressed={!!m.split}
          aria-expanded={splitMenu}
          disabled={!m.splitAllowed}
          title={!m.splitAllowed ? "Split view needs a wider window" : m.split ? `Split with ${splitInfo?.label} — click to change or close` : "Split: a second environment beside this one, over the same survey"}
          onClick={() => setSplitMenu((v) => !v)}
        >
          <Icon name="layers" size={13} />
          <span className="mode-tool-label">{m.split ? `Split · ${splitInfo?.label}` : "Split"}</span>
        </button>
        {splitMenu && (
          <div className="mode-menu" role="menu" data-testid="split-menu">
            <div className="mode-menu-title">Show beside {m.modes.find((x) => x.id === m.mode)?.label}</div>
            {m.modes.filter((x) => x.available && x.id !== m.mode).map((x) => (
              <button key={x.id} type="button" role="menuitemradio" aria-checked={m.split === x.id} className={`mode-menu-item${m.split === x.id ? " on" : ""}`} data-testid={`split-${x.id}`} onClick={() => { m.setSplit(x.id); setSplitMenu(false); }}>
                <span className="mode-index">0{x.index}</span> {x.label}
                <span className="mode-menu-tag">{x.tagline}</span>
              </button>
            ))}
            {m.split && <button type="button" role="menuitem" className="mode-menu-item off" data-testid="split-off" onClick={() => { m.setSplit(null); setSplitMenu(false); }}><Icon name="close" size={12} /> Close split</button>}
          </div>
        )}
        <button
          type="button"
          className={`mode-tool${m.focus ? " on" : ""}`}
          data-testid="focus-mode-toggle"
          aria-pressed={m.focus}
          disabled={m.mode === "studio" && !m.split}
          title={m.mode === "studio" && !m.split ? "Focus applies in Grid, Architect, Flow and Intelligent" : "Focus (⌘⇧F): only the selection's dependency neighbourhood stays lit"}
          onClick={() => m.setFocus(!m.focus)}
        >
          <Icon name="sparkle" size={13} />
          <span className="mode-tool-label">Focus</span>
        </button>
        <button type="button" className="mode-tool quiet" data-testid="open-chooser" title="How do you want to program your research? — the five environments explained" onClick={() => m.openChooser()}>
          <Icon name="info" size={13} />
        </button>
      </div>
    </div>
  );
}
