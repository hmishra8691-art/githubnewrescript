"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * Date / Time family — Calendar / Appointment Selection and Month / Year.
 *
 * Both store TEXT on a `date` base type, so logic, piping and exports see an
 * ordinary date answer:
 *   calendar   "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm" when slots are configured
 *   monthyear  "YYYY-MM"
 *
 * Everything is built from local-time `Date(y, m, d)` — never `new Date(str)`,
 * whose ISO parsing is UTC and would show a respondent in UTC-5 the previous
 * day for every date they picked.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s: unknown): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof s === "string" ? s : "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/* ------------------------------------------------------------------ calendar */
export function CalendarPick(p: QRProps) {
  const s = p.q.settings;
  const slots = (s.timeSlots ?? []).map((x) => String(x).trim()).filter(Boolean);
  const disabledDows = new Set((s.disabledWeekdays ?? []).map(Number));
  const minDate = parseYmd(s.minDate);
  const maxDate = parseYmd(s.maxDate);
  const readOnly = !!s.readOnly;

  const stored = typeof p.value === "string" ? p.value : "";
  const storedDay = stored.slice(0, 10);
  const storedSlot = stored.length > 10 ? stored.slice(11) : "";

  // Deterministic opening month: the answer's month, else the window's start,
  // else this month — so a survey with a booking window opens ON the window.
  const today = React.useMemo(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }, []);
  const initial = parseYmd(storedDay) ?? minDate ?? today;
  const [view, setView] = React.useState({ y: initial.getFullYear(), m: initial.getMonth() });
  const [openDay, setOpenDay] = React.useState<string>(storedDay);
  const [focusDay, setFocusDay] = React.useState<string>(storedDay || ymd(initial));
  const gridRef = React.useRef<HTMLDivElement>(null);

  const dayDisabled = (d: Date): boolean => {
    if (disabledDows.has(d.getDay())) return true;
    if (minDate && d < minDate) return true;
    if (maxDate && d > maxDate) return true;
    return false;
  };

  const first = new Date(view.y, view.m, 1);
  const lead = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(view.y, view.m, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const shiftMonth = (delta: number) => {
    const d = new Date(view.y, view.m + delta, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  const choose = (d: Date) => {
    if (readOnly || dayDisabled(d)) return;
    const key = ymd(d);
    setOpenDay(key);
    setFocusDay(key);
    if (slots.length === 0) p.onChange(key);
    // with slots configured the day alone is not an appointment — the answer
    // lands when a time is picked, so a required question still asks for one
    else if (storedDay && storedDay !== key) p.onChange(null);
  };

  const chooseSlot = (t: string) => {
    if (readOnly || !openDay) return;
    p.onChange(`${openDay}T${t}`);
  };

  /** Roving focus: arrows move the focused day, Enter/Space picks it. */
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1
        : e.key === "ArrowUp" ? -7 : e.key === "ArrowDown" ? 7 : 0;
    if (step === 0) return;
    e.preventDefault();
    const from = parseYmd(focusDay) ?? new Date(view.y, view.m, 1);
    const to = addDays(from, step);
    setFocusDay(ymd(to));
    if (to.getMonth() !== view.m || to.getFullYear() !== view.y) {
      setView({ y: to.getFullYear(), m: to.getMonth() });
    }
  };

  React.useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`);
    if (el && gridRef.current?.contains(document.activeElement)) el.focus();
  }, [focusDay]);

  const monthLabel = `${MONTHS[view.m]} ${view.y}`;

  return (
    <div className="rs-cal" data-testid="calendar">
      <div className="rs-cal-head">
        <button type="button" className="rs-cal-nav" aria-label="Previous month"
          data-testid="cal-prev" onClick={() => shiftMonth(-1)}>‹</button>
        <div className="rs-cal-month" aria-live="polite" data-testid="cal-month">{monthLabel}</div>
        <button type="button" className="rs-cal-nav" aria-label="Next month"
          data-testid="cal-next" onClick={() => shiftMonth(1)}>›</button>
      </div>

      <div className="rs-cal-dow" aria-hidden>
        {WEEKDAYS.map((w, i) => (
          <span key={w} className={disabledDows.has(i) ? "off" : ""}>{w}</span>
        ))}
      </div>

      <div className="rs-cal-grid" role="grid" aria-label={monthLabel}
        ref={gridRef} onKeyDown={onGridKeyDown}>
        {cells.map((d, i) => {
          if (!d) return <span key={`pad${i}`} className="rs-cal-pad" role="presentation" />;
          const key = ymd(d);
          const off = dayDisabled(d);
          const isOpen = key === openDay;
          const isAnswer = key === storedDay && (slots.length === 0 || !!storedSlot);
          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              data-day={key}
              className={`rs-cal-day${off ? " disabled" : ""}${isAnswer ? " selected" : ""}${isOpen && !isAnswer ? " open" : ""}${key === ymd(today) ? " today" : ""}`}
              aria-label={`${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`}
              aria-pressed={isAnswer}
              aria-disabled={off}
              disabled={off || readOnly}
              tabIndex={key === focusDay ? 0 : -1}
              onFocus={() => setFocusDay(key)}
              onClick={() => choose(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {slots.length > 0 && (
        <div className="rs-cal-slots" data-testid="cal-slots">
          {!openDay ? (
            <span className="rs-cal-hint">Pick a day to see the available times.</span>
          ) : (
            <>
              <div className="rs-cal-hint">Times on {openDay}</div>
              <div className="rs-cal-slotrow" role="radiogroup" aria-label="Available times">
                {slots.map((t) => {
                  const on = openDay === storedDay && t === storedSlot;
                  return (
                    <button key={t} type="button" data-slot={t}
                      className={`rs-cal-slot${on ? " selected" : ""}`}
                      role="radio" aria-checked={on} disabled={readOnly}
                      onClick={() => chooseSlot(t)}>
                      {t}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      <div className="rs-cal-status" data-testid="cal-status">
        {stored
          ? storedSlot
            ? `Booked ${storedDay} at ${storedSlot}`
            : `Selected ${storedDay}`
          : "Nothing selected yet"}
        {stored && !readOnly && (
          <button type="button" className="rs-cal-clear"
            onClick={() => { p.onChange(null); setOpenDay(""); }}>clear</button>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- month/year */
export function MonthYearPick(p: QRProps) {
  const s = p.q.settings;
  const thisYear = new Date().getFullYear();
  const minYear = s.minYear ?? thisYear - 80;
  const maxYear = s.maxYear ?? thisYear + 5;
  const lo = Math.min(minYear, maxYear);
  const hi = Math.max(minYear, maxYear);
  const years = Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);

  const stored = typeof p.value === "string" ? p.value : "";
  const m = /^(\d{4})-(\d{2})$/.exec(stored);
  const [year, setYear] = React.useState(m ? m[1] : "");
  const [month, setMonth] = React.useState(m ? m[2] : "");

  // an outside change (piped default, a reset) wins over the local drafts
  React.useEffect(() => {
    if (!m) return;
    setYear(m[1]);
    setMonth(m[2]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  /** Half a date is not a date — nothing stores until both halves are chosen. */
  const commit = (mm: string, yy: string) => {
    p.onChange(mm && yy ? `${yy}-${mm}` : null);
  };

  return (
    <div className="rs-monthyear" data-testid="monthyear">
      <label className="rs-my-field">
        <span>Month</span>
        <select className="rs-select" data-testid="my-month" value={month}
          disabled={s.readOnly}
          onChange={(e) => { setMonth(e.target.value); commit(e.target.value, year); }}>
          <option value="">— Month —</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={String(i + 1).padStart(2, "0")}>{name}</option>
          ))}
        </select>
      </label>
      <label className="rs-my-field">
        <span>Year</span>
        <select className="rs-select" data-testid="my-year" value={year}
          disabled={s.readOnly}
          onChange={(e) => { setYear(e.target.value); commit(month, e.target.value); }}>
          <option value="">— Year —</option>
          {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
        </select>
      </label>
      <span className="rs-my-value" data-testid="my-value">
        {stored ? `${MONTHS[Number(stored.slice(5, 7)) - 1]} ${stored.slice(0, 4)}` : "—"}
      </span>
    </div>
  );
}

registerVariantRenderer("calendar", CalendarPick);
registerVariantRenderer("monthyear", MonthYearPick);
