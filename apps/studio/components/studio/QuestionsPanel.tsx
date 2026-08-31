"use client";
import React from "react";
import type { Question, Option, QuestionColumn, ResponseType } from "@rescript/schema";
import { questionTypeRegistry } from "@rescript/schema";
import "@rescript/engine"; // ensures builtin question types are registered
import { useStudio, uid } from "./store";

const RESPONSE_TYPES: ResponseType[] = [
  "single", "multi", "dropdown", "multi_dropdown", "text", "longtext",
  "numeric", "date", "time", "slider", "checkbox",
];

function OptionRows({ options, onChange, showFlags = true }: {
  options: Option[]; onChange(opts: Option[]): void; showFlags?: boolean;
}) {
  const set = (i: number, patch: Partial<Option>) =>
    onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div>
      {options.map((o, i) => (
        <div key={i} className="opt-row">
          <input className="input code-input" value={String(o.code)}
            onChange={(e) => set(i, { code: e.target.value })} title="code" />
          <input className="input grow" value={o.label}
            onChange={(e) => set(i, { label: e.target.value })} placeholder="label (piping {{Q1}} allowed)" />
          {showFlags && (
            <select className="select" style={{ width: 110 }} value={o.flags?.[0] ?? ""}
              onChange={(e) => set(i, { flags: e.target.value ? [e.target.value as any] : [] })}>
              <option value="">flags…</option>
              <option value="exclusive">exclusive</option>
              <option value="other_specify">other/specify</option>
              <option value="none_of_above">none of above</option>
              <option value="dont_know">don&apos;t know</option>
              <option value="refused">refused</option>
              <option value="anchor_top">anchor top</option>
              <option value="anchor_bottom">anchor bottom</option>
            </select>
          )}
          <button className="btn small" onClick={() => move(i, -1)}>↑</button>
          <button className="btn small" onClick={() => move(i, 1)}>↓</button>
          <button className="btn small danger" onClick={() => onChange(options.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row">
        <button className="btn small" onClick={() =>
          onChange([...options, { code: String(options.length + 1), label: "", flags: [] }])}>
          + option
        </button>
        <button className="btn small" onClick={() => {
          const text = prompt("Paste options, one per line (\"code<TAB>label\" or just labels):");
          if (!text) return;
          const parsed = text.split("\n").filter(Boolean).map((line, i) => {
            const [a, b] = line.split("\t");
            return b !== undefined
              ? { code: a.trim(), label: b.trim(), flags: [] as any[] }
              : { code: String(options.length + i + 1), label: line.trim(), flags: [] as any[] };
          });
          onChange([...options, ...parsed]);
        }}>
          paste list
        </button>
      </div>
    </div>
  );
}

function ColumnEditor({ q, onChange }: { q: Question; onChange(cols: QuestionColumn[]): void }) {
  const cols = q.columns;
  const set = (i: number, patch: Partial<QuestionColumn>) =>
    onChange(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div>
      {cols.map((c, i) => (
        <div key={c.id} className="card" style={{ padding: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input grow" value={c.label} placeholder="Column label"
              onChange={(e) => set(i, { label: e.target.value })} />
            <select className="select" style={{ width: 140 }} value={c.responseType}
              onChange={(e) => set(i, { responseType: e.target.value as ResponseType })}>
              {RESPONSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="input mono" style={{ width: 120 }} value={c.variableStem}
              title="variable stem — variables become STEM_<row>"
              onChange={(e) => set(i, { variableStem: e.target.value.toUpperCase() })} />
            <button className="btn small" onClick={() => move(i, -1)}>↑</button>
            <button className="btn small" onClick={() => move(i, 1)}>↓</button>
            <button className="btn small danger" onClick={() => onChange(cols.filter((_, j) => j !== i))}>×</button>
          </div>
          {["single", "multi", "dropdown", "multi_dropdown"].includes(c.responseType) && (
            <OptionRows options={c.options} showFlags={false}
              onChange={(opts) => set(i, { options: opts })} />
          )}
          <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
            {(c.responseType === "numeric" || c.responseType === "slider") && (
              <>
                <input className="input" style={{ width: 76 }} type="number" placeholder="min"
                  value={c.min ?? ""} onChange={(e) => set(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                <input className="input" style={{ width: 76 }} type="number" placeholder="max"
                  value={c.max ?? ""} onChange={(e) => set(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </>
            )}
            <input className="input" style={{ width: 110 }} placeholder="width e.g. 120px"
              value={c.width ?? ""} onChange={(e) => set(i, { width: e.target.value || undefined })} />
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={c.readOnly}
                onChange={(e) => set(i, { readOnly: e.target.checked })} /> read-only
            </label>
            <label className="row" style={{ gap: 4, fontSize: 12 }}>
              required
              <input type="checkbox"
                checked={c.validation.some((v) => v.kind === "required")}
                onChange={(e) => set(i, {
                  validation: e.target.checked
                    ? [...c.validation, { kind: "required" as const }]
                    : c.validation.filter((v) => v.kind !== "required"),
                })} />
            </label>
          </div>
          <input className="input mono" style={{ marginTop: 6 }}
            placeholder="calculated expression (makes cell read-only), e.g. RATING_{{row}} * 2"
            value={c.expression ?? ""}
            onChange={(e) => set(i, { expression: e.target.value || undefined })} />
        </div>
      ))}
      <button className="btn small" onClick={() =>
        onChange([...cols, {
          id: uid("col"), label: `Column ${cols.length + 1}`, responseType: "text",
          variableStem: `${q.variableName}_C${cols.length + 1}`, options: [], validation: [],
          readOnly: false,
        }])}>
        + column
      </button>
    </div>
  );
}

export function QuestionEditor({ q }: { q: Question }) {
  const s = useStudio();
  const plugin = questionTypeRegistry.get(q.type);
  const feats = plugin?.features ?? {};
  const patch = (p: Partial<Question>) =>
    s.update((d) => {
      const i = d.questions.findIndex((x) => x.id === q.id);
      if (i >= 0) d.questions[i] = { ...d.questions[i], ...p } as Question;
    });
  const patchSettings = (p: Partial<Question["settings"]>) =>
    patch({ settings: { ...q.settings, ...p } });

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="f" style={{ width: 90, marginBottom: 0 }}><span>Code</span>
          <input className="input mono" value={q.code} onChange={(e) => patch({ code: e.target.value })} /></label>
        <label className="f grow" style={{ marginBottom: 0 }}><span>Variable name</span>
          <input className="input mono" value={q.variableName}
            onChange={(e) => patch({ variableName: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} /></label>
        <label className="f" style={{ width: 190, marginBottom: 0 }}><span>Type</span>
          <select className="select" value={q.type} onChange={(e) => patch({ type: e.target.value })}>
            {questionTypeRegistry.all().map((p) => (
              <option key={p.type} value={p.type}>{p.label}</option>
            ))}
          </select></label>
      </div>

      <label className="f"><span>Question text (HTML + piping tokens allowed)</span>
        <textarea className="ta" value={q.text} onChange={(e) => patch({ text: e.target.value })}
          placeholder='e.g. Earlier you selected {{Q1}}. Why did you choose {{Q1.first}}?' /></label>
      <div className="row">
        <label className="f grow"><span>Instruction</span>
          <input className="input" value={q.instruction ?? ""}
            onChange={(e) => patch({ instruction: e.target.value || undefined })} /></label>
        <label className="f" style={{ width: 120 }}><span>Required</span>
          <select className="select" value={q.required ? "1" : "0"}
            onChange={(e) => patch({ required: e.target.value === "1" })}>
            <option value="0">optional</option><option value="1">required</option>
          </select></label>
      </div>

      {feats.options && (
        <>
          <h3 className="sec">Options</h3>
          <OptionRows options={q.options} onChange={(options) => patch({ options })} />
        </>
      )}

      {feats.rows && q.type !== "numeric_list" && q.type !== "text_list" && (
        <>
          <h3 className="sec">Rows</h3>
          <OptionRows showFlags={false}
            options={q.rows.map((r) => ({ code: r.code, label: r.label, flags: r.flags ?? [] }))}
            onChange={(rows) => patch({ rows: rows.map((r) => ({ code: r.code, label: r.label, flags: [] })) })} />
          {q.carryForward?.into === "rows" && (
            <p className="muted" style={{ fontSize: 12 }}>
              Rows are carried forward from {s.def.questions.find((x) => x.id === q.carryForward?.sourceQuestionId)?.code ?? "?"} —
              static rows above are {q.carryForward.keepOwn ? "appended" : "ignored"}.
            </p>
          )}
        </>
      )}

      {feats.columns && (
        <>
          <h3 className="sec">Columns {q.type === "composite" || q.type === "custom_table"
            ? "— each column has its own response type, variable, codes, validation" : ""}</h3>
          <ColumnEditor q={q} onChange={(columns) => patch({ columns })} />
        </>
      )}

      {(q.type === "numeric_list" || q.type === "text_list") && (
        <label className="f"><span>Number of list items</span>
          <input className="input" type="number" style={{ width: 100 }}
            value={q.settings.listCount ?? 3}
            onChange={(e) => patchSettings({ listCount: Number(e.target.value) })} /></label>
      )}

      {feats.numericBounds && (
        <div className="row">
          <label className="f"><span>Min</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.minValue ?? ""}
              onChange={(e) => patchSettings({ minValue: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          <label className="f"><span>Max</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.maxValue ?? ""}
              onChange={(e) => patchSettings({ maxValue: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          {feats.sum && (
            <>
              <label className="f"><span>Sum target</span>
                <input className="input" type="number" style={{ width: 90 }} value={q.settings.sumTarget ?? ""}
                  onChange={(e) => patchSettings({ sumTarget: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
              <label className="f"><span>Unit</span>
                <input className="input" style={{ width: 70 }} value={q.settings.sumUnit ?? ""}
                  onChange={(e) => patchSettings({ sumUnit: e.target.value || undefined })} /></label>
            </>
          )}
        </div>
      )}

      {(q.type === "multi_select" || q.type === "multi_dropdown" || q.type === "image_select") && (
        <div className="row">
          <label className="f"><span>Min selections</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.minSelections ?? ""}
              onChange={(e) => patchSettings({ minSelections: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
          <label className="f"><span>Max selections</span>
            <input className="input" type="number" style={{ width: 90 }} value={q.settings.maxSelections ?? ""}
              onChange={(e) => patchSettings({ maxSelections: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        </div>
      )}

      {(q.type === "hidden" || q.type === "calculated") && (
        <label className="f"><span>{q.type === "calculated" ? "Expression (calc DSL)" : "Default value"}</span>
          <input className="input mono"
            value={q.type === "calculated" ? (q.settings.expression ?? "") : String(q.settings.defaultValue ?? "")}
            placeholder={q.type === "calculated" ? "Q1 + Q2 + Q3" : ""}
            onChange={(e) =>
              q.type === "calculated"
                ? patchSettings({ expression: e.target.value })
                : patchSettings({ defaultValue: e.target.value })
            } /></label>
      )}

      {(q.type === "conjoint_task" || q.type === "maxdiff_task") && (
        <label className="f"><span>Design file</span>
          <select className="select" value={q.settings.designRef ?? ""}
            onChange={(e) => patchSettings({ designRef: e.target.value || undefined })}>
            <option value="">— pick a generated design —</option>
            {s.def.designs.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.kind} v{d.version})</option>)}
          </select></label>
      )}

      {q.type === "html" && (
        <label className="f"><span>HTML content</span>
          <textarea className="ta code" value={q.customHtml ?? ""}
            onChange={(e) => patch({ customHtml: e.target.value || undefined })} /></label>
      )}
    </div>
  );
}

export function QuestionsPanel() {
  const s = useStudio();
  const [addOpen, setAddOpen] = React.useState(false);
  const selected = s.def.questions.find((q) => q.id === s.selectedQuestionId);

  const addQuestion = (type: string) => {
    const plugin = questionTypeRegistry.get(type);
    const n = s.def.questions.length + 1;
    const q = plugin
      ? plugin.create({ id: uid("q"), code: `Q${n}`, variableName: `Q${n}` })
      : ({ id: uid("q"), code: `Q${n}`, variableName: `Q${n}`, type, text: "", options: [], rows: [], columns: [], validation: [], required: false, settings: { readOnly: false, hidden: false }, skipLogic: [] } as unknown as Question);
    s.update((d) => {
      d.questions.push(q);
      // auto-place on the last page
      const lastPage = [...flattenPages(d.flow)].pop();
      if (lastPage) lastPage.questionIds.push(q.id);
    });
    s.select(q.id);
    setAddOpen(false);
  };

  const move = (id: string, dir: -1 | 1) =>
    s.update((d) => {
      const i = d.questions.findIndex((q) => q.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.questions.length) return;
      [d.questions[i], d.questions[j]] = [d.questions[j], d.questions[i]];
    });

  const duplicate = (id: string) =>
    s.update((d) => {
      const q = d.questions.find((x) => x.id === id);
      if (!q) return;
      const copy = structuredClone(q);
      copy.id = uid("q");
      copy.code = `${q.code}_COPY`;
      copy.variableName = `${q.variableName}_COPY`;
      d.questions.splice(d.questions.findIndex((x) => x.id === id) + 1, 0, copy);
    });

  const remove = (id: string) => {
    if (!confirm("Delete this question? Logic referring to it will need updating.")) return;
    s.update((d) => {
      d.questions = d.questions.filter((q) => q.id !== id);
      for (const p of flattenPages(d.flow)) p.questionIds = p.questionIds.filter((x) => x !== id);
    });
    if (s.selectedQuestionId === id) s.select(null);
  };

  const categories = ["choice", "text", "numeric", "matrix", "media", "special", "custom"] as const;

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Questions</h2>
        <span className="chip">{s.def.questions.length}</span>
        <span className="grow" />
        <div style={{ position: "relative" }}>
          <button className="btn primary" onClick={() => setAddOpen((v) => !v)}>+ Add question</button>
          {addOpen && (
            <div className="card" style={{ position: "absolute", right: 0, top: 36, width: 340, zIndex: 20, maxHeight: 420, overflowY: "auto" }}>
              {categories.map((cat) => {
                const items = questionTypeRegistry.all().filter((p) => p.category === cat);
                if (!items.length) return null;
                return (
                  <div key={cat}>
                    <div className="flabel" style={{ marginTop: 8 }}>{cat}</div>
                    {items.map((p) => (
                      <button key={p.type} className="btn small" style={{ margin: "2px 4px 2px 0" }}
                        onClick={() => addQuestion(p.type)}>{p.label}</button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {s.def.questions.map((q) => (
        <div key={q.id}
          className={`card selectable ${q.id === s.selectedQuestionId ? "selected" : ""}`}
          onClick={() => s.select(q.id)}>
          <div className="qlist-item">
            <strong className="mono">{q.code}</strong>
            <span className="qtype-badge">{q.type}</span>
            <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {q.text.replace(/<[^>]*>/g, "") || <span className="muted">untitled</span>}
            </span>
            {q.displayLogic && <span className="chip warn" title="has display logic">DL</span>}
            {q.skipLogic.length > 0 && <span className="chip warn" title="has skip logic">SL</span>}
            {q.carryForward && <span className="chip" title="carry-forward">CF</span>}
            <button className="btn small" onClick={(e) => { e.stopPropagation(); move(q.id, -1); }}>↑</button>
            <button className="btn small" onClick={(e) => { e.stopPropagation(); move(q.id, 1); }}>↓</button>
            <button className="btn small" onClick={(e) => { e.stopPropagation(); duplicate(q.id); }}>⧉</button>
            <button className="btn small danger" onClick={(e) => { e.stopPropagation(); remove(q.id); }}>×</button>
          </div>
          {q.id === s.selectedQuestionId && selected && (
            <div style={{ marginTop: 14 }} onClick={(e) => e.stopPropagation()}>
              <QuestionEditor q={selected} />
            </div>
          )}
        </div>
      ))}
      {s.def.questions.length === 0 && (
        <p className="muted">No questions yet. Add one, then place it on a page in the Survey Flow.</p>
      )}
    </div>
  );
}

export function flattenPages(flow: any[]): { id: string; questionIds: string[]; title?: string }[] {
  const out: any[] = [];
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === "page") out.push(n);
      if (n.children) walk(n.children);
      if (n.branches) for (const b of n.branches) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    }
  };
  walk(flow);
  return out;
}
