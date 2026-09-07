"use client";
import React from "react";
import { designGeneratorRegistry, type DesignReference } from "@rescript/schema";
import { registerBuiltinDesignGenerators, designToCSV, designFileName } from "@rescript/designs";
import { designVersionCount } from "@rescript/engine";
import { useStudio, uid } from "./store";

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
          </select></label>
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
      const pairs: { a: { attribute: string; level: string }; b: { attribute: string; level: string }; note?: string }[] =
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
    default:
      return (
        <label className="f"><span>{field.label}</span>
          <input className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} /></label>
      );
  }
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

  const attach = (file: { columns: string[]; rows: Record<string, unknown>[] }) => {
    s.update((d) => {
      if (existing) {
        const i = d.designs.findIndex((x) => x.id === existing.id);
        if (i >= 0) {
          d.designs[i] = {
            ...d.designs[i], name, seed, config,
            version: d.designs[i].version + 1,
            file: { format: "json", columns: file.columns, rows: file.rows, generatedAt: new Date().toISOString() },
          };
        }
      } else {
        d.designs.push({
          id: uid("design"), kind, name, version: 1, seed, config,
          file: { format: "json", columns: file.columns, rows: file.rows, generatedAt: new Date().toISOString() },
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
          {preview.summary && <pre className="logic-pre" style={{ marginTop: 8 }}>{JSON.stringify(preview.summary, null, 2)}</pre>}
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
        </div>
      ))}
    </div>
  );
}
