"use client";
import React from "react";
import { renameImpact, applyRename } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * A variable-name field that renames SAFELY (§44, phase 3).
 *
 * The question editor and the calculation editor both used to write straight
 * into the definition on every keystroke — `patch({ variableName: … })` — so
 * renaming `GENDER` to `SEX` left every rule, pipe and expression still
 * naming `GENDER`. Mostly those kept resolving, through the question's code,
 * so nothing looked wrong until the code was edited weeks later.
 *
 * The safe rename existed after phase 2 but only the Variables tab used it,
 * which is the worst arrangement available: the careful path is there and the
 * path people actually take goes around it. This is that fix.
 *
 * Two things make it work as a text field rather than a dialog:
 *
 *  - it holds a LOCAL draft while typing and commits on blur or Enter. A
 *    rename per keystroke would rewrite the survey once per character, and
 *    `GENDE` is a rename as far as the engine is concerned.
 *  - a refused rename keeps what you typed and says why, instead of silently
 *    snapping back to the old name and leaving you wondering.
 */
export function VariableNameInput({
  name,
  testId,
  style,
  placeholder,
  autoFocus,
  onDone,
  inputClassName,
}: {
  name: string;
  testId?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  /** focus and select on mount — for a cell editor that appears on Enter */
  autoFocus?: boolean;
  /** called after a commit or an Escape, so a host can leave edit mode */
  onDone?(): void;
  inputClassName?: string;
}) {
  const s = useStudio();
  const [draft, setDraft] = React.useState(name);
  const [error, setError] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState(false);

  // follow the definition when it changes underneath us (undo, JSON edit, a
  // template applied on another tab)
  React.useEffect(() => { setDraft(name); setError(null); }, [name]);

  const target = draft.trim();
  const dirty = target !== name && target.length > 0;

  const impact = React.useMemo(() => {
    if (!dirty) return null;
    try {
      return renameImpact(s.def, name, target);
    } catch {
      return null;
    }
  }, [s.def, name, target, dirty]);

  /*
   * The value is taken from the FIELD, and the impact recomputed here, rather
   * than read from the memo above.
   *
   * `onBlur` fires with whatever closure the last render produced. Type a new
   * name and tab straight out — which is what people do — and the handler can
   * still be holding `dirty: false` from before the keystroke, in which case
   * it resets the box to the old name and reports nothing. The field looked
   * like it silently refused the edit. Recomputing from `value` makes the
   * commit independent of render timing.
   */
  const commit = (value: string) => {
    setFocused(false);
    const to = value.trim();
    if (!to || to === name) { setDraft(name); setError(null); onDone?.(); return; }

    let verdict;
    try {
      verdict = renameImpact(s.def, name, to);
    } catch {
      setError("That name cannot be used.");
      return;
    }
    if (!verdict.ok) {
      setError(verdict.blockers[0] ?? "That name cannot be used.");
      return;
    }
    setError(null);
    s.labelNextEdit(`rename ${name} to ${to}`);
    s.update((d) => {
      const next = applyRename(d, name, to, { alsoCode: false });
      for (const k of Object.keys(d)) delete (d as any)[k];
      Object.assign(d, next);
    });
    onDone?.();
  };

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, ...style }}>
      <input
        className={`input mono${error ? " err" : ""}${inputClassName ? ` ${inputClassName}` : ""}`}
        data-testid={testId}
        value={draft}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={(e) => { setFocused(true); if (autoFocus) e.target.select(); }}
        onChange={(e) => {
          setDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"));
          setError(null);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") { setDraft(name); setError(null); (e.target as HTMLInputElement).blur(); onDone?.(); }
        }}
      />
      {error && (
        <span className="muted" data-testid={testId ? `${testId}-error` : undefined}
          style={{ fontSize: 11.5, color: "var(--danger, #b4232a)" }}>{error}</span>
      )}
      {!error && focused && dirty && impact?.ok && (
        <span className="muted" data-testid={testId ? `${testId}-hint` : undefined} style={{ fontSize: 11.5 }}>
          {impact.usages.length} reference{impact.usages.length === 1 ? "" : "s"} will be updated
          {impact.aliasedByCode ? " — the question code still says the old name" : ""}
        </span>
      )}
    </span>
  );
}
