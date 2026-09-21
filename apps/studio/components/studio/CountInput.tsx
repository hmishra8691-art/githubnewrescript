"use client";
import React from "react";

/**
 * A numeric input for things that are COUNTED — selections, points, rows,
 * quota limits, "show N of M". None of these can be negative, and none can be
 * fractional, so the field refuses both instead of storing them and letting
 * the runtime work out what "select at least -5" means.
 *
 * Not for bounds on a respondent's VALUE (min/max of a numeric question, a
 * slider's range): those are legitimately negative — a temperature, a change
 * in spend — and keep the plain input.
 *
 * Typing is not fought: "-" on its own, or an emptied field, is left alone
 * until blur. Only a complete number below `min` is clamped, so the user
 * sees the correction as they type it rather than after.
 */
export function CountInput({
  value,
  onChange,
  min = 0,
  max,
  width = 90,
  allowEmpty = true,
  ...rest
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** lowest legal count — 0 by default; 1 where "none" is meaningless */
  min?: number;
  max?: number;
  width?: number;
  /** whether clearing the field means "unset" (true) or snaps back to `min` */
  allowEmpty?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type" | "width">) {
  // the text the user is mid-way through, when it is not yet a clean number
  const [draft, setDraft] = React.useState<string | null>(null);

  const clamp = (n: number) => {
    let v = Math.trunc(n);
    if (v < min) v = min;
    if (max != null && v > max) v = max;
    return v;
  };

  const commit = (text: string) => {
    if (text === "" || text === "-") {
      /*
       * AN EMPTIED FIELD STAYS EMPTIED UNTIL BLUR, even when the setting
       * itself cannot be empty.
       *
       * `allowEmpty: false` used to write `min` back the instant the box was
       * cleared, which put the old number straight back under the caret — so
       * the next keystroke APPENDED to it. The review found it on Image
       * Hotspot's Max Point Selection and described the symptom exactly: "we
       * cannot delete the existing 1 and enter a new number directly … we can
       * only append digits to it, such as 10, 11. The value can be changed
       * using the up/down arrows, but direct editing is not working."
       *
       * Clearing is now a legitimate intermediate state of typing — the draft
       * holds the empty box, nothing is stored, and `onBlur` resolves it to
       * `min` if the user really did leave it empty. Select-all-and-type,
       * backspace-then-type and the spinner all now do the obvious thing.
       */
      setDraft(text);
      if (text === "" && allowEmpty) onChange(undefined);
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) { setDraft(text); return; }
    setDraft(null);
    onChange(clamp(n));
  };

  return (
    <input
      {...rest}
      className={rest.className ?? "input"}
      style={{ width, ...(rest.style ?? {}) }}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={draft ?? (value == null ? "" : String(value))}
      onChange={(e) => commit(e.target.value)}
      onBlur={() => {
        // a lone "-", an emptied box or garbage resolves on the way out: a
        // setting that cannot be empty falls back to `min`, one that can is
        // simply unset
        const wasEmptied = draft === "" || draft === "-";
        setDraft(null);
        if (!allowEmpty && (value == null || wasEmptied)) onChange(min);
      }}
      onKeyDown={(e) => {
        // the keyboard can't produce a negative count either
        if (e.key === "-" && min >= 0) e.preventDefault();
      }}
    />
  );
}
