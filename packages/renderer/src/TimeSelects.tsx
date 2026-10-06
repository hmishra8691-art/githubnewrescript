"use client";
import React from "react";

/**
 * A CLOCK TIME AS SELECTORS — hour, minute, optionally seconds, and AM/PM in
 * 12-hour form (October 2026 review: "use a proper time selector rather than
 * a normal text box … Hour, Minute, AM/PM"; "Time Format: 12-hour → 09:30 AM,
 * 24-hour → 09:30; Show/Hide Seconds"). Stored as 24-hour HH:MM or HH:MM:SS
 * whatever is shown, so a time answer means one thing everywhere.
 *
 * Used by the Time Picker and by a Numeric Range whose ends are times.
 */
export function TimeSelects({ value, onChange, label, readOnly, testid, hour12 = true, seconds = false }: {
  value: unknown; onChange(v: string | null): void; label: string; readOnly?: boolean; testid: string;
  hour12?: boolean; seconds?: boolean;
}) {
  const parse = (v: unknown) => {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v ?? ""));
    return m ? { h: Number(m[1]), m: Number(m[2]), s: Number(m[3] ?? 0) } : null;
  };
  const cur = parse(value);
  const [draft, setDraft] = React.useState<{ h: number | null; m: number | null; s: number | null }>(
    () => ({ h: cur?.h ?? null, m: cur?.m ?? null, s: cur?.s ?? null }));
  React.useEffect(() => { if (cur) setDraft({ h: cur.h, m: cur.m, s: cur.s }); }, [String(value ?? "")]); // eslint-disable-line react-hooks/exhaustive-deps
  const pad = (n: number) => String(n).padStart(2, "0");
  const set = (next: typeof draft) => {
    setDraft(next);
    if (next.h == null || next.m == null) return onChange(null);
    onChange(`${pad(next.h)}:${pad(next.m)}${seconds ? `:${pad(next.s ?? 0)}` : ""}`);
  };
  /* AM / PM is its own choice until an hour is picked, so toggling it never invents an hour */
  const [pmPick, setPmPick] = React.useState(cur ? cur.h >= 12 : false);
  const pm = draft.h != null ? draft.h >= 12 : pmPick;
  const h12 = draft.h == null ? null : draft.h % 12 === 0 ? 12 : draft.h % 12;
  return (
    <span className="rs-timesel" data-testid={testid} data-format={hour12 ? "12" : "24"}>
      {hour12 ? (
        <select className="rs-select sm" aria-label={`${label} — hour`} disabled={readOnly} data-part="hour"
          value={h12 ?? ""} onChange={(e) => {
            if (e.target.value === "") return set({ ...draft, h: null });
            const h = Number(e.target.value) % 12 + (pm ? 12 : 0);
            set({ ...draft, h, m: draft.m ?? 0 });
          }}>
          <option value="">hh</option>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{pad(h)}</option>)}
        </select>
      ) : (
        <select className="rs-select sm" aria-label={`${label} — hour`} disabled={readOnly} data-part="hour"
          value={draft.h ?? ""} onChange={(e) => set({ ...draft, h: e.target.value === "" ? null : Number(e.target.value), m: draft.m ?? 0 })}>
          <option value="">hh</option>
          {Array.from({ length: 24 }, (_, i) => i).map((h) => <option key={h} value={h}>{pad(h)}</option>)}
        </select>
      )}
      <span aria-hidden>:</span>
      <select className="rs-select sm" aria-label={`${label} — minute`} disabled={readOnly} data-part="minute"
        value={draft.m ?? ""} onChange={(e) => set({ ...draft, m: e.target.value === "" ? null : Number(e.target.value) })}>
        <option value="">mm</option>
        {Array.from({ length: 60 }, (_, i) => i).map((m) => <option key={m} value={m}>{pad(m)}</option>)}
      </select>
      {seconds && (
        <>
          <span aria-hidden>:</span>
          <select className="rs-select sm" aria-label={`${label} — seconds`} disabled={readOnly} data-part="second"
            value={draft.s ?? ""} onChange={(e) => set({ ...draft, s: e.target.value === "" ? 0 : Number(e.target.value) })}>
            <option value="">ss</option>
            {Array.from({ length: 60 }, (_, i) => i).map((x) => <option key={x} value={x}>{pad(x)}</option>)}
          </select>
        </>
      )}
      {hour12 && (
        <select className="rs-select sm" aria-label={`${label} — AM or PM`} disabled={readOnly} data-part="ampm"
          value={pm ? "PM" : "AM"} onChange={(e) => {
            const toPm = e.target.value === "PM";
            setPmPick(toPm);
            if (draft.h != null) set({ ...draft, h: (draft.h % 12) + (toPm ? 12 : 0) });
          }}>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      )}
    </span>
  );
}
