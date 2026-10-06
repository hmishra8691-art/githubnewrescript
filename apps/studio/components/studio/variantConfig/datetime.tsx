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
          <label key={d} className="row" style={{ gap: 4, fontSize: 13 }}>
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
      <div className="muted" style={{ fontSize: 12.5 }}>
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
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Empty = {thisYear - 80}–{thisYear + 5}. Stores &quot;YYYY-MM&quot; once both selects are chosen.
      </div>
    </>
  );
});

/*
 * DATE PICKER and TIME PICKER (October 2026 review): "the Date Picker and
 * Time Picker should allow the survey programmer to control both the default
 * value and the display format — Date Picker: Default Date + Date Format;
 * Time Picker: Default Time + Time Format". The answer is stored as
 * YYYY-MM-DD / 24-hour HH:MM whatever is shown, so logic, bounds and exports
 * never read a display format. Unset keeps the browser's own field, which is
 * what every question authored before shows.
 */
const DATE_FORMAT_OPTIONS: { value: string; example: string }[] = [
  { value: "MM/DD/YYYY", example: "09/23/2026" }, { value: "DD/MM/YYYY", example: "23/09/2026" },
  { value: "YYYY/MM/DD", example: "2026/09/23" }, { value: "MM-DD-YYYY", example: "09-23-2026" },
  { value: "DD-MM-YYYY", example: "23-09-2026" }, { value: "YYYY-MM-DD", example: "2026-09-23" },
  { value: "DD MMM YYYY", example: "23 Sep 2026" }, { value: "MMM DD, YYYY", example: "Sep 23, 2026" },
];

registerVariantSettings("base:date", ({ q, patchSettings }) => (
  <>
    <h3 className="sec">Date</h3>
    <div className="row" style={{ flexWrap: "wrap", gap: 12 }} data-testid="date-settings">
      <label className="f" style={{ width: 190 }}><span>Default date</span>
        <select className="select" data-testid="default-date-mode"
          value={q.settings.defaultDateMode ?? "none"}
          onChange={(e) => patchSettings({ defaultDateMode: e.target.value === "none" ? undefined : (e.target.value as "current" | "custom") })}>
          <option value="none">none — left blank</option>
          <option value="current">current date (the respondent's today)</option>
          <option value="custom">a specific date</option>
        </select></label>
      {q.settings.defaultDateMode === "custom" && (
        <label className="f" style={{ width: 170 }}><span>Specific date</span>
          <input className="input" type="date" data-testid="default-date"
            value={q.settings.defaultDate ?? ""}
            onChange={(e) => patchSettings({ defaultDate: e.target.value || undefined })} /></label>
      )}
      <label className="f" style={{ width: 230 }}><span>Date format</span>
        <select className="select" data-testid="date-format"
          value={q.settings.dateFormat ?? ""}
          onChange={(e) => patchSettings({ dateFormat: (e.target.value || undefined) as never })}>
          <option value="">browser default (native picker)</option>
          {DATE_FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.value} → {f.example}</option>)}
        </select></label>
    </div>
  </>
));

registerVariantSettings("base:time", ({ q, patchSettings }) => (
  <>
    <h3 className="sec">Time</h3>
    <div className="row" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-end" }} data-testid="time-settings">
      <label className="f" style={{ width: 200 }}><span>Default time</span>
        <select className="select" data-testid="default-time-mode"
          value={q.settings.defaultTimeMode ?? "none"}
          onChange={(e) => patchSettings({ defaultTimeMode: e.target.value === "none" ? undefined : (e.target.value as "current" | "custom") })}>
          <option value="none">none — left blank</option>
          <option value="current">current time (the respondent's clock)</option>
          <option value="custom">a specific time</option>
        </select></label>
      {q.settings.defaultTimeMode === "custom" && (
        <label className="f" style={{ width: 140 }}><span>Specific time</span>
          <input className="input" type="time" step={q.settings.showSeconds ? 1 : undefined} data-testid="default-time"
            value={q.settings.defaultTime ?? ""}
            onChange={(e) => patchSettings({ defaultTime: e.target.value || undefined })} /></label>
      )}
      <label className="f" style={{ width: 210 }}><span>Time format</span>
        <select className="select" data-testid="time-format"
          value={q.settings.timeFormat ?? ""}
          onChange={(e) => patchSettings({ timeFormat: (e.target.value || undefined) as never })}>
          <option value="">browser default (native picker)</option>
          <option value="12">12-hour → 09:30 AM</option>
          <option value="24">24-hour → 09:30</option>
        </select></label>
      <label className="row" style={{ gap: 6, fontSize: 13, paddingBottom: 8 }}>
        <input type="checkbox" data-testid="show-seconds" checked={!!q.settings.showSeconds}
          onChange={(e) => patchSettings({ showSeconds: e.target.checked || undefined })} />
        show seconds
      </label>
    </div>
  </>
));
