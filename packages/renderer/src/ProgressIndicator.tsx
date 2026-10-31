import React from "react";
import { uiText } from "@rescript/engine";
import { progressModel, type ProgressPosition, type ProgressStyle } from "./progress";

/**
 * D20 — the respondent's progress indicator, one component for the runtime (Runner) and the Studio's Branding
 * preview, so what the designer sees is what ships. Placement is the caller's (top: above the page, bottom: after
 * the page body, before the footer; not sticky — a sticky bar on a phone covers the Next button and the keyboard).
 */
export function ProgressIndicator({ position, style, current, total, ended, ui, testid = "rs-progress" }: {
  position: ProgressPosition;
  style: ProgressStyle;
  current: number;
  total: number;
  ended?: boolean;
  ui?: Record<string, string>;
  testid?: string;
}): React.ReactElement | null {
  if (position === "none") return null;
  const m = progressModel(current, total, ended);
  const cls = `rs-progress rs-progress-${position} rs-progress-style-${style}`;
  if (style === "steps") {
    const label = uiText(ui, "page_of", { n: m.current, total: m.total });
    return (
      <div className={cls} data-testid={testid} data-position={position} data-style="steps"
        role="progressbar" aria-valuemin={1} aria-valuemax={m.total} aria-valuenow={m.current} aria-valuetext={label}>
        {m.dots && (
          <ol className="rs-progress-dots" aria-hidden="true" data-testid={`${testid}-dots`}>
            {Array.from({ length: m.total }, (_, i) => (
              <li key={i} className={`rs-progress-dot${i + 1 < m.current ? " done" : i + 1 === m.current ? " current" : ""}`} />
            ))}
          </ol>
        )}
        <div className="rs-progress-steps-label" data-testid={`${testid}-label`}>{label}</div>
      </div>
    );
  }
  return (
    <div className={cls} data-testid={testid} data-position={position} data-style={style}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.percent} aria-valuetext={`${m.percent}%`}>
      <div className="rs-progress-track"><div className="rs-progress-fill" style={{ width: `${m.percent}%` }} /></div>
      {style === "percent" && <div className="rs-progress-label" data-testid={`${testid}-label`}>{m.percent}%</div>}
    </div>
  );
}
