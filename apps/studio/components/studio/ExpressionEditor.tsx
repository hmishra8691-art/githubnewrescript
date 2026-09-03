"use client";
import React from "react";
import type { Condition } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, referenceTree,
  type ReferenceNode, type ExpressionError,
} from "@rescript/engine";
import { useStudio } from "./store";

/**
 * The expression editor: the same logic, written instead of assembled.
 *
 * It is a second way to WRITE the canonical tree, never a second logic
 * system — text is parsed into the very `Condition` the visual builder
 * produces, and the tree is printed back when the editor opens. Nothing
 * stores an expression, so the two views cannot drift apart (reqs §13–15,
 * §21–22).
 *
 * Text is only committed when it parses. Half-typed logic stays local, so a
 * survey can never hold something the evaluator would choke on, and the
 * visual builder is never handed a broken tree.
 */

/* ------------------------------------------------------------- the picker */

/** One branch of the survey structure: click to insert, or drag it in. */
function RefBranch({ node, depth, onInsert }: {
  node: ReferenceNode; depth: number; onInsert(token: string): void;
}) {
  const [open, setOpen] = React.useState(depth === 0 ? false : true);
  const hasKids = !!node.children?.length;
  return (
    <div className="xr-branch" style={{ paddingLeft: depth ? 10 : 0 }}>
      <div className="xr-row">
        {hasKids ? (
          <button className="xr-twisty" onClick={() => setOpen((v) => !v)}
            title={open ? "Collapse" : "Expand"}>{open ? "▾" : "▸"}</button>
        ) : <span className="xr-twisty" />}
        <button
          className={`xr-token kind-${node.kind}`}
          data-testid="xr-token"
          data-token={node.token}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", node.token);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => onInsert(node.token)}
          title={`Insert ${node.token}`}
        >
          <span className="xr-code">{node.token}</span>
          <span className="xr-label">{node.label}</span>
        </button>
      </div>
      {open && hasKids && (
        <div>
          {node.children!.map((c) => (
            <RefBranch key={c.token} node={c} depth={depth + 1} onInsert={onInsert} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the editor */

const OPERATOR_CHIPS = ["AND", "OR", "NOT", "(", ")"];

export function ExpressionEditor({ value, onChange, perOption }: {
  value: Condition;
  onChange(c: Condition): void;
  perOption?: boolean;
}) {
  const s = useStudio();
  const area = React.useRef<HTMLTextAreaElement>(null);

  /** The tree, printed. Recomputed when the tree changes underneath us. */
  const printed = React.useMemo(
    () => formatCondition(s.def, value, { pretty: true }),
    [s.def, value],
  );

  const [text, setText] = React.useState(printed);
  const [dirty, setDirty] = React.useState(false);
  const [filter, setFilter] = React.useState("");

  // when the tree changes elsewhere (visual builder, undo), show it — but
  // never overwrite what is being typed
  React.useEffect(() => {
    if (!dirty) setText(printed);
  }, [printed, dirty]);

  const result = React.useMemo(
    () => parseLogicExpression(s.def, text, { perOption }),
    [s.def, text, perOption],
  );

  /** Commit only a clean parse — a broken expression stays in the box. */
  const commit = React.useCallback((next: string) => {
    const parsed = parseLogicExpression(s.def, next, { perOption });
    if (parsed.errors.length > 0) return false;
    s.labelNextEdit?.("edit expression");
    onChange(parsed.condition ?? { type: "group", op: "and", children: [] });
    setDirty(false);
    return true;
  }, [s, onChange, perOption]);

  const apply = () => { if (commit(text)) setText(formatCondition(s.def, parseLogicExpression(s.def, text, { perOption }).condition, { pretty: true })); };

  /** Insert at the caret, keeping spacing sane, then re-apply if it parses. */
  const insert = (token: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const needsSpaceBefore = before.length > 0 && !/[\s(]$/.test(before);
    const needsSpaceAfter = after.length > 0 && !/^[\s)]/.test(after);
    const piece = `${needsSpaceBefore ? " " : ""}${token}${needsSpaceAfter ? " " : ""}`;
    const next = `${before}${piece}${after}`;
    setText(next);
    setDirty(true);
    const caret = start + piece.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
    commit(next);
  };

  /** Wrap the selection — or the whole expression — in brackets (req §17). */
  const wrapSelection = () => {
    const el = area.current;
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? 0;
    const hasSel = end > start;
    const from = hasSel ? start : 0;
    const to = hasSel ? end : text.length;
    const next = `${text.slice(0, from)}(${text.slice(from, to).trim()})${text.slice(to)}`;
    setText(next);
    setDirty(true);
    commit(next);
    requestAnimationFrame(() => el?.focus());
  };

  /* ------------------------------------------------------- autocomplete */

  /**
   * Suggestions for the reference being typed (req §8). The word under the
   * caret is matched against every token the survey offers, so only real
   * references are ever proposed.
   */
  const suggestions = React.useMemo(() => {
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const word = /[@A-Za-z0-9_.$-]*$/.exec(text.slice(0, caret))?.[0] ?? "";
    if (word.length === 0) return [];
    const flat: string[] = [];
    const walk = (ns: ReferenceNode[]) => {
      for (const n of ns) {
        flat.push(n.token);
        if (n.children) walk(n.children);
      }
    };
    walk(referenceTree(s.def));
    const lower = word.toLowerCase();
    return flat
      .filter((t) => t.toLowerCase().startsWith(lower) && t.toLowerCase() !== lower)
      .slice(0, 8)
      .map((t) => ({ token: t, replaces: word }));
  }, [text, s.def]);

  const acceptSuggestion = (token: string, replaces: string) => {
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, caret - replaces.length)}${token}${text.slice(caret)}`;
    setText(next);
    setDirty(true);
    const pos = caret - replaces.length + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
    commit(next);
  };

  /* ------------------------------------------------------------- render */

  const tree = referenceTree(s.def);
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? tree.filter((n) =>
        n.token.toLowerCase().includes(f) || n.label.toLowerCase().includes(f) ||
        (n.children ?? []).some((c) =>
          c.token.toLowerCase().includes(f) || c.label.toLowerCase().includes(f)))
    : tree;

  return (
    <div className="expr-editor" data-testid="expression-editor">
      <div className="xe-chips">
        {OPERATOR_CHIPS.map((c) => (
          <button key={c} className="xe-chip" data-testid={`xe-chip-${c}`}
            title={`Insert ${c} at the cursor`} onClick={() => insert(c)}>{c}</button>
        ))}
        <button className="xe-chip wide" data-testid="xe-wrap"
          title="Wrap the selected part — or everything — in brackets"
          onClick={wrapSelection}>( … ) wrap</button>
        <span className="grow" />
        <button className="btn small" data-testid="xe-format"
          title="Re-print from the saved logic" onClick={apply}
          disabled={result.errors.length > 0}>tidy up</button>
      </div>

      <textarea
        ref={area}
        className="ta code xe-input"
        data-testid="xe-input"
        spellCheck={false}
        rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
        value={text}
        placeholder={"Q1.brandA AND (Q2.R1.C2 OR Q3 > 25)\n\nDrag a reference in from the list below, or click one."}
        onChange={(e) => { setText(e.target.value); setDirty(true); commit(e.target.value); }}
        onBlur={() => { if (result.errors.length === 0) commit(text); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDrop={(e) => {
          const token = e.dataTransfer.getData("text/plain");
          if (!token) return;
          e.preventDefault();
          // drop at the caret the pointer is over when the browser gives us one
          const el = e.currentTarget;
          const pos = (document as any).caretPositionFromPoint?.(e.clientX, e.clientY)?.offset
            ?? el.selectionStart ?? text.length;
          el.setSelectionRange(pos, pos);
          insert(token);
        }}
      />

      {suggestions.length > 0 && (
        <div className="xe-suggest" data-testid="xe-suggest">
          {suggestions.map((sg) => (
            <button key={sg.token} className="xe-sugg" data-testid="xe-suggestion"
              onClick={() => acceptSuggestion(sg.token, sg.replaces)}>{sg.token}</button>
          ))}
        </div>
      )}

      {result.errors.map((e: ExpressionError, i) => (
        <div key={i} className="xe-error" data-testid="xe-error">
          ⚠ {e.message}{e.position != null ? ` (at character ${e.position + 1})` : ""}
        </div>
      ))}
      {result.errors.length === 0 && result.warnings.map((w, i) => (
        <div key={i} className="xe-warn" data-testid="xe-warning">⚠ {w.message}</div>
      ))}
      {result.errors.length > 0 && (
        <div className="muted xe-hint">
          The saved logic is unchanged until this reads correctly.
        </div>
      )}

      <div className="xe-picker">
        <div className="row" style={{ marginBottom: 4 }}>
          <span className="flabel" style={{ margin: 0 }}>Insert reference</span>
          <input className="input" style={{ maxWidth: 170 }} placeholder="search questions…"
            data-testid="xe-ref-search"
            value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="xe-tree">
          {filtered.map((n) => (
            <RefBranch key={n.token} node={n} depth={0} onInsert={insert} />
          ))}
          {filtered.length === 0 && (
            <span className="muted" style={{ fontSize: 11 }}>nothing matches “{filter}”</span>
          )}
        </div>
      </div>
    </div>
  );
}
