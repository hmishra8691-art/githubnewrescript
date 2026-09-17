"use client";
import React from "react";
import type { CodeLanguage } from "@rescript/interviews";

/**
 * THE EDITOR, LOADED ONLY WHEN A QUESTION NEEDS IT.
 *
 * CodeMirror 6 is the first editor dependency in this repository. It is
 * imported dynamically inside an effect rather than at module top so that a
 * candidate sitting an interview with no code question never downloads it —
 * the interview bundle is measured, and video candidates on a phone are the
 * ones the size falls on. While it loads, and if it ever fails to load, a
 * plain `<textarea>` with the same value and the same handlers takes its
 * place: the candidate can always type, and the answer route never learns
 * which one they used.
 *
 * What the editor is for here: line numbers, bracket matching, indentation
 * that survives Enter, and highlighting for the chosen language. What it is
 * not: an execution environment, a linter, or an autocomplete that would put
 * words in the candidate's answer. Autocompletion is disabled deliberately —
 * an interview is asking what the person knows.
 *
 * `onPaste` reports the pasted length so the telemetry row for a code answer
 * can say "412 characters were pasted" rather than just "paste". That is a
 * fact for a reviewer to weigh, not a verdict; the wording lives in
 * `telemetry.ts`.
 */
export function CodeEditor({ value, language, onChange, onPaste, disabled, placeholder, maxChars, testId }: {
  value: string;
  language: CodeLanguage;
  onChange: (next: string) => void;
  onPaste?: (chars: number) => void;
  disabled?: boolean;
  placeholder?: string;
  maxChars?: number;
  testId?: string;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<import("@codemirror/view").EditorView | null>(null);
  const langCompartment = React.useRef<import("@codemirror/state").Compartment | null>(null);
  const editableCompartment = React.useRef<import("@codemirror/state").Compartment | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "fallback">("loading");
  const latest = React.useRef({ value, onChange, onPaste });
  latest.current = { value, onChange, onPaste };

  /* mount */
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ EditorState, Compartment }, { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, placeholder: ph }, { defaultKeymap, history, historyKeymap, indentWithTab }, { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle }]
          = await Promise.all([
            import("@codemirror/state"), import("@codemirror/view"), import("@codemirror/commands"), import("@codemirror/language"),
          ]);
        if (cancelled || !host.current) return;
        const lang = new Compartment();
        const editable = new Compartment();
        langCompartment.current = lang;
        editableCompartment.current = editable;
        const state = EditorState.create({
          doc: latest.current.value,
          extensions: [
            lineNumbers(), highlightActiveLine(), drawSelection(), history(),
            bracketMatching(), indentOnInput(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
            lang.of(await languageExtension(language)),
            editable.of([EditorView.editable.of(!disabled), EditorState.readOnly.of(!!disabled)]),
            placeholder ? ph(placeholder) : [],
            EditorView.updateListener.of((u) => { if (u.docChanged) latest.current.onChange(u.state.doc.toString()); }),
            EditorView.domEventHandlers({
              paste: (e) => {
                const text = e.clipboardData?.getData("text") ?? "";
                if (text) latest.current.onPaste?.(text.length);
                return false;
              },
            }),
            EditorView.theme({
              "&": { fontSize: "14px", border: "1px solid var(--line)", borderRadius: "8px", background: "var(--card, #fff)" },
              ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", minHeight: "220px" },
              ".cm-scroller": { maxHeight: "60vh", overflow: "auto" },
              "&.cm-focused": { outline: "2px solid var(--accent)" },
            }),
          ],
        });
        viewRef.current = new EditorView({ state, parent: host.current });
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("fallback");
      }
    })();
    return () => { cancelled = true; viewRef.current?.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* language changes */
  React.useEffect(() => {
    const view = viewRef.current; const c = langCompartment.current;
    if (!view || !c) return;
    let stale = false;
    languageExtension(language).then((ext) => { if (!stale && viewRef.current) viewRef.current.dispatch({ effects: c.reconfigure(ext) }); });
    return () => { stale = true; };
  }, [language]);

  /* enabled / disabled */
  React.useEffect(() => {
    const view = viewRef.current; const c = editableCompartment.current;
    if (!view || !c) return;
    (async () => {
      const [{ EditorView }, { EditorState }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state")]);
      if (viewRef.current) viewRef.current.dispatch({ effects: c.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(!!disabled)]) });
    })();
  }, [disabled]);

  /* external value changes (a reload restored the answer; a retake cleared it) */
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  const over = maxChars !== undefined && value.length > maxChars;

  return (
    <div data-testid={testId ?? "code-editor"} data-editor={status}>
      {status !== "ready" && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t) onPaste?.(t.length); }}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          rows={12}
          data-testid="code-fallback"
          style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14, tabSize: 2, whiteSpace: "pre" }}
        />
      )}
      <div ref={host} style={{ display: status === "ready" ? "block" : "none" }} />
      {maxChars !== undefined && (
        <div className={`tiny ${over ? "warn" : "muted"}`} style={{ marginTop: 4, textAlign: "right" }} data-testid="code-length">
          {value.length.toLocaleString()} / {maxChars.toLocaleString()} characters
        </div>
      )}
    </div>
  );
}

/**
 * One language package per language, each its own chunk. `csharp` has no
 * first-party CodeMirror 6 mode, so it uses the legacy stream mode; `plain`
 * is no highlighting at all, which is honest about what pseudocode is.
 */
async function languageExtension(language: CodeLanguage): Promise<import("@codemirror/state").Extension> {
  switch (language) {
    case "javascript": return (await import("@codemirror/lang-javascript")).javascript();
    case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "python": return (await import("@codemirror/lang-python")).python();
    case "java": return (await import("@codemirror/lang-java")).java();
    case "cpp": return (await import("@codemirror/lang-cpp")).cpp();
    case "go": return (await import("@codemirror/lang-go")).go();
    case "rust": return (await import("@codemirror/lang-rust")).rust();
    case "sql": return (await import("@codemirror/lang-sql")).sql();
    case "csharp": {
      const [{ StreamLanguage }, { csharp }] = await Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/clike")]);
      return StreamLanguage.define(csharp);
    }
    case "plain":
    default:
      return [];
  }
}
