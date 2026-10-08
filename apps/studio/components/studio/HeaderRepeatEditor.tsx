"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import {
  headerRepeatEvery, AUTO_HEADER_EVERY, HEADER_REPEAT_PRESETS, HEADER_REPEAT_DEFAULT_ABOVE, HEADER_REPEAT_SUGGEST_FROM,
  type HeaderRepeat,
} from "@rescript/engine";
import { CountInput } from "./CountInput";

/**
 * HEADER REPEAT (07-10-2026 review, Prince #2) — every grid / matrix subtype
 * that draws a column header: Off, Repeat automatically (about every 10
 * rows), or Repeat after every N rows (5, 10, 15, 20, 25 or a custom count).
 * Display only: no column, value or variable is added.
 *
 * Left unset, a grid follows its length — off up to 20 rows, automatic beyond
 * — and this says which applies, so the default is never a mystery.
 */
export function HeaderRepeatEditor({ q, patchSettings }: { q: Question; patchSettings(p: Partial<Question["settings"]>): void }) {
  const setting = q.settings.headerRepeat as HeaderRepeat | undefined;
  const rows = q.rows.length;
  const effective = headerRepeatEvery(setting, rows);
  const mode: "default" | "off" | "auto" | "every" = setting == null ? "default" : setting === "off" ? "off" : setting === "auto" ? "auto" : "every";
  const n = typeof setting === "number" ? setting : 10;
  const preset = (HEADER_REPEAT_PRESETS as readonly number[]).includes(n);
  const [custom, setCustom] = React.useState(mode === "every" && !preset);
  const set = (v: HeaderRepeat | undefined) => patchSettings({ headerRepeat: v as never });

  const summary = effective
    ? `The column header is drawn again after every ${effective} rows (${Math.floor((rows - 1) / effective)} repeat${Math.floor((rows - 1) / effective) === 1 ? "" : "s"} on this ${rows}-row grid).`
    : rows <= (setting === "auto" ? AUTO_HEADER_EVERY : typeof setting === "number" ? setting : 0) && setting !== "off" && setting != null
      ? `This grid has ${rows} row${rows === 1 ? "" : "s"} — too few for the header to repeat yet.`
      : "The column header is shown once, at the top.";

  return (
    <div data-testid="header-repeat-editor">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select className="select" style={{ width: 230 }} data-testid="header-repeat-mode"
          value={mode}
          onChange={(e) => {
            const m = e.target.value;
            if (m === "default") set(undefined);
            else if (m === "off") set("off");
            else if (m === "auto") set("auto");
            else { setCustom(false); set(10); }
          }}>
          <option value="default">Default for this grid ({rows > HEADER_REPEAT_DEFAULT_ABOVE ? "automatic" : "off"})</option>
          <option value="off">Off</option>
          <option value="auto">Repeat automatically (about every {AUTO_HEADER_EVERY} rows)</option>
          <option value="every">Repeat after every N rows</option>
        </select>
        {mode === "every" && (
          <>
            <select className="select" style={{ width: 110 }} data-testid="header-repeat-every"
              value={custom ? "custom" : String(n)}
              onChange={(e) => {
                if (e.target.value === "custom") { setCustom(true); return; }
                setCustom(false);
                set(Number(e.target.value));
              }}>
              {HEADER_REPEAT_PRESETS.map((k) => <option key={k} value={k}>{k} rows</option>)}
              <option value="custom">Custom…</option>
            </select>
            {custom && (
              <CountInput min={1} max={500} width={80} allowEmpty={false} data-testid="header-repeat-custom"
                value={n} onChange={(v) => set(v ?? 10)} />
            )}
          </>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }} data-testid="header-repeat-summary">{summary}</p>
      {setting == null && rows >= HEADER_REPEAT_SUGGEST_FROM && rows <= HEADER_REPEAT_DEFAULT_ABOVE && (
        <p className="chip" style={{ display: "block", whiteSpace: "normal", marginTop: 6 }} data-testid="header-repeat-suggest">
          A {rows}-row grid is long enough that respondents lose sight of the header — consider
          <button className="btn small" style={{ marginLeft: 6 }} data-testid="header-repeat-suggest-apply" onClick={() => set("auto")}>repeat automatically</button>
        </p>
      )}
    </div>
  );
}
