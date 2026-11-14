"use client";
import React from "react";
import type { Condition, LoopCountValue, LoopOrder, LoopReferenceColumn, LoopReferenceSource, LoopReferences, LoopSource } from "@rescript/schema";
import {
  LOOP_BUILTIN_REFS, createResponseState, describeLoop, loopVariablePrefix, parseDelimited, possibleLoopItems, simulateLoop,
  loopPlainSummary, loopChecks, loopExtras,
  type LoopFlowNode, type LoopSimulation,
} from "@rescript/engine";
import { useStudio } from "./store";
import { OptionalCondition } from "./ConditionBuilder";
import { LoopScopeProvider, loopsAroundLoop } from "./loopScope";
import { SetExprField } from "./MaskingBuilder";

/**
 * THE LOOP EDITOR (§3, §15–18, §34, §44).
 *
 * Everything a programmer configures about a loop lives on the loop node and
 * is edited here: what it iterates over, which items qualify, how many, in
 * what order — and the loop's own REFERENCE TABLE.
 *
 * The table is the point of this screen. It is a set of columns the programmer
 * invents for this loop (`Brand_Nickname`, `Product_ID`, …) and one row of
 * values per item the source can produce. It belongs to this loop node only:
 * editing it changes nothing on the source question, another loop over the
 * same question shows a different table, and a column the programmer adds here
 * appears — by name — in the condition builder, the piping picker, the
 * simulator below, the inspector and the exports, for questions INSIDE this
 * loop and nowhere else.
 *
 * The simulator at the bottom is not a mock of the runtime. It calls the same
 * `simulateLoop` → `resolveLoopItems` the flow compiler calls, against a
 * state built from the answers the programmer types in, so what it shows is
 * what a respondent with those answers would get.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FILTERS: { value: NonNullable<Extract<LoopSource, { kind: "question" }>["filter"]>; label: string; hint: string }[] = [
  { value: "selected", label: "the ones they chose", hint: "each answer the respondent chose" },
  { value: "notSelected", label: "the ones they did not choose", hint: "each answer the respondent was shown and did not choose" },
  { value: "displayed", label: "the ones they were shown", hint: "each answer the question actually showed this respondent" },
  { value: "all", label: "every answer listed", hint: "every answer of the question, chosen or not" },
  { value: "eligible", label: "the ones that pass this loop’s rule", hint: "each answer that passes “Only repeat for items where…” under More options" },
  { value: "invalid", label: "answers that are not valid", hint: "codes that match no answer, plus answers that match the rule under More options" },
];

const ORDERS: { value: LoopOrder["kind"]; label: string; needsColumn?: boolean }[] = [
  { value: "source", label: "as listed" },
  { value: "selection", label: "in the order they chose them" },
  { value: "random", label: "random, different for each respondent" },
  { value: "listFill", label: "as the List Fill ordered them" },
  { value: "priority", label: "sorted by an item detail", needsColumn: true },
  { value: "weightedRandom", label: "random, weighted by an item detail", needsColumn: true },
  { value: "custom", label: "an order I type" },
];

export function LoopEditor({ node, onChange }: { node: LoopFlowNode; onChange(n: LoopFlowNode): void }) {
  const s = useStudio();
  const def = s.def;
  const set = (patch: Partial<LoopFlowNode>) => onChange({ ...node, ...patch });
  const src = node.source;
  const refs: LoopReferences = node.references ?? { columns: [], values: {} };
  const items = React.useMemo(() => possibleLoopItems(def, node), [def, node]);
  const columns = refs.columns;

  /* ------------------------------------------------------------ source */

  const changeSourceKind = (kind: LoopSource["kind"]) => {
    if (kind === src.kind) return;
    /*
     * Switching kinds used to destroy a List Fill source (the dropdown could
     * not even produce one), so switching back and forth lost work. Each kind
     * starts from a sensible default; the reference table survives because it
     * is keyed by code and belongs to the loop, not to the source.
     */
    const next: LoopSource =
      kind === "question" ? { kind, questionId: def.questions.find((q) => q.type === "multi_select")?.id ?? def.questions[0]?.id ?? "", filter: "selected" }
      : kind === "listFill" ? { kind, listFillId: def.listFills[0]?.id ?? "" }
      : kind === "design" ? { kind, designId: def.designs[0]?.id ?? "" }
      : kind === "count" ? { kind, count: 3 }
      : kind === "variable" ? { kind, ref: "" }
      : kind === "setExpression" ? { kind, expr: { kind: "ref", questionId: def.questions[0]?.id ?? "", selection: "selected" } }
      : { kind: "static", items: [] };
    set({ source: next });
  };

  /* ------------------------------------------------------------ references */

  const setRefs = (next: LoopReferences) => set({ references: next.columns.length || Object.keys(next.values).length ? next : undefined });

  const [colError, setColError] = React.useState<string | null>(null);
  /* the + icon: a new reference at once, with a free default name to rename in place — as many as the loop needs */
  const addColumn = () => {
    let n = columns.length + 1;
    while (columns.some((c) => c.name === `Reference_${n}`)) n++;
    setColError(null);
    setRefs({ ...refs, columns: [...columns, { name: `Reference_${n}`, dataType: "text" }] });
  };
  const removeColumn = (name: string) => {
    const values: LoopReferences["values"] = {};
    for (const [code, row] of Object.entries(refs.values)) {
      const { [name]: _, ...rest } = row;
      values[code] = rest;
    }
    setRefs({ columns: columns.filter((c) => c.name !== name), values });
  };
  const renameColumn = (from: string, to: string) => {
    const name = to.trim();
    if (name === from) { setColError(null); return; }
    /* refused with the reason, not silently — the name has to fit inside {{loop.Name}} */
    if (!IDENT.test(name)) return setColError("A reference name is an identifier: letters, digits and underscores, not starting with a digit — it has to fit inside {{loop.Name}}.");
    if ((LOOP_BUILTIN_REFS as readonly string[]).includes(name)) return setColError(`"${name}" is what the item itself is called; pick another name.`);
    if (columns.some((c) => c.name === name)) return setColError(`"${name}" already exists on this loop.`);
    setColError(null);
    // values are keyed by column NAME (so the JSON is self-describing, §38),
    // which is why a rename rewrites every row's key here, in one place
    const values: LoopReferences["values"] = {};
    for (const [code, row] of Object.entries(refs.values)) {
      const { [from]: v, ...rest } = row;
      values[code] = v === undefined ? rest : { ...rest, [name]: v };
    }
    setRefs({
      columns: columns.map((c) => (c.name === from ? { ...c, name } : c)),
      values,
    });
    // a rename also has to reach the loop's own rules and any order column
    if (node.order?.column === from) set({ references: { columns: columns.map((c) => (c.name === from ? { ...c, name } : c)), values }, order: { ...node.order, column: name } });
  };
  const moveColumn = (name: string, dir: -1 | 1) => {
    const i = columns.findIndex((c) => c.name === name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j], next[i]];
    setRefs({ ...refs, columns: next });
  };
  const patchColumn = (name: string, patch: Partial<LoopReferenceColumn>) =>
    setRefs({ ...refs, columns: columns.map((c) => (c.name === name ? { ...c, ...patch } : c)) });
  const setValue = (code: string, col: string, raw: string) => {
    const row = { ...(refs.values[code] ?? {}) };
    if (raw === "") delete row[col]; else row[col] = raw;
    setRefs({ ...refs, values: { ...refs.values, [code]: row } });
  };

  /* ------------------------------------------------------------ import */

  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [importNote, setImportNote] = React.useState<string | null>(null);
  const importRows = () => {
    /*
     * CSV / TSV with a header row, or a JSON object/array (§18). The first
     * column — or one named code/Code/option — is the item code; every other
     * header is a reference column, created if this loop does not have it.
     * Rows for codes the source cannot produce are kept (the source may grow),
     * but counted and reported so a mismatch is visible.
     */
    const text = importText.trim();
    if (!text) return;
    let rows: Record<string, string>[] = [];
    let headers: string[] = [];
    try {
      if (text.startsWith("{") || text.startsWith("[")) {
        const parsed = JSON.parse(text);
        const arr: Record<string, unknown>[] = Array.isArray(parsed)
          ? parsed
          : Object.entries(parsed as Record<string, Record<string, unknown>>).map(([code, row]) => ({ code, ...row }));
        headers = [...new Set(arr.flatMap((r) => Object.keys(r)))];
        rows = arr.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? "" : String(v)])));
      } else {
        const parsed = parseDelimited(text);
        headers = parsed.headers;
        rows = parsed.rows;
      }
    } catch (e) {
      return setImportNote(`Could not read that: ${(e as Error).message}`);
    }
    if (!headers.length) return setImportNote("No header row found.");
    const codeHeader = headers.find((h) => /^(code|option|item|item_code|optioncode)$/i.test(h)) ?? headers[0];
    const refHeaders = headers.filter((h) => h !== codeHeader);
    const bad = refHeaders.filter((h) => !IDENT.test(h) || (LOOP_BUILTIN_REFS as readonly string[]).includes(h));
    if (bad.length) return setImportNote(`These headers cannot be reference column names: ${bad.join(", ")}.`);

    const nextColumns = [...columns];
    for (const h of refHeaders) if (!nextColumns.some((c) => c.name === h)) nextColumns.push({ name: h, dataType: "text" });
    const values: LoopReferences["values"] = { ...refs.values };
    let matched = 0, unmatched = 0;
    const known = new Set((items ?? []).map((i) => i.code));
    for (const r of rows) {
      const code = String(r[codeHeader] ?? "").trim();
      if (!code) continue;
      if (items && !known.has(code)) unmatched++; else matched++;
      const row = { ...(values[code] ?? {}) };
      for (const h of refHeaders) { const v = String(r[h] ?? "").trim(); if (v !== "") row[h] = v; }
      values[code] = row;
    }
    setRefs({ columns: nextColumns, values });
    setImportNote(`Imported ${matched} item${matched === 1 ? "" : "s"}${unmatched ? `; ${unmatched} code${unmatched === 1 ? "" : "s"} not produced by the current source (kept)` : ""}${refHeaders.filter((h) => !columns.some((c) => c.name === h)).length ? `; new columns: ${refHeaders.filter((h) => !columns.some((c) => c.name === h)).join(", ")}` : ""}.`);
    setImportText("");
  };

  /* ------------------------------------------------------------ simulator */

  const [simOpen, setSimOpen] = React.useState(false);
  const [simCodes, setSimCodes] = React.useState<string[]>([]);
  const simulation: LoopSimulation | null = React.useMemo(() => {
    if (!simOpen) return null;
    const state = createResponseState(def, { seed: 1 });
    if (src.kind === "question") state.answers[src.questionId] = simCodes;
    // "selected" order is the order the codes were ticked — mirror that
    return simulateLoop(def, node, state);
  }, [simOpen, simCodes, def, node, src]);

  const sourceQuestion = src.kind === "question" ? def.questions.find((q) => q.id === src.questionId) : undefined;
  const prefix = loopVariablePrefix(node);
  const scope = loopsAroundLoop(def, node.id);
  const summary = React.useMemo(() => loopPlainSummary(def, node), [def, node]);
  const checks = React.useMemo(() => loopChecks(def, node), [def, node]);
  const extras = loopExtras(node);
  /* open when something in it is in use, or when the person opened it (remembered while the Studio is open) */
  const [moreOpen, setMoreOpen] = React.useState(() => extras.total > 0 || (typeof window !== "undefined" && window.sessionStorage?.getItem("rescript.loop.more") === "1"));
  /* a setting that comes into use from elsewhere (an import, the assistant, undo) is never left folded away */
  const extrasInUse = extras.total > 0;
  React.useEffect(() => { if (extrasInUse) setMoreOpen(true); }, [extrasInUse]);

  return (
    <div className="loop-editor" data-testid="loop-editor">
      {/*
        * WHAT THIS LOOP DOES, FIRST (2026-11-13, engine loopGuide.ts). The editor opened on a dozen settings under
        * their programming names and never said what the loop would do. It now opens on that sentence, with anything
        * unfinished or wrong in plain words, then the two things every loop needs — what to repeat for, how many and
        * in what order. Everything else is under "More options", open when in use. No setting was removed and the
        * loop node is stored exactly as before.
        */}
      <div className="loop-summary" data-testid="loop-summary">
        {summary.map((line, i) => <p key={i} className={i === 0 ? "loop-summary-main" : "loop-summary-more"}>{line}</p>)}
        {checks.map((c, i) => (
          <div key={i} className={`loop-check lvl-${c.level}`} data-testid="loop-check" data-level={c.level} role={c.level === "problem" ? "alert" : undefined}>
            <span className="loop-check-tag">{c.level === "problem" ? "Fix" : c.level === "warning" ? "Check" : "Tip"}</span>{c.message}
          </div>
        ))}
      </div>
      {/* ------------------------------------------------ source & filter */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="flabel" style={{ margin: 0 }}>Repeat for</span>
        <select className="select" data-testid="loop-source-kind" value={src.kind} onChange={(e) => changeSourceKind(e.target.value as LoopSource["kind"])}>
          <option value="question">each answer of a question</option>
          <option value="static">each item of a list I type</option>
          <option value="count">a fixed number of times</option>
          <optgroup label="Less common">
            <option value="listFill">each item a List Fill gave this respondent</option>
            <option value="setExpression">answers combined from several questions</option>
            <option value="variable">a list held in a variable</option>
            <option value="design">the tasks of a design</option>
          </optgroup>
        </select>
        {src.kind === "question" && (
          <>
            <select className="select" data-testid="loop-source-question" value={src.questionId}
              onChange={(e) => set({ source: { ...src, questionId: e.target.value } })}>
              {def.questions.map((q) => <option key={q.id} value={q.id}>{q.code} — {q.type.replace(/_/g, " ")}</option>)}
            </select>
            <select className="select" data-testid="loop-filter" value={src.filter ?? "selected"} title={FILTERS.find((f) => f.value === (src.filter ?? "selected"))?.hint}
              onChange={(e) => set({ source: { ...src, filter: e.target.value as never } })}>
              {FILTERS.map((f) => <option key={f.value} value={f.value} title={f.hint}>{f.label}</option>)}
            </select>
            {/* Which of the question's collections to walk. Only worth
                offering when the question actually has rows — for a flat
                list "options" is the only meaningful answer. */}
            {(def.questions.find((q) => q.id === src.questionId)?.rows.length ?? 0) > 0 && (
              <select className="select" data-testid="loop-dimension" value={src.dimension ?? "options"}
                title="Which of this question's lists the loop walks"
                onChange={(e) => set({ source: { ...src, dimension: e.target.value as never } })}>
                <option value="options">its answers</option>
                <option value="rows">its rows</option>
                <option value="columns">its columns</option>
              </select>
            )}
          </>
        )}
        {src.kind === "listFill" && (
          <select className="select" data-testid="loop-source-listfill" value={src.listFillId} onChange={(e) => set({ source: { ...src, listFillId: e.target.value } })}>
            {def.listFills.length === 0 && <option value="">— no List Fill configured —</option>}
            {def.listFills.map((lf) => <option key={lf.id} value={lf.id}>{lf.name ?? lf.id}</option>)}
          </select>
        )}
        {src.kind === "design" && (
          <select className="select" value={src.designId} onChange={(e) => set({ source: { ...src, designId: e.target.value } })}>
            {def.designs.map((d) => <option key={d.id} value={d.id}>{d.name ?? d.id}</option>)}
          </select>
        )}
        {src.kind === "count" && (
          <CountValueField value={src.count} onChange={(count) => set({ source: { ...src, count } })} label="times" />
        )}
        {src.kind === "variable" && (
          <>
            <input className="input mono" style={{ width: 160 }} placeholder="variable or field name" value={src.ref}
              onChange={(e) => set({ source: { ...src, ref: e.target.value } })} />
            <input className="input mono" style={{ width: 60 }} placeholder="sep" title="separator for a delimited string (default , ; | or newline); a JSON array needs none" value={src.separator ?? ""}
              onChange={(e) => set({ source: { ...src, separator: e.target.value || undefined } })} />
          </>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 10px" }}>
        {src.kind === "question" && `One round for ${FILTERS.find((f) => f.value === (src.filter ?? "selected"))?.hint ?? ""}.`}
        {src.kind === "static" && "One round per item, for every respondent. Inside the loop, {{loop.label}} shows the item’s name."}
        {src.kind === "listFill" && "one iteration per item the List Fill allocated to this respondent; the reference table below is this loop’s own, keyed by the allocated codes."}
        {src.kind === "count" && "items 1…N — a plain numeric iteration."}
        {src.kind === "variable" && "a JSON array (codes, or {code,label} objects) or a delimited string left in a calculated variable, embedded field or answer — how a script or an API result feeds a loop."}
        {src.kind === "setExpression" && "the codes a set expression yields — “the brands in both screeners”, “aware minus considered” — with the same builder and grammar masks use; labels come from the first source question that has the code."}
      </p>

      {src.kind === "setExpression" && (
        <div style={{ marginBottom: 10 }}>
          <SetExprField testId="loop-source-setexpr" expr={src.expr} onChange={(expr) => { if (expr) set({ source: { kind: "setExpression", expr } }); }} />
        </div>
      )}

      {src.kind === "static" && (
        <div style={{ marginBottom: 10 }}>
          {src.items.map((it, i) => (
            <div key={i} className="opt-row">
              <input className="input code-input" value={it.code}
                onChange={(e) => set({ source: { ...src, items: src.items.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) } })} />
              <input className="input grow" value={it.label}
                onChange={(e) => set({ source: { ...src, items: src.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
              <button className="btn small danger" onClick={() => set({ source: { ...src, items: src.items.filter((_, j) => j !== i) } })}>×</button>
            </div>
          ))}
          <button className="btn small" onClick={() => set({ source: { ...src, items: [...src.items, { code: String(src.items.length + 1), label: "" }] } })}>+ item</button>
        </div>
      )}

      {/* ------------------------------------------------ count & order */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <span className="flabel" style={{ margin: 0 }}>How many</span>
        <select className="select" data-testid="loop-count-mode" value={node.count?.mode ?? (node.maxIterations != null ? "max" : "all")}
          onChange={(e) => {
            const mode = e.target.value as NonNullable<LoopFlowNode["count"]>["mode"];
            set({ count: mode === "all" ? { mode } : { mode, value: node.count?.value ?? node.maxIterations ?? 3 }, maxIterations: undefined });
          }}>
          <option value="all">every item</option>
          <option value="exact">exactly this many</option>
          <option value="max">no more than</option>
          <option value="min">only if there are at least</option>
        </select>
        {(node.count?.mode ?? (node.maxIterations != null ? "max" : "all")) !== "all" && (
          <CountValueField value={node.count?.value ?? node.maxIterations ?? 3} onChange={(value) => set({ count: { mode: node.count?.mode ?? "max", value }, maxIterations: undefined })} />
        )}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <span className="flabel" style={{ margin: 0 }}>Order</span>
        <select className="select" data-testid="loop-order" value={node.order?.kind ?? (node.randomizeIterations ? "random" : src.kind === "listFill" ? "listFill" : "source")}
          onChange={(e) => {
            const kind = e.target.value as LoopOrder["kind"];
            set({ order: { kind, column: node.order?.column, direction: node.order?.direction, custom: node.order?.custom }, randomizeIterations: undefined });
          }}>
          {ORDERS.filter((o) => o.value !== "listFill" || src.kind === "listFill").map((o) => (
            <option key={o.value} value={o.value} disabled={o.needsColumn && columns.length === 0}>{o.label}{o.needsColumn && columns.length === 0 ? " — add an item detail first" : ""}</option>
          ))}
        </select>
        {ORDERS.find((o) => o.value === node.order?.kind)?.needsColumn && (
          <>
            <select className="select" value={node.order?.column ?? ""} onChange={(e) => set({ order: { ...node.order!, column: e.target.value || undefined } })}>
              <option value="">— column —</option>
              {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            {node.order?.kind === "priority" && (
              <select className="select" value={node.order?.direction ?? "asc"} onChange={(e) => set({ order: { ...node.order!, direction: e.target.value as "asc" | "desc" } })}>
                <option value="asc">lowest first</option>
                <option value="desc">highest first</option>
              </select>
            )}
          </>
        )}
      </div>
      {node.order?.kind === "custom" && (
        <div style={{ marginBottom: 10 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>Codes in the order wanted (comma-separated); anything unlisted follows in source order.{!items && " The source is unbounded, so the codes are not known here — type the ones you expect."}</span>
          <input className="input mono" style={{ width: "100%" }} value={(node.order.custom ?? []).join(", ")}
            onChange={(e) => set({ order: { ...node.order!, custom: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} />
        </div>
      )}

      {/* ------------------------------------------------ more options */}
      <details className="loop-more" data-testid="loop-more" open={moreOpen}
        onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setMoreOpen(o); try { window.sessionStorage?.setItem("rescript.loop.more", o ? "1" : "0"); } catch { /* private mode */ } }}>
        <summary data-testid="loop-more-toggle">
          More options
          <span className="muted loop-more-hint">
            {extras.total > 0
              ? ` — in use: ${[extras.rules ? `${extras.rules} rule${extras.rules === 1 ? "" : "s"}` : "", extras.details ? `${extras.details} item detail${extras.details === 1 ? "" : "s"}` : "", extras.totals ? `${extras.totals} total${extras.totals === 1 ? "" : "s"}` : "", extras.fixedList ? "a fixed list" : ""].filter(Boolean).join(", ")}`
              : " — rules for which items are asked, extra facts about each item, totals across the rounds"}
          </span>
        </summary>
        <div className="loop-more-body">
        <h4 className="loop-more-h">Which items are asked</h4>
      {/* ------------------------------------------------ eligibility / invalid */}
      <LoopScopeProvider loops={scope}>
        <OptionalCondition
          label="Only repeat for items where…"
          workspace={{ title: "Loop — only repeat for items where…", subject: node.loopVar, description: "An item produces an iteration only when the following condition is met (evaluated once per candidate item):" }}
          value={node.eligibleIf}
          onChange={(c: Condition | undefined) => set({ eligibleIf: c })}
          hint="Checked for each item before the loop starts. Example: only items whose Category detail is Smartphone."
        />
        {src.kind === "question" && (src.filter === "invalid") && (
          <OptionalCondition
            label="What makes an item invalid"
            workspace={{ title: "Loop — invalid items", subject: node.loopVar, description: "An item is treated as invalid when the following condition is met:" }}
            value={node.invalidIf}
            onChange={(c: Condition | undefined) => set({ invalidIf: c })}
            hint="codes that match no option are always invalid; this rule adds more"
          />
        )}
        {/*
          * Control flow, in the order it runs: skip filters items out before
          * the loop starts; break stops the loop part-way through. Both sit
          * with eligibility because all three decide which iterations exist.
          */}
        <OptionalCondition
          label="Leave an item out when…"
          workspace={{ title: "Loop — leave an item out when…", subject: node.loopVar, description: "Skip the item (no iteration) when the following condition is met:" }}
          value={node.skipIf}
          onChange={(c: Condition | undefined) => set({ skipIf: c })}
          hint="The item is not asked about at all. Example: leave out “Other”."
        />
        <OptionalCondition
          label="Stop repeating once…"
          workspace={{ title: "Loop — stop repeating once…", subject: node.loopVar, description: "Stop after this iteration when the following condition is met:" }}
          value={node.breakIf}
          onChange={(c: Condition | undefined) => set({ breakIf: c })}
          hint="Checked after each round, on the answers just given: that round is kept, later ones are not asked. Example: stop once a rating is 5."
        />
      </LoopScopeProvider>

      {/* ------------------------------------------------ source re-evaluation */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <span className="flabel" style={{ margin: 0 }}>If earlier answers change</span>
        <select className="select" data-testid="loop-resolve-source"
          value={node.resolveSource ?? "reevaluate"}
          onChange={(e) => set({ resolveSource: e.target.value as "reevaluate" | "once" })}>
          <option value="reevaluate">update the list (rounds are added or removed)</option>
          <option value="once">keep the list as it was when they first got here</option>
        </select>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {node.resolveSource === "once"
            ? "If the respondent goes back and changes the answers this list comes from, the rounds already answered stay as they are."
            : "If the respondent goes back and changes the answers this list comes from, the loop follows."}
        </span>
      </div>

        <h4 className="loop-more-h">Extra facts and totals</h4>
      {/* ------------------------------------------------ references */}
      <div className="loop-refs" data-testid="loop-references">
        <div className="row" style={{ alignItems: "baseline" }}>
          <strong style={{ fontSize: 14 }}>Item details</strong>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>
            extra facts about each item (a price, a nickname, a category) to show in the questions or use in rules — {sourceQuestion ? `${sourceQuestion.code} itself is not changed` : "they belong to this loop only"}
          </span>
          <span className="grow" />
          <button className="btn small" data-testid="loop-import-toggle" onClick={() => setImportOpen((v) => !v)}>{importOpen ? "close import" : "Import…"}</button>
        </div>

        {importOpen && (
          <div className="loop-import" style={{ margin: "8px 0" }}>
            <textarea className="input mono" data-testid="loop-import-text" rows={5} style={{ width: "100%", fontSize: 13 }}
              placeholder={"Code\tBrand_Nickname\tProduct_ID\n1\tAPPLE\tPROD_001\n3\tGOOGLE\tPROD_003\n\n— or a JSON object keyed by code, or an array of rows. Save an Excel sheet as CSV first."}
              value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small primary" data-testid="loop-import-apply" onClick={importRows}>Import into this loop</button>
              <span className="muted" style={{ fontSize: 12.5 }}>first column (or one named code) is the item code; every other header becomes a reference column here</span>
            </div>
            {importNote && <div className="muted" data-testid="loop-import-note" style={{ fontSize: 12.5, marginTop: 4 }}>{importNote}</div>}
          </div>
        )}

        {items === null && (
          <p className="muted" style={{ fontSize: 12.5 }}>
            This source’s items are not known until the survey runs, so the table is keyed by code — add rows for the codes you expect.
          </p>
        )}

        {colError && <div className="muted" data-testid="loop-ref-error" style={{ color: "var(--red)", fontSize: 12.5, margin: "4px 0" }}>{colError}</div>}
        <div style={{ overflowX: "auto" }}>
          <table className="loop-ref-table" data-testid="loop-ref-table">
            <thead>
              <tr>
                <th style={{ minWidth: 140 }}>Item</th>
                <th>Code</th>
                {columns.map((c, i) => (
                  <th key={c.name} data-testid="loop-ref-column" data-column={c.name} style={{ minWidth: 230, verticalAlign: "top" }}>
                    <div className="row" style={{ gap: 2 }}>
                      <input className="input mono" style={{ width: 130, fontWeight: 600 }} defaultValue={c.name} key={c.name}
                        data-testid="loop-ref-column-name" aria-label="Reference name"
                        onBlur={(e) => { renameColumn(c.name, e.target.value); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} title={c.description ?? "click to rename"} />
                      <button className="btn small" title="move left" aria-label="Move left" disabled={i === 0} onClick={() => moveColumn(c.name, -1)}>‹</button>
                      <button className="btn small" title="move right" aria-label="Move right" disabled={i === columns.length - 1} onClick={() => moveColumn(c.name, 1)}>›</button>
                      <button className="btn small danger" title="remove this reference and its values" aria-label={`Remove ${c.name}`} data-testid="loop-ref-remove" onClick={() => removeColumn(c.name)}>×</button>
                    </div>
                    <div className="row" style={{ gap: 4, marginTop: 4 }}>
                      <select className="select small" aria-label="Type" value={c.dataType ?? "text"} onChange={(e) => patchColumn(c.name, { dataType: e.target.value as LoopReferenceColumn["dataType"] })}>
                        <option value="text">text</option><option value="number">number</option><option value="boolean">yes/no</option>
                      </select>
                      <label className="muted" style={{ fontSize: 12.5 }}>
                        <input type="checkbox" checked={!!c.required} onChange={(e) => patchColumn(c.name, { required: e.target.checked })} /> required
                      </label>
                    </div>
                    <ReferenceSourceField column={c} others={columns.filter((x) => x.name !== c.name).map((x) => x.name)}
                      onChange={(source) => patchColumn(c.name, { source })} />
                  </th>
                ))}
                <th className="loop-ref-add-cell" style={{ width: 44, verticalAlign: "top" }}>
                  <button type="button" className="btn small primary loop-ref-add" data-testid="loop-ref-add" aria-label="Add a reference" title="Add a reference" onClick={addColumn}>+</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {(items ?? Object.keys(refs.values).map((code) => ({ code, label: code }))).map((it) => (
                <tr key={it.code} data-testid="loop-ref-row" data-code={it.code}>
                  <td>{it.label}</td>
                  <td className="mono">{it.code}</td>
                  {columns.map((c) => {
                    if (c.source && c.source.kind !== "static") {
                      return (
                        <td key={c.name}>
                          <span className="muted loop-ref-dynamic" data-testid="loop-ref-dynamic" data-code={it.code} data-column={c.name}
                            title="This reference is resolved for each respondent when the survey runs — see the loop simulator for what it gives.">↻ {sourceSummary(c.source, (r) => String(def.questions.find((q) => q.id === r || q.code === r)?.code ?? r))}</span>
                        </td>
                      );
                    }
                    const v = refs.values[it.code]?.[c.name];
                    const missing = c.required && (v === undefined || v === "" || v === null);
                    return (
                      <td key={c.name}>
                        <input className={`input mono${missing ? " invalid" : ""}`} data-testid="loop-ref-cell" data-code={it.code} data-column={c.name}
                          style={{ width: 130 }} value={v == null ? "" : String(v)}
                          placeholder={missing ? "required" : ""}
                          onChange={(e) => setValue(it.code, c.name, e.target.value)} />
                      </td>
                    );
                  })}
                  <td />
                </tr>
              ))}
              {items && items.length === 0 && (
                <tr><td colSpan={columns.length + 3} className="muted" style={{ fontSize: 12.5 }}>The source has no items yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          Inside the loop, pipe with <code>{"{{loop.label}}"}</code>, <code>{"{{loop.code}}"}</code>, <code>{"{{loop.index}}"}</code>, <code>{"{{loop.count}}"}</code>, <code>{"{{loop.first}}"}</code>, <code>{"{{loop.last}}"}</code>
          {columns.length ? <>, <code>{`{{loop.${columns[0].name}}}`}</code>{columns.length > 1 ? "…" : ""}</> : null}
          {" "}(or <code>{"{{CURRENT_ITEM.Column}}"}</code>). Conditions: <code>loop.{columns[0]?.name ?? "Column"} = "…"</code>.
          {scope.length > 1 ? <> An outer loop is <code>{`{{${scope[1].loopVar}.label}}`}</code>.</> : null}
        </p>
      </div>

      {/* ------------------------------------------------ aggregates */}
      <div className="loop-refs" data-testid="loop-aggregates" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: "baseline" }}>
          <strong style={{ fontSize: 14 }}>Totals across the rounds</strong>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>
            one figure worked out from all the rounds — an average rating, a count — to use after the loop
          </span>
          <span className="grow" />
          <button className="btn small" data-testid="loop-add-aggregate"
            onClick={() => set({
              aggregates: [...(node.aggregates ?? []),
                { name: `RESULT_${(node.aggregates?.length ?? 0) + 1}`, questionRef: "", op: "avg" as const }],
            })}>+ total</button>
        </div>
        {(node.aggregates ?? []).length === 0 && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            None yet. Example: the average of a rating asked in every round, ready to use in logic or piping after the loop
            (stored as <span className="mono">{loopVariablePrefix(node, null)}_AVG_SCORE</span>).
          </div>
        )}
        {(node.aggregates ?? []).map((agg, i) => {
          const patch = (p: Partial<typeof agg>) => set({
            aggregates: (node.aggregates ?? []).map((a, j) => (j === i ? { ...a, ...p } : a)),
          });
          return (
            <div className="row" key={i} style={{ flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
              <span className="mono muted" style={{ fontSize: 12 }}>{loopVariablePrefix(node, null)}_</span>
              <input className="input mono" style={{ width: 130 }} data-testid="loop-agg-name"
                value={agg.name} onChange={(e) => patch({ name: e.target.value.toUpperCase() })} />
              <select className="select" data-testid="loop-agg-op" value={agg.op}
                onChange={(e) => patch({ op: e.target.value as typeof agg.op })}>
                <option value="avg">average of</option>
                <option value="sum">sum of</option>
                <option value="min">smallest</option>
                <option value="max">largest</option>
                <option value="count">how many answered</option>
                <option value="countIf">how many match a rule</option>
              </select>
              <select className="select" data-testid="loop-agg-question" value={agg.questionRef}
                onChange={(e) => patch({ questionRef: e.target.value })}>
                <option value="">— question —</option>
                {def.questions.map((x) => <option key={x.id} value={x.code}>{x.code}</option>)}
              </select>
              <button className="btn small danger" title="Remove this result"
                onClick={() => set({ aggregates: (node.aggregates ?? []).filter((_, j) => j !== i) })}>×</button>
              {agg.op === "countIf" && (
                <div style={{ flexBasis: "100%" }}>
                  <LoopScopeProvider loops={scope}>
                    <OptionalCondition
                      label="count a round when"
                      workspace={{ title: "Loop aggregate — count an iteration when", subject: node.loopVar, description: "Count an iteration toward this aggregate when the following condition is met:" }}
                      value={agg.where}
                      onChange={(c: Condition | undefined) => patch({ where: c })}
                      hint="evaluated once per iteration, in that iteration's context"
                    />
                  </LoopScopeProvider>
                </div>
              )}
            </div>
          );
        })}
      </div>

        <h4 className="loop-more-h">Name and data</h4>
        <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <label className="row" style={{ gap: 6 }}><span className="flabel" style={{ margin: 0 }}>Loop name</span>
            <input className="input mono" data-testid="loop-var" style={{ width: 130 }} value={node.loopVar}
              onChange={(e) => set({ loopVar: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} />
          </label>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Used when another loop sits inside this one (<code>{`{{${node.loopVar || "name"}.label}}`}</code>) and in the data: <code>{prefix}_COUNT</code>, <code>{prefix}_ITEM_1</code>, <code>{prefix}_ITEM_1_CODE</code>{columns.length ? <>, <code>{prefix}_ITEM_1_{columns[0].name.toUpperCase()}</code>…</> : null}.
          </span>
        </div>
      {/* ------------------------------------------------ as one statement */}
      <details className="qs-details" data-testid="loop-statement" style={{ marginBottom: 12 }}>
        <summary>Technical summary (for programmers)</summary>
        <pre className="mono" style={{ fontSize: 12.5, margin: "6px 0 0", whiteSpace: "pre-wrap" }} data-testid="loop-statement-text">{describeLoop(def, node)}</pre>
        <div className="muted" style={{ fontSize: 12 }}>Read from the configuration above, in the same grammar the condition and mask expression tabs use. Edit the loop with the controls; the statement follows.</div>
      </details>

        </div>
      </details>

      {/* ------------------------------------------------ simulator */}
      <div className="loop-sim" data-testid="loop-simulator" style={{ marginTop: 12 }}>
        <div className="row">
          <button className="btn small" data-testid="loop-sim-toggle" onClick={() => setSimOpen((v) => !v)}>{simOpen ? "▾" : "▸"} Try it</button>
          <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>pick a respondent’s answers and see exactly which rounds they would get, in order</span>
        </div>
        {simOpen && (
          <div style={{ marginTop: 8 }}>
            {src.kind === "question" && sourceQuestion && (
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 12.5 }}>{sourceQuestion.code} selected:</span>
                {sourceQuestion.options.map((o) => (
                  <label key={String(o.code)} className="row" style={{ gap: 3, fontSize: 13 }}>
                    <input type="checkbox" data-testid="loop-sim-option" data-code={String(o.code)} checked={simCodes.includes(String(o.code))}
                      onChange={(e) => setSimCodes((cs) => (e.target.checked ? [...cs, String(o.code)] : cs.filter((c) => c !== String(o.code))))} />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
            {simulation && (
              <div data-testid="loop-sim-result">
                <div style={{ fontSize: 13, marginBottom: 4 }}><strong>{simulation.count}</strong> iteration{simulation.count === 1 ? "" : "s"}</div>
                {simulation.iterations.map((it) => (
                  <div key={it.index} className="loop-sim-iter" data-testid="loop-sim-iteration" style={{ fontSize: 13, padding: "4px 8px", borderLeft: "2px solid var(--border)", marginBottom: 4 }}>
                    <div><strong>Iteration {it.index}</strong> — item = {it.label} <span className="mono muted">({it.code})</span></div>
                    {simulation.columns.length > 0 && (
                      <div className="muted" style={{ paddingLeft: 10 }}>
                        {simulation.columns.map((c) => <div key={c}>{c} = <span className="mono">{it.references[c] == null ? "∅" : String(it.references[c])}</span></div>)}
                      </div>
                    )}
                  </div>
                ))}
                {simulation.count === 0 && <div className="muted" style={{ fontSize: 13 }}>No iterations for these answers.</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A number, literal or read from a question / calculation / embedded field. */
function CountValueField({ value, onChange, label }: { value: LoopCountValue; onChange(v: LoopCountValue): void; label?: string }) {
  const s = useStudio();
  const kind = typeof value === "number" ? "literal" : value.kind;
  return (
    <span className="row" style={{ gap: 4 }}>
      <select className="select small" value={kind} onChange={(e) => {
        const k = e.target.value;
        onChange(k === "literal" ? 3 : { kind: k as "question" | "calculation" | "embedded" | "variable", ref: "" });
      }}>
        <option value="literal">number</option>
        <option value="question">a question’s count</option>
        <option value="calculation">a calculation</option>
        <option value="embedded">embedded data</option>
        <option value="variable">a variable</option>
      </select>
      {typeof value === "number" ? (
        <input className="input mono" type="number" min={0} style={{ width: 70 }} value={value} data-testid="loop-count-value"
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} />
      ) : value.kind === "question" ? (
        <select className="select" value={value.ref} onChange={(e) => onChange({ ...value, ref: e.target.value })}>
          <option value="">— question —</option>
          {s.def.questions.map((q) => <option key={q.id} value={q.code}>{q.code}</option>)}
        </select>
      ) : (
        <input className="input mono" style={{ width: 140 }} placeholder="name" value={value.ref} onChange={(e) => onChange({ ...value, ref: e.target.value })} />
      )}
      {label ? <span className="muted" style={{ fontSize: 12.5 }}>{label}</span> : null}
    </span>
  );
}

/* ================================================== dynamic references (2026-11-10) */

const SOURCE_KINDS: { kind: LoopReferenceSource["kind"]; label: string; hint: string }[] = [
  { kind: "static", label: "Typed values (per item)", hint: "the value typed into this column for each item below" },
  { kind: "text", label: "Text with piping", hint: "words, a delimiter such as a new line, and any {{…}} token — resolved per item at runtime" },
  { kind: "calculation", label: "Calculation", hint: "an expression evaluated inside the iteration — it can read loop.code, answers, calculations" },
  { kind: "answer", label: "Answer to a question", hint: "a question's answer: its value, labels, Other-specify text, or as the respondent saw it" },
  { kind: "item", label: "The loop item", hint: "the current item's label or code, the Other-specify text typed for it, or its displayed value" },
  { kind: "variable", label: "Variable", hint: "a calculated, embedded or answer variable by name" },
];

/** a short reading of a dynamic source, for the cells of the table */
export function sourceSummary(s: LoopReferenceSource, codeOf: (ref: string) => string = (r) => r): string {
  switch (s.kind) {
    case "text": return s.text.trim() ? `text: ${s.text.replace(/\n/g, "⏎").slice(0, 40)}${s.text.length > 40 ? "…" : ""}` : "text (empty)";
    case "calculation": return s.expr.trim() ? `= ${s.expr.slice(0, 40)}` : "calculation (empty)";
    case "answer": return `${codeOf(s.question)} · ${({ value: "value", label: "labels", other: "Other text", displayed: "as displayed" } as const)[s.part ?? "displayed"]}`;
    case "item": return `item · ${({ label: "label", code: "code", other: "Other text", displayed: "displayed" } as const)[s.part]}`;
    case "variable": return s.name ? `variable ${s.name}` : "variable (none)";
    default: return "typed";
  }
}

/** where one reference's value comes from, and that source's own settings */
function ReferenceSourceField({ column, others, onChange }: { column: LoopReferenceColumn; others: string[]; onChange(s: LoopReferenceSource | undefined): void }) {
  const s = useStudio();
  const def = s.def;
  const src: LoopReferenceSource = column.source ?? { kind: "static" };
  const questions = def.questions.filter((q) => q.type !== "html");
  const variables = [...new Set([...(def.embeddedData ?? []).map((e) => e.name), ...(def.calculations ?? []).map((c) => c.targetVariable).filter(Boolean)])];
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);
  const change = (kind: LoopReferenceSource["kind"]) => {
    /* by id: a question's code can be renamed, its id cannot */
    const firstQ = questions[0]?.id ?? "";
    const next: LoopReferenceSource =
      kind === "text" ? { kind, text: "{{loop.label}}" }
      : kind === "calculation" ? { kind, expr: "" }
      : kind === "answer" ? { kind, question: firstQ, part: "displayed" }
      : kind === "item" ? { kind, part: "displayed" }
      : kind === "variable" ? { kind, name: variables[0] ?? "" }
      : { kind: "static" };
    onChange(kind === "static" ? undefined : next);
  };
  /* insert a token where the cursor is, so piping is composed rather than remembered */
  const insert = (token: string) => {
    if (src.kind !== "text") return;
    const el = textRef.current;
    const at = el ? el.selectionStart ?? src.text.length : src.text.length;
    const end = el ? el.selectionEnd ?? at : at;
    onChange({ kind: "text", text: src.text.slice(0, at) + token + src.text.slice(end) });
  };
  const tokens = [
    "{{loop.label}}", "{{loop.code}}", "{{loop.index}}",
    ...others.map((n) => `{{loop.${n}}}`),
    ...questions.slice(0, 40).flatMap((q) => [`{{${q.code}}}`, ...(q.options.some((o) => (o.flags ?? []).includes("other_specify")) ? [`{{${q.code}.other}}`] : [])]),
    ...variables.slice(0, 20).map((v) => `{{${v}}}`),
  ];
  return (
    <div className="loop-ref-source" data-testid="loop-ref-source" style={{ marginTop: 6, fontWeight: 400 }}>
      <select className="select small" data-testid="loop-ref-source-kind" aria-label="Where the value comes from" value={src.kind}
        title={SOURCE_KINDS.find((k) => k.kind === src.kind)?.hint} onChange={(e) => change(e.target.value as LoopReferenceSource["kind"])}>
        {SOURCE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>
      {src.kind === "text" && (
        <>
          <textarea ref={textRef} className="input mono" data-testid="loop-ref-text" rows={2} style={{ width: "100%", fontSize: 12.5, marginTop: 4 }}
            placeholder="{{loop.label}} — {{Q3}}" value={src.text} onChange={(e) => onChange({ kind: "text", text: e.target.value })} />
          <select className="select small" data-testid="loop-ref-insert" aria-label="Insert a piped value" value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }}>
            <option value="">+ insert a piped value…</option>
            {tokens.map((t) => <option key={t} value={t}>{t}</option>)}
            <option value={"\n"}>a new line</option>
          </select>
        </>
      )}
      {src.kind === "calculation" && (
        <input className="input mono" data-testid="loop-ref-expr" style={{ width: "100%", marginTop: 4 }} placeholder="Q3 * 2  ·  loop.code"
          value={src.expr} onChange={(e) => onChange({ kind: "calculation", expr: e.target.value })} />
      )}
      {src.kind === "answer" && (
        <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: "wrap" }}>
          <select className="select small" data-testid="loop-ref-question" aria-label="Question"
            value={questions.find((q) => q.id === src.question || q.code === src.question || q.variableName === src.question)?.id ?? ""}
            onChange={(e) => onChange({ ...src, question: e.target.value })}>
            {questions.map((q) => <option key={q.id} value={q.id}>{q.code}</option>)}
          </select>
          <select className="select small" data-testid="loop-ref-part" aria-label="Which value" value={src.part ?? "displayed"} onChange={(e) => onChange({ ...src, part: e.target.value as "value" })}>
            <option value="displayed">as displayed</option><option value="label">labels</option><option value="value">value / codes</option><option value="other">Other-specify text</option>
          </select>
          {(src.part ?? "displayed") !== "other" && (
            <input className="input mono" style={{ width: 54 }} aria-label="Joined with" title="joins several answers" placeholder=", " value={src.join ?? ""} onChange={(e) => onChange({ ...src, join: e.target.value || undefined })} />
          )}
        </div>
      )}
      {src.kind === "item" && (
        <select className="select small" data-testid="loop-ref-part" aria-label="Which value of the item" style={{ marginTop: 4 }} value={src.part} onChange={(e) => onChange({ kind: "item", part: e.target.value as "label" })}>
          <option value="displayed">displayed (Other text, else label)</option><option value="label">label</option><option value="code">code</option><option value="other">Other-specify text</option>
        </select>
      )}
      {src.kind === "variable" && (
        <>
          <input className="input mono" data-testid="loop-ref-variable" list={`loop-ref-vars-${column.name}`} style={{ width: "100%", marginTop: 4 }} placeholder="VARIABLE_NAME"
            value={src.name} onChange={(e) => onChange({ kind: "variable", name: e.target.value })} />
          <datalist id={`loop-ref-vars-${column.name}`}>{variables.map((v) => <option key={v} value={v} />)}</datalist>
        </>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 2, whiteSpace: "normal" }}>{SOURCE_KINDS.find((k) => k.kind === src.kind)?.hint}</div>
    </div>
  );
}
