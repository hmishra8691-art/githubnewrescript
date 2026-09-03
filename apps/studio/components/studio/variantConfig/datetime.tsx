"use client";
import React from "react";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the datetime family — see docs/VARIANT-BATCH.md §4.
 *
 *   calendar   the selectable window, the weekdays that are closed, and the
 *              time slots offered on an open day
 *   monthyear  the year range the two selects offer
 */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

registerVariantSettings("calendar", ({ q, patchSettings }) => {
  const disabled = q.settings.disabledWeekdays ?? [];
  const slots = q.settings.timeSlots ?? [];
  const toggleDow = (i: number) => {
    const next = disabled.includes(i) ? disabled.filter((d) => d !== i) : [...disabled, i].sort();
    patchSettings({ disabledWeekdays: next.length ? next : undefined });
  };
  return (
    <>
      <h3 className="sec">Calendar</h3>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="f grow" style={{ marginBottom: 0 }}>
          <span>Earliest date</span>
          <input className="input" type="date" data-testid="cal-min-date"
            value={q.settings.minDate ?? ""}
            onChange={(e) => patchSettings({ minDate: e.target.value || undefined })} />
        </label>
        <label className="f grow" style={{ marginBottom: 0 }}>
          <span>Latest date</span>
          <input className="input" type="date" data-testid="cal-max-date"
            value={q.settings.maxDate ?? ""}
            onChange={(e) => patchSettings({ maxDate: e.target.value || undefined })} />
        </label>
      </div>

      <div className="flabel">Closed weekdays</div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {DOW.map((d, i) => (
          <label key={d} className="row" style={{ gap: 4, fontSize: 12 }}>
            <input type="checkbox" data-testid={`cal-dow-${i}`}
              checked={disabled.includes(i)}
              onChange={() => toggleDow(i)} />
            {d}
          </label>
        ))}
      </div>

      <label className="f">
        <span>Time slots (comma separated — leave empty for whole days)</span>
        <input className="input" data-testid="cal-slots"
          placeholder="09:00, 10:30, 13:00"
          value={slots.join(", ")}
          onChange={(e) => {
            const list = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            patchSettings({ timeSlots: list.length ? list : undefined });
          }} />
      </label>
      <div className="muted" style={{ fontSize: 11 }}>
        {slots.length
          ? `Stores "YYYY-MM-DDTHH:mm" — the day alone is not an answer, so a required question still asks for a time.`
          : `Stores "YYYY-MM-DD".`}
      </div>
    </>
  );
});

registerVariantSettings("monthyear", ({ q, patchSettings }) => {
  const thisYear = new Date().getFullYear();
  return (
    <>
      <h3 className="sec">Month / Year</h3>
      <div className="row">
        <label className="f" style={{ marginBottom: 0 }}>
          <span>Earliest year</span>
          <CountInput data-testid="my-min-year" min={1} max={3000}
            value={q.settings.minYear}
            onChange={(v) => patchSettings({ minYear: v })} />
        </label>
        <label className="f" style={{ marginBottom: 0 }}>
          <span>Latest year</span>
          <CountInput data-testid="my-max-year" min={1} max={3000}
            value={q.settings.maxYear}
            onChange={(v) => patchSettings({ maxYear: v })} />
        </label>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Empty = {thisYear - 80}–{thisYear + 5}. Stores &quot;YYYY-MM&quot; once both selects are chosen.
      </div>
    </>
  );
});
