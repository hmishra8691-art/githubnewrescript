/**
 * THE CODE EDITOR'S CODEMIRROR SETUP (S3a). Loaded ONLY by `CodeEditor.tsx` through a dynamic `import()`, so the
 * CodeMirror bundle is a separate chunk that a page without a code field never downloads.
 *
 * What it builds: line numbers, active line, bracket matching and closing, indentation on Enter, fold gutter,
 * syntax highlighting (JavaScript / CSS / HTML), the search & replace panel (Mod-F, Mod-H), its own undo history
 * (Mod-Z / Mod-Shift-Z / Mod-Y — the Studio's ⌘Z leaves a focused editor alone: `store.tsx` skips contentEditable),
 * completion fed by the caller (the platform's names, `lib/code/completions.ts`), lint markers fed by the caller (the
 * real gates, `lib/code/diagnostics.ts`), read-only mode, and the Studio's colours.
 *
 * Keyboard: Tab is NOT captured (it moves focus, like the textarea it replaces — so the editor is never a tab trap;
 * indent with Mod-] / Mod-[ or let Enter indent). Esc closes the completion list or the search panel first; with
 * neither open it leaves the editor (focus moves to the editor's toolbar). Mod-S commits the field (as leaving it
 * does). Nothing here writes to the survey: the caller's `onCommit` does, through the field's own gate.
 */
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  highlightSpecialChars, placeholder as placeholderExt,
} from "@codemirror/view";
import {
  bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle,
  syntaxTree,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, redo, undo } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, openSearchPanel, search } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { linter, lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { localCompletionSource } from "@codemirror/lang-javascript";
import { languageExtension, reindentChanges, type CodeLanguage } from "@/lib/code/format.ts";
import type { CodeDiagnostic, CompletionAt } from "@/lib/code/types.ts";

export interface EditorHandle {
  view: EditorView;
  setValue(v: string): void;
  setReadOnly(v: boolean): void;
  format(): boolean;
  /** S3b: run the linter now (markers from a test run arrived) */
  relint(): void;
  /** S3b: insert text at the cursor (a snippet from the menu); false when read-only */
  insert(text: string): boolean;
  focus(): void;
  destroy(): void;
}

export interface EditorOptions {
  value: string;
  language: CodeLanguage;
  readOnly: boolean;
  label: string;
  testId?: string;
  placeholder?: string;
  onChange(v: string): void;
  onCommit(): void;
  /** Esc with nothing to close: leave the editor */
  onEscape(): void;
  /** the platform completion source (JS kinds); CSS / HTML keep the language's own */
  complete?: (doc: string, pos: number, explicit: boolean) => CompletionAt | null;
  /** the gate's findings as positioned diagnostics; `syntaxErrorAt` is where the parser first gave up, if anywhere */
  lint?: (doc: string, syntaxErrorAt: number | null) => CodeDiagnostic[];
}

/* the default palette, lightened for a dark Studio (no extra theme package: the same tags, other colours) */
const DARK: Record<string, string> = {
  "#708": "#c792ea", "#219": "#82aaff", "#164": "#c3e88d", "#a11": "#f78c6c", "#00f": "#82aaff", "#30a": "#c792ea",
  "#085": "#89ddff", "#167": "#ffcb6b", "#256": "#89ddff", "#00c": "#82aaff", "#940": "#ffcb6b", "#f00": "#ff5370",
  "#555": "#b2ccd6", "#999": "#7f8c98", "#05a": "#82aaff", "#e40": "#f78c6c", "#117": "#c792ea", "#221199": "#82aaff",
};
const darkHighlight = HighlightStyle.define(
  defaultHighlightStyle.specs.map((s) => ({ ...s, ...(typeof s.color === "string" ? { color: DARK[s.color] ?? s.color } : {}) })),
);

/** is the Studio drawn dark? (read from its own background: the Studio has one theme today, so this is future-proofing) */
export function studioIsDark(el: HTMLElement): boolean {
  const bg = getComputedStyle(el).backgroundColor || getComputedStyle(document.body).backgroundColor;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.45;
}

function studioTheme(dark: boolean): Extension {
  return [
    EditorView.theme({
      "&": { backgroundColor: "var(--panel, #fff)", color: "var(--text, #131a2b)", fontSize: "13px", border: "1px solid var(--border, #dde3ee)", borderRadius: "8px" },
      "&.cm-focused": { outline: "none", borderColor: "var(--accent, #4f46e5)", boxShadow: "0 0 0 3px rgba(79,70,229,.15)" },
      ".cm-content": { fontFamily: "var(--mono, ui-monospace, monospace)", caretColor: "var(--text, #131a2b)" },
      ".cm-gutters": { backgroundColor: "var(--panel2, #f0f3f9)", color: "var(--subtle, #6b7690)", borderRight: "1px solid var(--border, #dde3ee)", borderRadius: "8px 0 0 8px" },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,.04)" : "rgba(79,70,229,.05)" },
      ".cm-activeLineGutter": { backgroundColor: dark ? "rgba(255,255,255,.06)" : "rgba(79,70,229,.08)" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent, #4f46e5)", color: "#fff" },
      ".cm-completionDetail": { fontStyle: "normal", opacity: 0.75, marginLeft: "8px" },
      ".cm-panels": { backgroundColor: "var(--panel2, #f0f3f9)", color: "var(--text, #131a2b)" },
    }, { dark }),
    syntaxHighlighting(dark ? darkHighlight : defaultHighlightStyle, { fallback: true }),
  ];
}

/** where the parser first gave up (an error node in the syntax tree), or null */
function firstSyntaxError(state: EditorState): number | null {
  let at: number | null = null;
  syntaxTree(state).iterate({ enter: (n) => { if (at != null) return false; if (n.type.isError) { at = n.from; return false; } return undefined; } });
  return at;
}

export function createEditor(parent: HTMLElement, o: EditorOptions): EditorHandle {
  const readOnly = new Compartment();
  const silent = Transaction.addToHistory.of(false);
  let applyingExternal = false;
  const extensions: Extension[] = [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
    highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
    languageExtension(o.language),
    studioTheme(studioIsDark(parent)),
    readOnly.of([EditorState.readOnly.of(o.readOnly)]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": o.label, "aria-multiline": "true", ...(o.testId ? { "data-testid": o.testId } : {}), spellcheck: "false",
    }),
    o.placeholder ? placeholderExt(o.placeholder) : [],
    keymap.of([
      { key: "Mod-s", run: () => { o.onCommit(); return true; }, preventDefault: true },
      { key: "Mod-h", run: openSearchPanel, preventDefault: true },
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap,
      { key: "Mod-]", run: indentMore }, { key: "Mod-[", run: indentLess },
      { key: "Mod-y", run: redo, preventDefault: true }, { key: "Mod-z", run: undo },
      { key: "Escape", run: () => { o.onEscape(); return true; } },
    ]),
    EditorView.updateListener.of((u) => { if (u.docChanged && !applyingExternal) o.onChange(u.state.doc.toString()); }),
  ];
  if (o.complete) {
    const complete = o.complete;
    const platform = (ctx: CompletionContext): CompletionResult | null => {
      const r = complete(ctx.state.doc.toString(), ctx.pos, ctx.explicit);
      if (!r || !r.options.length) return null;
      return {
        from: r.from,
        options: r.options.map((x) => ({ label: x.label, type: x.type, detail: x.detail, info: x.info, apply: x.apply, boost: x.boost })),
        validFor: r.inString ? /^[^"'`\n]*$/ : /^[\w$]*$/,
      };
    };
    extensions.push(autocompletion({ override: o.language === "js" ? [platform, localCompletionSource] : [platform], activateOnTyping: true, icons: true }));
  } else {
    extensions.push(autocompletion());
  }
  const diagnosticsOf = (state: EditorState): Diagnostic[] => {
    if (!o.lint) return [];
    const doc = state.doc.toString();
    return o.lint(doc, firstSyntaxError(state)).map((d) => ({ from: Math.min(d.from, doc.length), to: Math.min(Math.max(d.to, d.from), doc.length), severity: d.severity, message: d.message, source: d.located ? undefined : "no position" }));
  };
  if (o.lint) extensions.push(lintGutter(), linter((view): Diagnostic[] => diagnosticsOf(view.state), { delay: 350 }));
  const view = new EditorView({ parent, state: EditorState.create({ doc: o.value, extensions }) });
  /* test and automation compatibility: the content element reads like the textarea it replaced (`el.value`) */
  Object.defineProperty(view.contentDOM, "value", { configurable: true, get: () => view.state.doc.toString() });
  return {
    view,
    setValue(v) {
      if (v === view.state.doc.toString()) return;
      applyingExternal = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v }, annotations: silent }); } finally { applyingExternal = false; }
    },
    setReadOnly(v) { view.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(v)]) }); },
    format() {
      if (view.state.readOnly) return false;
      const c = reindentChanges(view.state);
      if (!c) return false;
      view.dispatch({ changes: c.indent, userEvent: "input.format" });
      if (c.trims.length) view.dispatch({ changes: c.trims, userEvent: "input.format" });
      return true;
    },
    /* forceLinting only runs a lint that is already pending; new markers for an unchanged text are set directly */
    relint() { if (o.lint) view.dispatch(setDiagnostics(view.state, diagnosticsOf(view.state))); },
    insert(text) {
      if (view.state.readOnly) return false;
      const r = view.state.selection.main;
      /* a snippet starts on its own line, indented like the line it lands on */
      const line = view.state.doc.lineAt(r.from);
      const indent = /^\s*/.exec(line.text)![0];
      const lead = line.text.slice(0, r.from - line.from).trim() ? `\n${indent}` : "";
      const body = text.split("\n").map((l, i) => (i === 0 ? l : indent + l)).join("\n");
      view.dispatch({ changes: { from: r.from, to: r.to, insert: lead + body }, selection: { anchor: r.from + lead.length + body.length }, userEvent: "input.snippet" });
      view.focus();
      return true;
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}
