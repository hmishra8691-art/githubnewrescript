"use client";
import React from "react";
import type { Condition } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, referenceTree, mapRules, copyCondition, remapConditionReferences,
  type ReferenceNode, type ExpressionError, type ReferenceMap,
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
  /*
   * COPY IS EXACT; REMAP IS A SEPARATE, CONFIRMED STEP.
   * "Copy expression" puts the saved logic's text on the clipboard as it is —
   * pasting it anywhere reads the same questions, rows, columns and answers.
   * "Remap references…" is how a copy is deliberately pointed at other
   * questions: it lists what it would change and does nothing until applied.
   */
  const [remapOpen, setRemapOpen] = React.useState(false);
  const [remap, setRemap] = React.useState<Record<string, string>>({});
  const referenced = React.useMemo(() => {
    const ids = new Set<string>();
    mapRules(value, (r) => {
      if (r.source?.kind === "question" || r.source?.kind === "variable") {
        const q = s.def.questions.find((x) => x.id === r.source.ref || x.code === r.source.ref || x.variableName === r.source.ref);
        if (q) ids.add(q.id);
      }
      return r;
    });
    return [...ids];
  }, [value, s.def.questions]);
  const remapPlan = React.useMemo(() => {
    const questions: Record<string, string> = {};
    for (const [from, to] of Object.entries(remap)) if (to && to !== from) questions[from] = to;
    const map: ReferenceMap = { questions };
    return remapConditionReferences(copyCondition(value), map, s.def);
  }, [remap, value, s.def]);
  const copyExact = async () => {
    try { await navigator.clipboard.writeText(printed); s.toast("Expression copied exactly"); }
    catch { s.toast("Could not copy — select the text and copy it"); }
  };

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
    const tree = parsed.condition ?? { type: "group", op: "and", children: [] };
    /*
     * Nothing typed, nothing written. Re-parsing the printed text is the same
     * logic, but not always the same TREE (a multi-child NOT prints as
     * `NOT (a OR b)`), so committing it rewrote the stored shape — and added
     * an undo step — every time the box merely lost focus.
     */
    if (JSON.stringify(tree) === JSON.stringify(value)) { setDirty(false); return true; }
    s.labelNextEdit?.("edit expression");
    onChange(tree);
    setDirty(false);
    return true;
  }, [s, onChange, perOption, value]);

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
        <button className="btn small" data-testid="xe-copy"
          title="Copy this logic exactly as it is — the same questions, rows, columns and answers"
          onClick={copyExact}>copy expression</button>
        <button className="btn small" data-testid="xe-remap-toggle" aria-expanded={remapOpen}
          title="Point this logic at other questions — shows what changes and waits for you to apply it"
          onClick={() => setRemapOpen((v) => !v)}>remap references…</button>
        <button className="btn small" data-testid="xe-format"
          title="Re-print from the saved logic" onClick={apply}
          disabled={result.errors.length > 0}>tidy up</button>
      </div>

      {remapOpen && (
        <div className="card" style={{ padding: 8, margin: "6px 0" }} data-testid="xe-remap">
          <div className="flabel">Remap references — nothing changes until you apply</div>
          {referenced.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>This logic reads no questions.</div>}
          {referenced.map((id) => {
            const q = s.def.questions.find((x) => x.id === id)!;
            return (
              <div key={id} className="row" style={{ gap: 6, marginBottom: 4 }}>
                <span className="mono" style={{ minWidth: 70 }}>{q.code}</span>
                <span aria-hidden>→</span>
                <select className="select" data-testid={`xe-remap-${id}`} value={remap[id] ?? id}
                  onChange={(e) => setRemap((m) => ({ ...m, [id]: e.target.value }))}>
                  {s.def.questions.map((x) => <option key={x.id} value={x.id}>{x.code}{x.id === id ? " (unchanged)" : ""}</option>)}
                </select>
              </div>
            );
          })}
          <div className="muted" style={{ fontSize: 12.5 }} data-testid="xe-remap-preview">
            {remapPlan.changes.length ? `Will change: ${remapPlan.changes.join("; ")}` : "No changes yet."}
          </div>
          <button className="btn small primary" style={{ marginTop: 6 }} data-testid="xe-remap-apply"
            disabled={remapPlan.changes.length === 0}
            onClick={() => { s.labelNextEdit?.("remap references"); onChange(remapPlan.value); setRemap({}); setRemapOpen(false); setDirty(false); }}>
            apply remap
          </button>
        </div>
      )}

      <textarea
        ref={area}
        className="ta code xe-input"
        data-testid="xe-input"
        spellCheck={false}
        rows={Math.min(10, Math.max(3, text.split("\n").length + 1))}
        value={text}
        placeholder={"Q1.brandA AND (Q2.R1.C2 OR Q3 > 25)\n\nDrag a reference in from the list below, or click one."}
        onChange={(e) => { setText(e.target.value); setDirty(true); commit(e.target.value); }}
        onBlur={() => { if (dirty && result.errors.length === 0) commit(text); }}
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
            <span className="muted" style={{ fontSize: 12.5 }}>nothing matches “{filter}”</span>
          )}
        </div>
      </div>
    </div>
  );
}
