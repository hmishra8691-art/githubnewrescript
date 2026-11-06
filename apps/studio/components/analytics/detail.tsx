"use client";
import React from "react";

/**
 * THE LEVEL OF DETAIL (Analytics upgrade M7) — three preferences, not three products:
 *
 *   simple        business readers: clean charts, the plain reading, the key comparisons; statistics folded away
 *   professional  researchers: tables, significance, filters and segments, the plain reading with its evidence
 *   advanced      analysts: every statistic open — tests, p-values, effect sizes, configuration, technical ids
 *
 * It changes how much is SHOWN, never what exists: every view keeps its data; switching loses nothing.
 * Remembered per browser.
 */
export type DetailLevel = "simple" | "professional" | "advanced";
export const DETAIL_KEY = "rescript.analytics.detail";
export const DETAIL_LEVELS: { key: DetailLevel; label: string; hint: string }[] = [
  { key: "simple", label: "Simple", hint: "Charts, key findings and plain-language explanations" },
  { key: "professional", label: "Professional", hint: "Crosstabs, significance, filters, segments, research insights" },
  { key: "advanced", label: "Advanced", hint: "Every statistic, configuration and coefficient open" },
];

const Ctx = React.createContext<{ level: DetailLevel; setLevel: (l: DetailLevel) => void }>({ level: "professional", setLevel: () => {} });

export function DetailProvider({ children }: { children: React.ReactNode }) {
  const [level, setLevelRaw] = React.useState<DetailLevel>("professional");
  React.useEffect(() => { try { const v = window.localStorage.getItem(DETAIL_KEY); if (v === "simple" || v === "professional" || v === "advanced") setLevelRaw(v); } catch { /* fine */ } }, []);
  const setLevel = React.useCallback((l: DetailLevel) => { setLevelRaw(l); try { window.localStorage.setItem(DETAIL_KEY, l); } catch { /* fine */ } }, []);
  const v = React.useMemo(() => ({ level, setLevel }), [level, setLevel]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export const useDetail = () => React.useContext(Ctx);

export function DetailSwitch() {
  const { level, setLevel } = useDetail();
  return (
    <div className="axa-seg" role="radiogroup" aria-label="Level of detail" data-testid="ax-detail-switch">
      {DETAIL_LEVELS.map((l) => <button key={l.key} role="radio" aria-checked={level === l.key} className={`axa-seg-btn ${level === l.key ? "on" : ""}`} onClick={() => setLevel(l.key)} title={l.hint} data-testid={`ax-detail-${l.key}`}>{l.label}</button>)}
    </div>
  );
}
