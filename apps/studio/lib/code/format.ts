import { EditorState, type Extension } from "@codemirror/state";
import { ensureSyntaxTree, indentRange, indentUnit } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";

/**
 * THE CODE EDITOR'S "FORMAT" BUTTON (S3a item 1) — honestly a RE-INDENT, not a formatter.
 *
 * It re-computes every line's leading whitespace from the language's syntax tree (CodeMirror's `indentRange`, the same
 * rule Enter uses) and trims trailing spaces. It never moves code between lines, never adds or removes semicolons,
 * quotes or braces, and never touches the inside of a string or comment line — so it cannot change what the code
 * does. A full formatter (Prettier) is not a dependency of this product.
 */
export type CodeLanguage = "js" | "css" | "html";

export function languageExtension(language: CodeLanguage): Extension {
  return language === "css" ? css() : language === "html" ? html() : javascript();
}

/** the re-indented text, or the text unchanged when the parser could not finish in time */
export function reindent(code: string, language: CodeLanguage, unit = "  "): string {
  const state = EditorState.create({ doc: code, extensions: [languageExtension(language), indentUnit.of(unit)] });
  return reindentState(state) ?? code;
}

/** the changes `reindent` makes, for an editor that holds `state` (null when the tree is not ready) */
export function reindentChanges(state: EditorState) {
  if (!ensureSyntaxTree(state, state.doc.length, 2000)) return null;
  const indent = indentRange(state, 0, state.doc.length);
  const next = state.update({ changes: indent }).state;
  // trailing whitespace, line by line, on the re-indented text
  const trims: { from: number; to: number }[] = [];
  for (let n = 1; n <= next.doc.lines; n++) {
    const line = next.doc.line(n);
    const m = /[ \t]+$/.exec(line.text);
    if (m) trims.push({ from: line.from + m.index, to: line.to });
  }
  return { indent, trims };
}

function reindentState(state: EditorState): string | null {
  const c = reindentChanges(state);
  if (!c) return null;
  const next = state.update({ changes: c.indent }).state;
  return next.update({ changes: c.trims }).state.doc.toString();
}
