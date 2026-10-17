"use client";
import React from "react";
import { designGeneratorRegistry, type DesignReference } from "@rescript/schema";
import { registerBuiltinDesignGenerators, designToCSV, designFileName, measureMaxDiffDesign, type MaxDiffDiagnostics } from "@rescript/designs";
import { designVersionCount } from "@rescript/engine";
import { useStudio, uid } from "./store";
import { ConjointDesignQuality } from "./ConjointDesignQuality";

registerBuiltinDesignGenerators();

/**
 * Research Design Generator (requirements §16–18) — kept OUT of the question
 * builder. Conjoint, MaxDiff and the generic custom generator ship built-in;
 * more arrive as plugins via designGeneratorRegistry.register().
 */

function ConfigField({ field, value, onChange, config }: {
  field: { name: string; label: string; type: string; options?: string[]; help?: string };
  value: unknown; onChange(v: unknown): void;
  /** the whole config, so a field can offer choices drawn from another field */
  config?: Record<string, unknown>;
}) {
  switch (field.type) {
    case "number":
      return (
        <label className="f"><span>{field.label}</span>
          <input className="input" style={{ width: 120 }} type="number" value={value == null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
          {field.help && <div className="muted" style={{ fontSize: 12.5 }}>{field.help}</div>}
        </label>
      );
    case "boolean":
      return (
        <label className="row" style={{ gap: 6, marginBottom: 10 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
        </label>
      );
    case "select":
      return (
        <label className="f"><span>{field.label}</span>
          <select className="select" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {field.help && <div className="muted" style={{ fontSize: 12.5 }}>{field.help}</div>}</label>
      );
    case "list": {
      const items: string[] = Array.isArray(value) ? (value as string[]) : [];
      return (
        <label className="f"><span>{field.label} (one per line)</span>
          <textarea className="ta" value={items.join("\n")}
            onChange={(e) => onChange(e.target.value.split("\n").filter((x) => x.trim()))} />
        </label>
      );
    }
    case "attributes": {
      const attrs: { name: string; levels: string[] }[] = Array.isArray(value) ? (value as any) : [];
      return (
        <div style={{ marginBottom: 10 }}>
          <span className="flabel">{field.label}</span>
          {attrs.map((a, i) => (
            <div key={i} className="card" style={{ padding: 8 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <input className="input" style={{ width: 200 }} value={a.name} placeholder="Attribute name"
                  onChange={(e) => onChange(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <button className="btn small danger" onClick={() => onChange(attrs.filter((_, j) => j !== i))}>×</button>
              </div>
              <textarea className="ta" style={{ minHeight: 54 }} placeholder="levels, one per line"
                value={a.levels.join("\n")}
                onChange={(e) => onChange(attrs.map((x, j) => (j === i ? { ...x, levels: e.target.value.split("\n").filter(Boolean) } : x)))} />
            </div>
          ))}
          <button className="btn small" onClick={() => onChange([...attrs, { name: `Attribute ${attrs.length + 1}`, levels: [] }])}>
            + attribute
          </button>
        </div>
      );
    }
    /**
     * PROHIBITIONS — pairs of levels that may never share a concept.
     *
     * Two dependent pickers rather than free text, because a prohibition that
     * names a level the design does not have is silently no prohibition at
     * all, and that is the kind of mistake nobody finds until the utilities
     * look wrong. The choices come from the attributes above, so the pair is
     * always expressible.
     */
    case "prohibitions": {
      type Lv = { attribute: string; level: string };
      const pairs: { a: Lv; b: Lv; also?: Lv[]; alsoOp?: "and" | "or"; when?: unknown; note?: string }[] =
        Array.isArray(value) ? (value as never) : [];
      const attrs: { name: string; levels: string[] }[] = Array.isArray(config?.attributes)
        ? (config!.attributes as never) : [];
      const usable = attrs.filter((a) => a.name && a.levels?.length);
      const levelsOf = (name: string) => usable.find((a) => a.name === name)?.levels ?? [];
      const set = (i: number, patch: Partial<typeof pairs[number]>) =>
        onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));

      if (usable.length < 2) {
        return (
          <div style={{ marginBottom: 10 }}>
            <span className="flabel">{field.label}</span>
            <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 0" }}>
              Add at least two attributes with levels first — a prohibition pairs a level of one with a level of another.
            </p>
          </div>
        );
      }
      return (
        <div style={{ marginBottom: 10 }} data-testid="prohibitions-editor">
          <span className="flabel">{field.label}</span>
          {field.help && <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{field.help}</div>}
          {pairs.map((p, i) => (
            <div key={i} className="row proh-row" data-testid="prohibition" style={{ marginBottom: 6, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12.5 }}>never</span>
              <select className="select" style={{ width: 150 }} value={p.a.attribute}
                onChange={(e) => set(i, { a: { attribute: e.target.value, level: levelsOf(e.target.value)[0] ?? "" } })}>
                {usable.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
              <select className="select" style={{ width: 150 }} value={p.a.level}
                onChange={(e) => set(i, { a: { ...p.a, level: e.target.value } })}>
                {levelsOf(p.a.attribute).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 12.5 }}>with</span>
              <select className="select" style={{ width: 150 }} value={p.b.attribute}
                onChange={(e) => set(i, { b: { attribute: e.target.value, level: levelsOf(e.target.value)[0] ?? "" } })}>
                {usable.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
              </select>
              <select className="select" style={{ width: 150 }} value={p.b.level}
                onChange={(e) => set(i, { b: { ...p.b, level: e.target.value } })}>
                {levelsOf(p.b.attribute).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <button className="btn small danger" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>×</button>
              {/*
                * A COMBINATION, not only a pair: "never Value at $999 AND
                * (2 years OR 3 years)". The extra levels are ANDed with the
                * pair; with "any of" one of them is enough.
                */}
              {(p.also ?? []).length > 0 && (
                <span className="row" style={{ gap: 6, flexBasis: "100%", flexWrap: "wrap", marginLeft: 40 }} data-testid="prohibition-also">
                  <span className="muted" style={{ fontSize: 12.5 }}>and</span>
                  {(p.also ?? []).length > 1 && (
                    <select className="select" style={{ width: 110 }} value={p.alsoOp ?? "and"} data-testid="prohibition-also-op"
                      onChange={(e) => set(i, { alsoOp: e.target.value as "and" | "or" })}>
                      <option value="and">all of</option>
                      <option value="or">any of</option>
                    </select>
                  )}
                  {(p.also ?? []).map((x, k) => (
                    <span key={k} className="row" style={{ gap: 4 }}>
                      <select className="select" style={{ width: 130 }} value={x.attribute}
                        onChange={(e) => set(i, { also: p.also!.map((y, m) => (m === k ? { attribute: e.target.value, level: levelsOf(e.target.value)[0] ?? "" } : y)) })}>
                        {usable.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                      </select>
                      <select className="select" style={{ width: 120 }} value={x.level}
                        onChange={(e) => set(i, { also: p.also!.map((y, m) => (m === k ? { ...y, level: e.target.value } : y)) })}>
                        {levelsOf(x.attribute).map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                      <button className="btn small" title="Remove this level" onClick={() => set(i, { also: p.also!.filter((_, m) => m !== k) })}>×</button>
                    </span>
                  ))}
                </span>
              )}
              {!p.when && (
                <button className="btn small ghost" data-testid="prohibition-add-level" title="Add a third level to the combination"
                  onClick={() => set(i, { also: [...(p.also ?? []), { attribute: usable[usable.length - 1].name, level: usable[usable.length - 1].levels[0] }] })}>
                  + level
                </button>
              )}
              {!!p.when && <span className="muted" style={{ fontSize: 12.5 }}>(a combination rule — written in the design file)</span>}
            </div>
          ))}
          <button className="btn small" data-testid="add-prohibition"
            onClick={() => onChange([...pairs, {
              a: { attribute: usable[0].name, level: usable[0].levels[0] },
              b: { attribute: usable[1].name, level: usable[1].levels[0] },
            }])}>
            + prohibition
          </button>
        </div>
      );
    }
    /**
     * MAXDIFF PROHIBITED PAIRS (MD-P1) — two items that may never share a
     * task. Pickers over the design's own item list, for the same reason as
     * the conjoint prohibitions above: a pair naming an item the list does
     * not have is silently no prohibition at all.
     */
    case "itemPairs": {
      const pairs: [string, string][] = Array.isArray(value) ? (value as [string, string][]) : [];
      const items: string[] = Array.isArray(config?.items) ? (config!.items as string[]).filter((x) => x.trim()) : [];
      if (items.length < 2) {
        return (
          <div style={{ marginBottom: 10 }}>
            <span className="flabel">{field.label}</span>
            <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 0" }}>Add items first — a prohibited pair names two of them.</p>
          </div>
        );
      }
      const set = (i: number, j: 0 | 1, v: string) =>
        onChange(pairs.map((p, k) => (k === i ? (j === 0 ? [v, p[1]] : [p[0], v]) : p)));
      return (
        <div style={{ marginBottom: 10 }} data-testid="md-pairs-editor">
          <span className="flabel">{field.label}</span>
          {field.help && <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{field.help}</div>}
          {pairs.map((p, i) => (
            <div key={i} className="row" data-testid="md-pair" style={{ marginBottom: 6, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12.5 }}>never</span>
              <select className="select" style={{ width: 180 }} value={p[0]} onChange={(e) => set(i, 0, e.target.value)}>
                {items.map((it) => <option key={it} value={it}>{it}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 12.5 }}>with</span>
              <select className="select" style={{ width: 180 }} value={p[1]} onChange={(e) => set(i, 1, e.target.value)}>
                {items.map((it) => <option key={it} value={it}>{it}</option>)}
              </select>
              <button className="btn small danger" onClick={() => onChange(pairs.filter((_, k) => k !== i))}>×</button>
            </div>
          ))}
          <button className="btn small" data-testid="add-md-pair"
            onClick={() => onChange([...pairs, [items[0], items[1]]])}>+ prohibited pair</button>
        </div>
      );
    }
    default:
      return (
        <label className="f"><span>{field.label}</span>
          <input className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} /></label>
      );
  }
}

/**
 * MAXDIFF DESIGN BALANCE, AS MEASURED (MD-P1).
 *
 * The numbers come from `measureMaxDiffDesign` on the rows themselves — item
 * show counts, pair co-occurrence, positions, prohibited pairs — so whatever
 * this says about balance is a measurement. "Balanced" is shown only when the
 * spreads are the smallest the counts allow; otherwise it says near-balanced
 * or uneven, with the numbers.
 */
function MaxDiffBalance({ diagnostics }: { diagnostics: Pick<MaxDiffDiagnostics, "lines" | "warnings" | "balanced"> }) {
  return (
    <div data-testid="md-balance" style={{ marginTop: 8, fontSize: 12.5 }}>
      <span className={`chip ${diagnostics.balanced ? "" : "warn"}`} data-testid="md-balance-verdict">
        {diagnostics.balanced ? "balanced (as even as the counts allow)" : "not exactly balanced — see the numbers"}
      </span>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {diagnostics.lines.map((l, i) => <li key={i}>{l}</li>)}
        {diagnostics.warnings.map((w, i) => <li key={`w${i}`} style={{ color: "var(--warn, #b45309)" }}>{w}</li>)}
      </ul>
    </div>
  );
}

/** The balance of an attached MaxDiff design — stored by the generator, or measured now for an older or imported file. */
function maxdiffDiagnosticsOf(d: DesignReference): Pick<MaxDiffDiagnostics, "lines" | "warnings" | "balanced"> | null {
  const rows = (d.file?.rows ?? []) as Record<string, unknown>[];
  if (!rows.length || !rows[0] || !("item_index" in rows[0])) return null;
  const stored = (d.file?.summary as { diagnostics?: Partial<MaxDiffDiagnostics> } | undefined)?.diagnostics;
  if (stored?.lines && stored.warnings) return stored as MaxDiffDiagnostics;
  const cfg = (d.config ?? {}) as { items?: string[]; prohibitedPairs?: [string, string][] };
  const byIndex = new Map<number, string>();
  for (const r of rows) byIndex.set(Number(r.item_index), String(r.item_label ?? r.item_index));
  const items = Array.isArray(cfg.items) && cfg.items.length
    ? cfg.items
    : Array.from({ length: Math.max(0, ...byIndex.keys()) }, (_, i) => byIndex.get(i + 1) ?? `Item ${i + 1}`);
  return measureMaxDiffDesign(rows, items, { prohibitedPairs: cfg.prohibitedPairs });
}

function GeneratorForm({ kind, existing, onDone }: {
  kind: string; existing?: DesignReference; onDone(): void;
}) {
  const s = useStudio();
  const plugin = designGeneratorRegistry.get(kind)!;
  const [name, setName] = React.useState(existing?.name ?? `${plugin.label} design`);
  const [seed, setSeed] = React.useState<number>(existing?.seed ?? Math.floor(Math.random() * 100000));
  const [config, setConfig] = React.useState<Record<string, unknown>>(() => {
    if (existing?.config) return structuredClone(existing.config);
    const c: Record<string, unknown> = {};
    for (const f of plugin.configFields) if (f.default !== undefined) c[f.name] = structuredClone(f.default);
    return c;
  });
  const [errors, setErrors] = React.useState<string[]>([]);
  const [preview, setPreview] = React.useState<{ columns: string[]; rows: Record<string, unknown>[]; summary?: any } | null>(null);

  /**
   * Generating used to only set local preview state; a separate "Attach to
   * survey" button — which appeared mid-form only after a successful generate
   * — was what actually added the design. Miss it and the question editor's
   * design picker stays empty forever while the generator looks like it
   * worked. Generate now previews AND attaches in one step.
   */
  const generate = () => {
    const errs = plugin.validateConfig?.(config) ?? [];
    setErrors(errs);
    if (errs.length) return;
    try {
      const file = plugin.generate(config, seed);
      setPreview(file);
      attach(file);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    }
  };

  const attach = (file: { columns: string[]; rows: Record<string, unknown>[]; summary?: Record<string, unknown> }) => {
    s.update((d) => {
      if (existing) {
        const i = d.designs.findIndex((x) => x.id === existing.id);
        if (i >= 0) {
          d.designs[i] = {
            ...d.designs[i], name, seed, config,
            version: d.designs[i].version + 1,
            file: { format: "json", columns: file.columns, rows: file.rows, ...(file.summary ? { summary: file.summary } : {}), generatedAt: new Date().toISOString() },
          };
        }
      } else {
        d.designs.push({
          id: uid("design"), kind, name, version: 1, seed, config,
          file: { format: "json", columns: file.columns, rows: file.rows, ...(file.summary ? { summary: file.summary } : {}), generatedAt: new Date().toISOString() },
        });
      }
    });
    s.toast(`Design "${name}" attached — pick it on a ${kind} question (${file.rows.length} rows)`);
  };

  const save = () => {
    if (!preview) return;
    attach(preview);
    onDone();
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>{plugin.label}</strong>
        <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="row" style={{ gap: 4 }}>seed
          <input className="input mono" style={{ width: 100 }} type="number" value={seed}
            onChange={(e) => setSeed(Number(e.target.value))} /></label>
      </div>
      {plugin.configFields.map((f) => (
        <ConfigField key={f.name} field={f} value={config[f.name]} config={config}
          onChange={(v) => setConfig((c) => ({ ...c, [f.name]: v }))} />
      ))}
      {errors.map((e, i) => <div key={i} className="chip warn" style={{ marginBottom: 6 }}>{e}</div>)}
      <div className="row">
        <button className="btn primary" onClick={generate}>Generate Design File</button>
        {preview && <button className="btn" onClick={save}>✓ Attach to survey</button>}
        {preview && (
          <button className="btn" onClick={() => {
            const csv = designToCSV({ columns: preview.columns, rows: preview.rows });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            a.download = designFileName(kind, name, existing ? existing.version + 1 : 1, "csv");
            a.click();
          }}>⬇ CSV</button>
        )}
        <span className="grow" />
        <button className="btn small" onClick={onDone}>close</button>
      </div>
      {preview && (
        <>
          <div className="flabel" style={{ marginTop: 12 }}>
            preview — {preview.rows.length} rows{preview.summary ? " · summary below" : ""}
          </div>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
            <table className="grid">
              <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {preview.rows.slice(0, 30).map((r, i) => (
                  <tr key={i}>{preview.columns.map((c) => <td key={c}>{String(r[c] ?? "")}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {kind === "maxdiff" && preview.summary?.diagnostics?.lines && <MaxDiffBalance diagnostics={preview.summary.diagnostics} />}
          {/* conjoint audit 2026-10-17: the measured quality, readable; the raw summary stays one click away */}
          {preview.summary && kind === "conjoint" && <ConjointDesignQuality summary={preview.summary} />}
          {preview.summary && (kind === "conjoint"
            ? <details style={{ marginTop: 8 }}><summary className="muted" style={{ fontSize: 12.5 }}>raw summary</summary><pre className="logic-pre">{JSON.stringify(preview.summary, null, 2)}</pre></details>
            : <pre className="logic-pre" style={{ marginTop: 8 }}>{JSON.stringify(preview.summary, null, 2)}</pre>)}
        </>
      )}
    </div>
  );
}

/**
 * BRINGING A DESIGN IN FROM OUTSIDE.
 *
 * Everything here could generate a design and export it, and there was no way
 * to bring one IN: no file input anywhere in this panel. A study whose design
 * was built in Sawtooth, JMP or by a methodologist in a spreadsheet could not
 * be fielded on this platform at all, however ordinary that is — a client
 * supplying the design is normal in agency work, and so is reusing last
 * wave's.
 *
 * An imported design is a first-class `DesignReference` with `kind:
 * "imported"`: it has no config and no seed to regenerate from, which is
 * exactly true of it, and the panel says so rather than pretending it could
 * be regenerated.
 */
function ImportDesign() {
  const s = useStudio();
  const [error, setError] = React.useState<string | null>(null);

  const onFile = async (f: File) => {
    setError(null);
    try {
      const text = await f.text();
      const { columns, rows } = parseDesignCsv(text);
      /*
       * A design the runtime cannot read is worse than no design: the survey
       * would field an empty task. `task` is the one column everything needs
       * — the renderer groups by it and the analysis matches on it.
       */
      if (!columns.includes("task")) {
        throw new Error("a design file needs a “task” column — that is how tasks are grouped and matched back to answers.");
      }
      const name = f.name.replace(/\.[^.]+$/, "");
      s.labelNextEdit("import design");
      s.update((d) => {
        d.designs.push({
          id: uid("design"), kind: "imported", name, version: 1,
          config: { importedFrom: f.name, importedAt: new Date().toISOString() },
          file: { format: "csv", columns, rows, generatedAt: new Date().toISOString() },
        } as never);
      });
      s.toast(`Imported "${name}" — ${rows.length} rows, ${columns.length} columns. Pick it on a Conjoint or MaxDiff question.`);
    } catch (e) {
      setError(`That file could not be imported: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      <label className="btn" style={{ cursor: "pointer" }} title="Bring in a design built elsewhere — CSV or TSV">
        ⬆ Import design file
        <input type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }} data-testid="import-design"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
      </label>
      {error && <span className="chip warn" data-testid="import-design-error">{error}</span>}
    </>
  );
}

/**
 * Read a design CSV or TSV.
 *
 * Deliberately small and local: a design file is a rectangle of levels, and
 * the platform's response-import parser is about mapping columns to
 * questions, which is a different job. Numbers come back as numbers because
 * `version`, `task`, `alt`, `is_holdout` and `none_option` are all compared
 * numerically downstream.
 */
export function parseDesignCsv(text: string): { columns: string[]; rows: Record<string, unknown>[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("there are no data rows under the header.");
  const delim = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const split = (line: string) => {
    /* quoted fields, because a level label may contain the delimiter */
    const out: string[] = [];
    let cur = ""; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const columns = split(lines[0]).filter((h) => h.length > 0);
  if (columns.length === 0) throw new Error("the header row has no column names.");
  const dupes = columns.filter((h, i) => columns.indexOf(h) !== i);
  if (dupes.length) throw new Error(`the header has more than one “${dupes[0]}” column.`);
  const rows = lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Record<string, unknown> = {};
    columns.forEach((h, i) => {
      const raw = cells[i] ?? "";
      const num = raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
      row[h] = num !== null ? num : raw;
    });
    return row;
  });
  return { columns, rows };
}

export function DesignsPanel() {
  const s = useStudio();
  const [openKind, setOpenKind] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<DesignReference | null>(null);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Research Design Generators</h2>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Generate versioned, seeded design files (Conjoint, MaxDiff, custom). Reference them from a
        <em> Conjoint tasks</em> / <em>MaxDiff tasks</em> question, or loop over tasks in the Survey Flow.
        New methodologies plug in via <code>designGeneratorRegistry.register()</code>.
      </p>

      <div className="row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {designGeneratorRegistry.all().map((p) => (
          <button key={p.kind} className="btn" onClick={() => { setEditing(null); setOpenKind(p.kind); }}>
            + {p.label}
          </button>
        ))}
        <span className="grow" />
        <ImportDesign />
      </div>

      {(openKind || editing) && (
        <GeneratorForm kind={editing?.kind ?? openKind!} existing={editing ?? undefined}
          onDone={() => { setOpenKind(null); setEditing(null); }} />
      )}

      <h3 className="sec">Attached design files</h3>
      {s.def.designs.length === 0 && <p className="muted">None yet.</p>}
      {s.def.designs.map((d) => (
        <div key={d.id} className="card">
          <div className="row">
            <strong>{d.name}</strong>
            <span className="qtype-badge">{d.kind}</span>
            <span className="chip">v{d.version}</span>
            <span className="muted mono" style={{ fontSize: 12.5 }}>
              {d.kind === "imported"
                ? `from ${String(d.config?.importedFrom ?? "a file")}`
                : `seed ${d.seed}`}
              {" · "}{d.file?.rows.length ?? 0} rows
              {" · "}{d.file?.generatedAt?.slice(0, 19) ?? "not generated"}
              {d.file?.rows.length ? ` · ${designVersionCount(d.file.rows as Record<string, unknown>[])} version${designVersionCount(d.file.rows as Record<string, unknown>[]) === 1 ? "" : "s"}` : ""}
            </span>
            <span className="grow" />
            {/* an imported design has no config or seed to regenerate FROM,
                so it is not offered — importing again replaces it */}
            {d.kind !== "imported" ? (
              <button className="btn small" onClick={() => { setOpenKind(null); setEditing(d); }}>regenerate</button>
            ) : (
              <span className="chip" data-testid="design-imported" title="Brought in from a file — there is no configuration to regenerate from">imported</span>
            )}
            {d.file && (
              <button className="btn small" onClick={() => {
                const csv = designToCSV({ columns: d.file!.columns, rows: d.file!.rows });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                a.download = designFileName(d.kind, d.name, d.version, "csv");
                a.click();
              }}>⬇ CSV</button>
            )}
            <button className="btn small danger" onClick={() =>
              s.update((x) => { x.designs = x.designs.filter((y) => y.id !== d.id); })}>×</button>
          </div>
          {d.kind === "conjoint" && d.file?.summary && <ConjointDesignQuality compact summary={d.file.summary as Record<string, unknown>} />}
          {(d.kind === "maxdiff" || d.kind === "imported") && (() => {
            const diag = maxdiffDiagnosticsOf(d);
            return diag ? <MaxDiffBalance diagnostics={diag} /> : null;
          })()}
        </div>
      ))}
    </div>
  );
}
