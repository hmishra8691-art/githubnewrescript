"use client";
import React from "react";
import { designGeneratorRegistry, type DesignReference } from "@rescript/schema";
import { registerBuiltinDesignGenerators, designToCSV, designFileName } from "@rescript/designs";
import { useStudio, uid } from "./store";

registerBuiltinDesignGenerators();

/**
 * Research Design Generator (requirements §16–18) — kept OUT of the question
 * builder. Conjoint, MaxDiff and the generic custom generator ship built-in;
 * more arrive as plugins via designGeneratorRegistry.register().
 */

function ConfigField({ field, value, onChange }: {
  field: { name: string; label: string; type: string; options?: string[]; help?: string };
  value: unknown; onChange(v: unknown): void;
}) {
  switch (field.type) {
    case "number":
      return (
        <label className="f"><span>{field.label}</span>
          <input className="input" style={{ width: 120 }} type="number" value={value == null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
          {field.help && <div className="muted" style={{ fontSize: 11 }}>{field.help}</div>}
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

  const generate = () => {
    const errs = plugin.validateConfig?.(config) ?? [];
    setErrors(errs);
    if (errs.length) return;
    try {
      const file = plugin.generate(config, seed);
      setPreview(file);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    }
  };

  const save = () => {
    if (!preview) return;
    s.update((d) => {
      if (existing) {
        const i = d.designs.findIndex((x) => x.id === existing.id);
        if (i >= 0) {
          d.designs[i] = {
            ...d.designs[i], name, seed, config,
            version: d.designs[i].version + 1,
            file: { format: "json", columns: preview.columns, rows: preview.rows, generatedAt: new Date().toISOString() },
          };
        }
      } else {
        d.designs.push({
          id: uid("design"), kind, name, version: 1, seed, config,
          file: { format: "json", columns: preview.columns, rows: preview.rows, generatedAt: new Date().toISOString() },
        });
      }
    });
    s.toast(`Design "${name}" generated (${preview.rows.length} rows)`);
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
        <ConfigField key={f.name} field={f} value={config[f.name]}
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

export function DesignsPanel() {
  const s = useStudio();
  const [openKind, setOpenKind] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<DesignReference | null>(null);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Research Design Generators</h2>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
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
            <span className="muted mono" style={{ fontSize: 11 }}>
              seed {d.seed} · {d.file?.rows.length ?? 0} rows · {d.file?.generatedAt?.slice(0, 19) ?? "not generated"}
            </span>
            <span className="grow" />
            <button className="btn small" onClick={() => { setOpenKind(null); setEditing(d); }}>regenerate</button>
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
