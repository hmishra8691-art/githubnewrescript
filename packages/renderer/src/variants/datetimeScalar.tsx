"use client";
import React from "react";
import { joinDuration, parseLocalDateTime, splitDuration, type DurationParts } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { FormattedDateField, NumberField } from "../QuestionRenderer";
import { TimeSelects } from "../TimeSelects";
import { registerVariantRenderer } from "./registry";

/**
 * DATE & TIME and DURATION (audit 2026-10-16, QT-12) — two scalar answers
 * the platform could only approximate with a Date/Time Range or a list's
 * `hours` field.
 *
 *   datetime   `datetime.datetime` on a `date` question — a date and a time
 *              of day, stored together as the ISO local date-time
 *              "YYYY-MM-DDTHH:MM" (":SS" with seconds shown). The date part
 *              follows the question's Date Format and the time part its Time
 *              Format, exactly as the two single pickers draw them.
 *   duration   `numeric.duration` on a `numeric` question — hours, minutes
 *              and seconds (or the parts `durationParts` names), stored as
 *              whole SECONDS so it sums, averages and exports as a number.
 *
 * Half an answer is no answer: a date with no time stores nothing, and the
 * engine says "Please enter a date and a time." if one arrives anyway.
 */

/* ---------------------------------------------------------- date & time */
export function DateTimeInput(p: QRProps) {
  const s = p.q.settings;
  const readOnly = !!s.readOnly;
  const parsed = parseLocalDateTime(p.value);
  const [draft, setDraft] = React.useState<{ date: string; time: string }>(() => ({ date: parsed?.date ?? "", time: parsed?.time ?? "" }));
  React.useEffect(() => {
    if (parsed) setDraft({ date: parsed.date, time: parsed.time });
  }, [String(p.value ?? "")]); // eslint-disable-line react-hooks/exhaustive-deps
  const emit = (next: { date: string; time: string }) => {
    setDraft(next);
    const time = next.time && /^\d{1,2}:\d{2}/.test(next.time) ? next.time.padStart(5, "0") : "";
    p.onChange(next.date && time ? `${next.date}T${time}` : null);
  };
  // a bound may carry a time; the date field can only narrow by day
  const minDay = s.minDate ? String(s.minDate).slice(0, 10) : undefined;
  const maxDay = s.maxDate ? String(s.maxDate).slice(0, 10) : undefined;
  return (
    <span className="rs-datetime" data-testid="datetime-input" style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {s.dateFormat ? (
        <FormattedDateField value={draft.date || null} fmt={s.dateFormat} readOnly={readOnly} min={minDay} max={maxDay}
          testid="datetime-date" label="Date" onChange={(d) => emit({ ...draft, date: d ?? "" })} />
      ) : (
        <input className="rs-input sm" type="date" aria-label="Date" data-testid="datetime-date" value={draft.date}
          min={minDay} max={maxDay} readOnly={readOnly} style={{ maxWidth: 190 }}
          onChange={(e) => emit({ ...draft, date: e.target.value })} />
      )}
      {s.timeFormat ? (
        <TimeSelects testid="datetime-time" label="Time" value={draft.time || null} readOnly={readOnly}
          hour12={s.timeFormat === "12"} seconds={!!s.showSeconds}
          onChange={(t) => emit({ ...draft, time: t ?? "" })} />
      ) : (
        <input className="rs-input sm" type="time" aria-label="Time" data-testid="datetime-time" value={draft.time}
          step={s.showSeconds ? 1 : undefined} readOnly={readOnly} style={{ maxWidth: 150 }}
          onChange={(e) => emit({ ...draft, time: e.target.value })} />
      )}
    </span>
  );
}

/* --------------------------------------------------------------- duration */
const PART_LABEL = { h: "hours", m: "minutes", s: "seconds" } as const;
const PART_UNIT = { h: "h", m: "min", s: "s" } as const;

export function DurationInput(p: QRProps) {
  const s = p.q.settings;
  const parts: DurationParts = s.durationParts ?? "hms";
  const shown = (parts === "hms" ? ["h", "m", "s"] : parts === "hm" ? ["h", "m"] : ["m", "s"]) as ("h" | "m" | "s")[];
  const split = splitDuration(p.value, parts);
  const [draft, setDraft] = React.useState<Record<"h" | "m" | "s", number | null>>(
    () => ({ h: split?.h ?? null, m: split?.m ?? null, s: split?.s ?? null }));
  React.useEffect(() => {
    const d = splitDuration(p.value, parts);
    if (d) setDraft({ h: d.h, m: d.m, s: d.s });
    else if (p.value == null || p.value === "") setDraft({ h: null, m: null, s: null });
  }, [String(p.value ?? ""), parts]); // eslint-disable-line react-hooks/exhaustive-deps
  const emit = (key: "h" | "m" | "s", v: number | null) => {
    const next = { ...draft, [key]: v };
    setDraft(next);
    p.onChange(joinDuration(shown.includes("h") ? next.h : null, next.m, shown.includes("s") ? next.s : null));
  };
  return (
    <span className="rs-duration" data-testid="duration-input" data-parts={parts}>
      {shown.map((k) => (
        <React.Fragment key={k}>
          <NumberField className="rs-input sm" ariaLabel={`Duration — ${PART_LABEL[k]}`} min={0} decimals={0}
            max={k !== shown[0] ? 59 : undefined} value={draft[k]} readOnly={!!s.readOnly} placeholder="0"
            style={{ width: "6ch" }} onChange={(v) => emit(k, v)} />
          <span className="rs-duration-unit" data-part={k}>{PART_UNIT[k]}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

registerVariantRenderer("datetime", DateTimeInput);
registerVariantRenderer("duration", DurationInput);
