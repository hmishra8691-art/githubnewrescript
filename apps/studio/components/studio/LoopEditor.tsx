"use client";
import React from "react";
import type { Condition, LoopCountValue, LoopOrder, LoopReferenceColumn, LoopReferences, LoopSource } from "@rescript/schema";
import {
  createResponseState, loopVariablePrefix, parseDelimited, possibleLoopItems, simulateLoop,
  type LoopFlowNode, type LoopSimulation,
} from "@rescript/engine";
import { useStudio } from "./store";
import { OptionalCondition } from "./ConditionBuilder";
import { LoopScopeProvider, loopsAroundLoop } from "./loopScope";

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
  { value: "selected", label: "Selected", hint: "the options the respondent chose" },
  { value: "notSelected", label: "Not selected", hint: "the options shown and not chosen" },
  { value: "displayed", label: "Displayed", hint: "every option the question actually showed" },
  { value: "all", label: "All", hint: "every option, answered or not" },
  { value: "eligible", label: "Eligible", hint: "every option that passes the eligibility rule below" },
  { value: "invalid", label: "Invalid", hint: "codes that match no option, plus options that match the invalid rule below" },
];

const ORDERS: { value: LoopOrder["kind"]; label: string; needsColumn?: boolean }[] = [
  { value: "source", label: "Source order" },
  { value: "selection", label: "Selection order" },
  { value: "listFill", label: "List Fill order" },
  { value: "priority", label: "By a reference column", needsColumn: true },
  { value: "random", label: "Random" },
  { value: "weightedRandom", label: "Weighted random (by a column)", needsColumn: true },
  { value: "custom", label: "Custom order" },
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
      : { kind: "static", items: [] };
    set({ source: next });
  };

  /* ------------------------------------------------------------ references */

  const setRefs = (next: LoopReferences) => set({ references: next.columns.length || Object.keys(next.values).length ? next : undefined });

  const [newCol, setNewCol] = React.useState<LoopReferenceColumn>({ name: "", dataType: "text" });
  const [colError, setColError] = React.useState<string | null>(null);
  const addColumn = () => {
    const name = newCol.name.trim();
    if (!IDENT.test(name)) return setColError("A column name is an identifier: letters, digits and underscores, not starting with a digit — it has to fit inside {{loop.Name}}.");
    if (["code", "label", "index", "count"].includes(name)) return setColError(`"${name}" is what the item itself is called; pick another name.`);
    if (columns.some((c) => c.name === name)) return setColError(`"${name}" already exists on this loop.`);
    setColError(null);
    setRefs({ ...refs, columns: [...columns, { ...newCol, name }] });
    setNewCol({ name: "", dataType: "text" });
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
    if (name === from) return;
    if (!IDENT.test(name) || columns.some((c) => c.name === name)) return;
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
    const bad = refHeaders.filter((h) => !IDENT.test(h) || ["code", "label", "index", "count"].includes(h));
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

  return (
    <div className="loop-editor" data-testid="loop-editor">
      {/* ------------------------------------------------ source & filter */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="flabel" style={{ margin: 0 }}>Source</span>
        <select className="select" data-testid="loop-source-kind" value={src.kind} onChange={(e) => changeSourceKind(e.target.value as LoopSource["kind"])}>
          <option value="question">a question’s options</option>
          <option value="listFill">a List Fill result</option>
          <option value="static">a static list</option>
          <option value="count">a number of iterations</option>
          <option value="variable">a list in a variable</option>
          <option value="design">design tasks</option>
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
          <CountValueField value={src.count} onChange={(count) => set({ source: { ...src, count } })} label="iterations" />
        )}
        {src.kind === "variable" && (
          <>
            <input className="input mono" style={{ width: 160 }} placeholder="variable or field name" value={src.ref}
              onChange={(e) => set({ source: { ...src, ref: e.target.value } })} />
            <input className="input mono" style={{ width: 60 }} placeholder="sep" title="separator for a delimited string (default , ; | or newline); a JSON array needs none" value={src.separator ?? ""}
              onChange={(e) => set({ source: { ...src, separator: e.target.value || undefined } })} />
          </>
        )}
        <span className="grow" />
        <label className="row" style={{ gap: 4 }}>name
          <input className="input mono" data-testid="loop-var" style={{ width: 110 }} value={node.loopVar}
            onChange={(e) => set({ loopVar: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 11, margin: "4px 0 10px" }}>
        {src.kind === "question" && (FILTERS.find((f) => f.value === (src.filter ?? "selected"))?.hint ?? "")}
        {src.kind === "listFill" && "one iteration per item the List Fill allocated to this respondent; the reference table below is this loop’s own, keyed by the allocated codes."}
        {src.kind === "count" && "items 1…N — a plain numeric iteration."}
        {src.kind === "variable" && "a JSON array (codes, or {code,label} objects) or a delimited string left in a calculated variable, embedded field or answer — how a script or an API result feeds a loop."}
        {" "}Variables: <code>{prefix}_COUNT</code>, <code>{prefix}_ITEM_1</code>, <code>{prefix}_ITEM_1_CODE</code>{columns.length ? <>, <code>{prefix}_ITEM_1_{columns[0].name.toUpperCase()}</code>…</> : null}.
      </p>

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

      {/* ------------------------------------------------ eligibility / invalid */}
      <LoopScopeProvider loops={scope}>
        <OptionalCondition
          label="Eligibility rule (narrows the items; can read this loop’s reference columns)"
          value={node.eligibleIf}
          onChange={(c: Condition | undefined) => set({ eligibleIf: c })}
          hint='e.g. loop.Category = "Smartphone" — evaluated once per candidate item'
        />
        {src.kind === "question" && (src.filter === "invalid") && (
          <OptionalCondition
            label="What makes an item invalid"
            value={node.invalidIf}
            onChange={(c: Condition | undefined) => set({ invalidIf: c })}
            hint="codes that match no option are always invalid; this rule adds more"
          />
        )}
      </LoopScopeProvider>

      {/* ------------------------------------------------ count & order */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <span className="flabel" style={{ margin: 0 }}>Iterations</span>
        <select className="select" data-testid="loop-count-mode" value={node.count?.mode ?? (node.maxIterations != null ? "max" : "all")}
          onChange={(e) => {
            const mode = e.target.value as NonNullable<LoopFlowNode["count"]>["mode"];
            set({ count: mode === "all" ? { mode } : { mode, value: node.count?.value ?? node.maxIterations ?? 3 }, maxIterations: undefined });
          }}>
          <option value="all">all qualifying items</option>
          <option value="exact">exactly</option>
          <option value="max">at most</option>
          <option value="min">only if at least</option>
        </select>
        {(node.count?.mode ?? (node.maxIterations != null ? "max" : "all")) !== "all" && (
          <CountValueField value={node.count?.value ?? node.maxIterations ?? 3} onChange={(value) => set({ count: { mode: node.count?.mode ?? "max", value }, maxIterations: undefined })} />
        )}
        <span className="grow" />
        <span className="flabel" style={{ margin: 0 }}>Order</span>
        <select className="select" data-testid="loop-order" value={node.order?.kind ?? (node.randomizeIterations ? "random" : src.kind === "listFill" ? "listFill" : "source")}
          onChange={(e) => {
            const kind = e.target.value as LoopOrder["kind"];
            set({ order: { kind, column: node.order?.column, direction: node.order?.direction, custom: node.order?.custom }, randomizeIterations: undefined });
          }}>
          {ORDERS.filter((o) => o.value !== "listFill" || src.kind === "listFill").map((o) => (
            <option key={o.value} value={o.value} disabled={o.needsColumn && columns.length === 0}>{o.label}{o.needsColumn && columns.length === 0 ? " — add a column first" : ""}</option>
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
      {node.order?.kind === "custom" && items && (
        <div style={{ marginBottom: 10 }}>
          <span className="muted" style={{ fontSize: 11 }}>Codes in the order wanted (comma-separated); anything unlisted follows in source order.</span>
          <input className="input mono" style={{ width: "100%" }} value={(node.order.custom ?? []).join(", ")}
            onChange={(e) => set({ order: { ...node.order!, custom: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} />
        </div>
      )}

      {/* ------------------------------------------------ references */}
      <div className="loop-refs" data-testid="loop-references">
        <div className="row" style={{ alignItems: "baseline" }}>
          <strong style={{ fontSize: 13 }}>Loop references</strong>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            columns this loop defines for its items — {sourceQuestion ? `${sourceQuestion.code} itself is not changed` : "scoped to this loop only"}
          </span>
          <span className="grow" />
          <button className="btn small" data-testid="loop-import-toggle" onClick={() => setImportOpen((v) => !v)}>{importOpen ? "close import" : "Import…"}</button>
        </div>

        {importOpen && (
          <div className="loop-import" style={{ margin: "8px 0" }}>
            <textarea className="input mono" data-testid="loop-import-text" rows={5} style={{ width: "100%", fontSize: 12 }}
              placeholder={"Code\tBrand_Nickname\tProduct_ID\n1\tAPPLE\tPROD_001\n3\tGOOGLE\tPROD_003\n\n— or a JSON object keyed by code, or an array of rows. Save an Excel sheet as CSV first."}
              value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small primary" data-testid="loop-import-apply" onClick={importRows}>Import into this loop</button>
              <span className="muted" style={{ fontSize: 11 }}>first column (or one named code) is the item code; every other header becomes a reference column here</span>
            </div>
            {importNote && <div className="muted" data-testid="loop-import-note" style={{ fontSize: 11, marginTop: 4 }}>{importNote}</div>}
          </div>
        )}

        {items === null && (
          <p className="muted" style={{ fontSize: 11 }}>
            This source’s items are not known until the survey runs, so the table is keyed by code — add rows for the codes you expect.
          </p>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="loop-ref-table" data-testid="loop-ref-table">
            <thead>
              <tr>
                <th style={{ minWidth: 140 }}>Item</th>
                <th>Code</th>
                {columns.map((c, i) => (
                  <th key={c.name} data-testid="loop-ref-column">
                    <div className="row" style={{ gap: 2 }}>
                      <input className="input mono" style={{ width: 120, fontWeight: 600 }} defaultValue={c.name} key={c.name}
                        data-testid="loop-ref-column-name"
                        onBlur={(e) => renameColumn(c.name, e.target.value)} title={c.description ?? "click to rename"} />
                      <button className="btn small" title="move left" disabled={i === 0} onClick={() => moveColumn(c.name, -1)}>‹</button>
                      <button className="btn small" title="move right" disabled={i === columns.length - 1} onClick={() => moveColumn(c.name, 1)}>›</button>
                      <button className="btn small danger" title="remove column and its values" data-testid="loop-ref-remove" onClick={() => removeColumn(c.name)}>×</button>
                    </div>
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      <select className="select small" value={c.dataType ?? "text"} onChange={(e) => patchColumn(c.name, { dataType: e.target.value as LoopReferenceColumn["dataType"] })}>
                        <option value="text">text</option><option value="number">number</option><option value="boolean">yes/no</option>
                      </select>
                      <label className="muted" style={{ fontSize: 11 }}>
                        <input type="checkbox" checked={!!c.required} onChange={(e) => patchColumn(c.name, { required: e.target.checked })} /> required
                      </label>
                    </div>
                  </th>
                ))}
                <th style={{ minWidth: 180 }}>
                  <div className="row" style={{ gap: 4 }}>
                    <input className="input mono" data-testid="loop-ref-new-name" style={{ width: 120 }} placeholder="Column_Name"
                      value={newCol.name} onChange={(e) => setNewCol({ ...newCol, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") addColumn(); }} />
                    <select className="select small" value={newCol.dataType ?? "text"} onChange={(e) => setNewCol({ ...newCol, dataType: e.target.value as LoopReferenceColumn["dataType"] })}>
                      <option value="text">text</option><option value="number">number</option><option value="boolean">yes/no</option>
                    </select>
                    <button className="btn small primary" data-testid="loop-ref-add" onClick={addColumn}>+ Add Reference Column</button>
                  </div>
                  {colError && <div className="muted" data-testid="loop-ref-error" style={{ color: "var(--red)", fontSize: 11 }}>{colError}</div>}
                </th>
              </tr>
            </thead>
            <tbody>
              {(items ?? Object.keys(refs.values).map((code) => ({ code, label: code }))).map((it) => (
                <tr key={it.code} data-testid="loop-ref-row" data-code={it.code}>
                  <td>{it.label}</td>
                  <td className="mono">{it.code}</td>
                  {columns.map((c) => {
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
                <tr><td colSpan={columns.length + 3} className="muted" style={{ fontSize: 11 }}>The source has no items yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Inside the loop, pipe with <code>{"{{loop.label}}"}</code>, <code>{"{{loop.code}}"}</code>, <code>{"{{loop.index}}"}</code>, <code>{"{{loop.count}}"}</code>
          {columns.length ? <>, <code>{`{{loop.${columns[0].name}}}`}</code>{columns.length > 1 ? "…" : ""}</> : null}
          {" "}(or <code>{"{{CURRENT_ITEM.Column}}"}</code>). Conditions: <code>loop.{columns[0]?.name ?? "Column"} = "…"</code>.
          {scope.length > 1 ? <> An outer loop is <code>{`{{${scope[1].loopVar}.label}}`}</code>.</> : null}
        </p>
      </div>

      {/* ------------------------------------------------ simulator */}
      <div className="loop-sim" data-testid="loop-simulator" style={{ marginTop: 12 }}>
        <div className="row">
          <button className="btn small" data-testid="loop-sim-toggle" onClick={() => setSimOpen((v) => !v)}>{simOpen ? "▾" : "▸"} Loop simulator</button>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>what this loop does for a respondent who answers as below — the runtime’s own resolution, not a mock</span>
        </div>
        {simOpen && (
          <div style={{ marginTop: 8 }}>
            {src.kind === "question" && sourceQuestion && (
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 11 }}>{sourceQuestion.code} selected:</span>
                {sourceQuestion.options.map((o) => (
                  <label key={String(o.code)} className="row" style={{ gap: 3, fontSize: 12 }}>
                    <input type="checkbox" data-testid="loop-sim-option" data-code={String(o.code)} checked={simCodes.includes(String(o.code))}
                      onChange={(e) => setSimCodes((cs) => (e.target.checked ? [...cs, String(o.code)] : cs.filter((c) => c !== String(o.code))))} />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
            {simulation && (
              <div data-testid="loop-sim-result">
                <div style={{ fontSize: 12, marginBottom: 4 }}><strong>{simulation.count}</strong> iteration{simulation.count === 1 ? "" : "s"}</div>
                {simulation.iterations.map((it) => (
                  <div key={it.index} className="loop-sim-iter" data-testid="loop-sim-iteration" style={{ fontSize: 12, padding: "4px 8px", borderLeft: "2px solid var(--border)", marginBottom: 4 }}>
                    <div><strong>Iteration {it.index}</strong> — item = {it.label} <span className="mono muted">({it.code})</span></div>
                    {simulation.columns.length > 0 && (
                      <div className="muted" style={{ paddingLeft: 10 }}>
                        {simulation.columns.map((c) => <div key={c}>{c} = <span className="mono">{it.references[c] == null ? "∅" : String(it.references[c])}</span></div>)}
                      </div>
                    )}
                  </div>
                ))}
                {simulation.count === 0 && <div className="muted" style={{ fontSize: 12 }}>No iterations for these answers.</div>}
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
      {label ? <span className="muted" style={{ fontSize: 11 }}>{label}</span> : null}
    </span>
  );
}
