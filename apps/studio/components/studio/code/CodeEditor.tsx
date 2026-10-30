"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { scriptLiteralRefs } from "@rescript/engine";
import type { CodeLanguage } from "@/lib/code/format.ts";
import type { CodeKind, GateVerdict } from "@/lib/code/types.ts";
import { codeCompletions } from "@/lib/code/completions.ts";
import { fieldDiagnostics, gateFor } from "@/lib/code/diagnostics.ts";
import type { EditorHandle } from "./codeEditorSetup";

/**
 * THE STUDIO'S CODE EDITOR (S3a; audit MM-01) — every place survey code is typed: behaviour scripts (all five
 * Styles-animations-&-scripts mount points), Scripts-panel logic scripts, a Custom Component's JavaScript and HTML,
 * Branding's header / footer HTML and custom CSS, a question's custom CSS, a style's scoped CSS.
 *
 * It is a CONTROLLED field like the textarea it replaces: `value` in, `onChange` per keystroke, `onCommit` when the
 * field is left (blur out of the whole editor, toolbar included) or on Mod-S — the caller saves there, through its own
 * gate, exactly as before. The editor's undo is its own (the Studio's ⌘Z skips a focused contentEditable); a commit
 * is one ordinary, labelled Studio edit.
 *
 * CodeMirror is loaded LAZILY (`import("./codeEditorSetup")`): until it arrives — or if it never does (offline, a
 * blocked chunk) — the field is a plain textarea with the same test id, value and save behaviour
 * (`data-editor="loading" | "ready" | "fallback"` on the wrapper says which).
 */
export interface CodeEditorProps {
  value: string;
  onChange(v: string): void;
  /** leave the field / Mod-S: save through the field's own gate */
  onCommit?(): void;
  language: CodeLanguage;
  /** what the completion and the lint markers are for (defaults: js → ux, css → css, html → html) */
  kind?: CodeKind;
  /** the survey, for completion of its names */
  def?: SurveyDefinition;
  /** the field's own gate, run (debounced) while typing; its findings become markers */
  gate?: (code: string) => GateVerdict;
  readOnly?: boolean;
  label: string;
  testId?: string;
  placeholder?: string;
  minHeight?: number;
  /** extra header content (the script-health chip) */
  header?: React.ReactNode;
  /** show what the script reads and writes (S2b scriptRefs) in the header */
  showRefs?: boolean;
}

type Load = "loading" | "ready" | "fallback";
let loader: Promise<typeof import("./codeEditorSetup")> | null = null;
/** test hook: `window.__rsBlockCodeEditor = true` before the page loads makes the chunk "fail" (the offline fallback) */
function loadSetup() {
  if (typeof window !== "undefined" && (window as unknown as { __rsBlockCodeEditor?: boolean }).__rsBlockCodeEditor) return Promise.reject(new Error("code editor blocked"));
  loader = loader ?? import("./codeEditorSetup").catch((e) => { loader = null; throw e; });
  return loader;
}

export function CodeEditor(p: CodeEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const wrap = React.useRef<HTMLDivElement>(null);
  /* Esc leaves the editor to here (always enabled, after the editor in tab order) */
  const toolbar = React.useRef<HTMLButtonElement>(null);
  const ed = React.useRef<EditorHandle | null>(null);
  const [state, setState] = React.useState<Load>("loading");
  const [full, setFull] = React.useState(false);
  const [formatted, setFormatted] = React.useState<string | null>(null);
  /* the latest props, read by the editor's callbacks (created once) */
  const latest = React.useRef(p);
  latest.current = p;
  const fullRef = React.useRef(full);
  fullRef.current = full;
  const kind: CodeKind = p.kind ?? (p.language === "js" ? "ux" : p.language);

  React.useEffect(() => {
    let cancelled = false;
    loadSetup().then((m) => {
      if (cancelled || !host.current) return;
      ed.current = m.createEditor(host.current, {
        value: latest.current.value, language: p.language, readOnly: !!p.readOnly, label: p.label, testId: p.testId, placeholder: p.placeholder,
        onChange: (v) => latest.current.onChange(v),
        onCommit: () => latest.current.onCommit?.(),
        onEscape: () => { if (fullRef.current) { setFull(false); return; } toolbar.current?.focus(); },
        /* completion of the platform's names (rs api, ctx helpers, el/api, hooks) and the survey's (codes, options) */
        complete: p.language === "js" ? (doc, pos, explicit) => codeCompletions(kind, latest.current.def, doc, pos, explicit) : undefined,
        /* the field's real gate (or the kind's default), debounced by the linter, its sentences mapped to positions */
        lint: (doc, syntaxAt) => fieldDiagnostics(doc, kind, latest.current.gate ?? gateFor(kind, latest.current.def), syntaxAt),
      });
      setState("ready");
    }).catch(() => { if (!cancelled) setState("fallback"); });
    return () => { cancelled = true; ed.current?.destroy(); ed.current = null; };
    // the editor is created once per mount; later props are read through `latest`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => { ed.current?.setValue(p.value); }, [p.value, state]);
  React.useEffect(() => { ed.current?.setReadOnly(!!p.readOnly); }, [p.readOnly, state]);
  React.useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [full]);

  const onBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && wrap.current?.contains(to)) return;
    p.onCommit?.();
  };
  const refs = React.useMemo(() => {
    if (!p.showRefs || p.language !== "js") return null;
    const all = scriptLiteralRefs(p.value);
    const uniq = (w: boolean) => [...new Set(all.filter((r) => r.write === w).map((r) => r.name))];
    return { reads: uniq(false), writes: uniq(true) };
  }, [p.showRefs, p.language, p.value]);

  return (
    <div ref={wrap} className={`code-editor${full ? " full" : ""}`} data-code-editor={p.testId ?? ""} data-editor={state} data-kind={kind}
      onBlur={onBlur}
      /* Esc anywhere in a full-screen editor (its toolbar too) leaves full screen; inside the editor CodeMirror handles it first */
      onKeyDown={(e) => { if (e.key === "Escape" && full && !e.defaultPrevented) { e.preventDefault(); setFull(false); } }}
      role={full ? "dialog" : undefined} aria-modal={full || undefined} aria-label={full ? p.label : undefined}>
      {(refs || p.header) && (
        <div className="code-editor-head">
          {p.header}
          {refs && (
            <span className="code-editor-refs muted" data-testid="code-editor-refs">
              {refs.reads.length ? <>reads <b className="mono">{refs.reads.join(", ")}</b></> : "reads nothing named"}
              {" · "}
              {refs.writes.length ? <>writes <b className="mono">{refs.writes.join(", ")}</b></> : "writes nothing"}
            </span>
          )}
        </div>
      )}
      {state === "ready" ? null : (
        <textarea className="ta code-fallback" value={p.value} disabled={p.readOnly} spellCheck={false} aria-label={p.label}
          placeholder={p.placeholder} data-testid={p.testId} style={{ minHeight: p.minHeight ?? 90 }}
          onChange={(e) => p.onChange(e.target.value)} />
      )}
      <div ref={host} className="code-editor-host" style={{ display: state === "ready" ? undefined : "none", ["--code-min-h" as string]: `${p.minHeight ?? 90}px` }} />
      <div className="code-editor-bar">
        {state === "ready" ? (
          <>
            <button type="button" className="btn sm ghost" data-testid="code-editor-format" disabled={p.readOnly}
              title="Re-indent every line from the code's structure (Enter's rule). It does not reflow or rewrite code."
              onClick={() => { const before = ed.current?.view.state.doc.toString(); ed.current?.format(); setFormatted(before !== ed.current?.view.state.doc.toString() ? "re-indented" : "already indented"); ed.current?.focus(); }}>Format (re-indent)</button>
            <button ref={toolbar} type="button" className="btn sm ghost" data-testid="code-editor-full" aria-pressed={full}
              onClick={() => { setFull((v) => !v); setTimeout(() => ed.current?.focus(), 0); }}>{full ? "Exit full screen" : "Full screen"}</button>
            {formatted && <span className="muted" data-testid="code-editor-formatted">{formatted}</span>}
            <span className="grow" />
            <span className="muted code-editor-keys">⌘/Ctrl-S save · ⌘/Ctrl-F find · ⌘/Ctrl-H replace · Esc leaves</span>
          </>
        ) : state === "fallback" ? (
          <span className="muted" data-testid="code-editor-fallback">The code editor could not load — a plain text box is used; saving works the same.</span>
        ) : null}
      </div>
    </div>
  );
}
