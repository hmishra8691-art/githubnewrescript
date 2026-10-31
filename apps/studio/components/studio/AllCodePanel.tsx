"use client";
import React from "react";
import { codeGate } from "@rescript/engine";
import { useStudio } from "./store";
import { useScriptHealth, ScriptHealthChip } from "./ScriptHealth";
import { UxItemEditorById } from "./UxItemsEditor";
import { LogicScriptCard } from "./BrandingPanel";
import { ComponentJsField } from "./PropertiesPanel";
import { CodeEditor } from "./code/CodeEditor";
import { codeInventory, filterInventory, type CodeRow } from "@/lib/scripts/inventory.ts";

/**
 * S3b item 3 (audit MM-09 overview, MM-11 logs) — RESEARCH TOOLS → ALL CODE: every piece of code in the survey in one
 * list (behaviour scripts with their target, logic scripts with event and scope, Custom Components, Branding HTML /
 * CSS, question CSS) with where it runs, its events, on/off, the check's verdict, what it reads and writes, its live
 * health (S1c `/api/surveys/[id]/script-health`) and last error. A row opens that item's own editor IN PLACE (the same
 * card, gate and save as on its home screen). Read-only users see the same list and read-only editors.
 *
 * It sits beside Scripts in Research tools (the sidebar's home of survey code: Branding, Translation, Scripts).
 */
export function AllCodePanel({ tools }: { tools?: (selected: CodeRow[], all: CodeRow[]) => React.ReactNode }) {
  const s = useStudio();
  const h = useScriptHealth();
  const rows = React.useMemo(() => codeInventory(s.def), [s.def]);
  const [kind, setKind] = React.useState("all");
  const [text, setText] = React.useState("");
  const [problems, setProblems] = React.useState(false);
  const [off, setOff] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const health = (id: string | null) => (id && h.status === "ready" ? h.data?.scripts.find((x) => x.script === id) ?? null : null);
  const shown = filterInventory(rows, { kind, text, problems, off }, (id) => !!health(id)?.failures);
  const selected = rows.filter((r) => picked.has(r.key));
  return (
    <div data-testid="allcode-panel">
      <div className="row" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>All code</h2>
        <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }} data-testid="allcode-count">{rows.length} item{rows.length === 1 ? "" : "s"}</span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>
        Every piece of code in this survey: scripts in Styles, animations &amp; scripts, the Scripts panel, Custom Components, Branding and question CSS.
        Click a row to edit it here — the same editor, check and save as on its own screen.
        {s.readOnly ? " You are viewing: everything is read-only." : ""}
      </p>
      <div className="allcode-filters">
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" data-testid="allcode-kind">
          <option value="all">every kind</option><option value="behaviour">behaviour scripts</option><option value="logic">logic scripts</option>
          <option value="component">components</option><option value="question">question CSS</option><option value="branding">branding</option>
        </select>
        <input className="input" style={{ width: 200 }} placeholder="name, question, code…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" data-testid="allcode-search" />
        <label className="row" style={{ gap: 4, fontSize: 12.5 }}><input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} data-testid="allcode-problems" /> problems only</label>
        <label className="row" style={{ gap: 4, fontSize: 12.5 }}><input type="checkbox" checked={off} onChange={(e) => setOff(e.target.checked)} data-testid="allcode-off" /> switched off only</label>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 11.5 }}>live health: {h.status === "ready" ? `${h.data?.sessions ?? 0} sessions (${h.env})` : h.status === "off" ? "not available here" : h.status}</span>
      </div>
      {tools?.(selected, rows)}
      {rows.length === 0 ? <p className="muted" data-testid="allcode-empty">This survey has no code yet.</p> : (
        <table className="allcode-table" data-testid="allcode-table">
          <thead><tr>
            <th><input type="checkbox" aria-label="Select all" checked={picked.size > 0 && picked.size === rows.length} onChange={(e) => setPicked(new Set(e.target.checked ? rows.map((r) => r.key) : []))} data-testid="allcode-pick-all" /></th>
            <th>Kind</th><th>Name</th><th>Runs on</th><th>Events</th><th>On</th><th>Check</th><th>Reads / writes</th><th>Health · last error</th>
          </tr></thead>
          <tbody>
            {shown.map((r) => {
              const hr = health(r.healthId);
              const last = hr?.messages[0]?.message;
              return (
                <React.Fragment key={r.key}>
                  <tr className={open === r.key ? "open" : undefined} data-testid="allcode-row" data-key={r.key} data-kind={r.kind} data-verdict={r.verdict.status} data-enabled={r.enabled === null ? "n/a" : String(r.enabled)}
                    style={{ cursor: "pointer" }} onClick={(e) => { if ((e.target as HTMLElement).closest("input,button,a,.script-health")) return; setOpen((o) => (o === r.key ? null : r.key)); }}>
                    <td><input type="checkbox" checked={picked.has(r.key)} aria-label={`Select ${r.name}`} data-testid="allcode-pick"
                      onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n; })} /></td>
                    <td>{r.kindLabel}</td>
                    <td><button type="button" className="linklike" style={{ background: "none", border: 0, padding: 0, color: "var(--accent, #4f46e5)", cursor: "pointer", textAlign: "left" }}
                      onClick={() => setOpen((o) => (o === r.key ? null : r.key))} aria-expanded={open === r.key} data-testid="allcode-open">{r.name}</button></td>
                    <td>{r.where}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.events.join(", ")}</td>
                    <td data-testid="allcode-enabled">{r.enabled === null ? "—" : r.enabled ? "on" : "off"}</td>
                    <td><span className={`chip ${r.verdict.status === "refused" ? "warn" : ""}`} title={r.verdict.reasons.join("\n")} data-testid="allcode-verdict">{r.verdict.status}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.language === "js" ? `${r.reads.length ? r.reads.join(", ") : "—"} / ${r.writes.length ? r.writes.join(", ") : "—"}` : "—"}</td>
                    <td>{r.healthId ? <ScriptHealthChip scriptId={r.healthId} /> : <span className="muted">not reported</span>}
                      {last && <div className="muted" style={{ fontSize: 11 }} data-testid="allcode-last-error">{last.slice(0, 120)}</div>}</td>
                  </tr>
                  {open === r.key && (
                    <tr><td colSpan={9} data-testid="allcode-editor" data-key={r.key}><RowEditor row={r} /></td></tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.length > 0 && shown.length === 0 && <p className="muted" data-testid="allcode-none">Nothing matches these filters.</p>}
    </div>
  );
}

/** the item's own editor, in place */
function RowEditor({ row }: { row: CodeRow }) {
  const s = useStudio();
  const [refusal, setRefusal] = React.useState<string[] | undefined>();
  const e = row.edit;
  if (e.type === "behavior") return <UxItemEditorById id={e.id} />;
  if (e.type === "logic") {
    const i = s.def.scripts.findIndex((x) => x.id === e.id);
    return <LogicScriptCard index={i} refusal={refusal} setRefusal={setRefusal} />;
  }
  if (e.type === "question") {
    const q = s.def.questions.find((x) => x.id === e.questionId);
    if (!q) return <p className="muted">The question is no longer in the survey.</p>;
    const patch = (v: string | undefined, label: string) => { s.labelNextEdit(label); s.update((d) => { const qq = d.questions.find((x) => x.id === q.id); if (qq) (qq as Record<string, unknown>)[e.field] = v; }); };
    if (e.field === "customJs" && q.type === "custom_component") return <ComponentJsField code={q.customJs ?? ""} label={`${q.code} component JavaScript`} readOnly={s.readOnly} itemKey={row.key}
      header={q.customJs ? <ScriptHealthChip scriptId={`uxb_component_${q.id}`} /> : null}
      onSave={(code) => { const v = code.trim() ? codeGate(code, "component") : { ok: true }; if (v.ok) patch(code || undefined, `Edit ${q.code} component JavaScript`); }} />;
    return <InlineField value={String((q as Record<string, unknown>)[e.field] ?? "")} language={row.language} label={`${q.code} ${row.kindLabel}`} testId="allcode-field" readOnly={s.readOnly}
      onSave={(v) => patch(v || undefined, `Edit ${q.code} ${row.kindLabel}`)} />;
  }
  return <InlineField value={String((s.def.branding as Record<string, unknown>)[e.field] ?? "")} language={row.language} label={row.name} testId="allcode-field" readOnly={s.readOnly}
    onSave={(v) => { s.labelNextEdit(`Edit ${row.name}`); s.update((d) => { (d.branding as Record<string, unknown>)[e.field] = v || undefined; }); }} />;
}

/** CSS / HTML fields have never refused a save (the sanitiser cleans them when shown): saved when left */
function InlineField({ value, language, label, testId, readOnly, onSave }: { value: string; language: "js" | "css" | "html"; label: string; testId: string; readOnly: boolean; onSave(v: string): void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => { setDraft(value); }, [value]);
  return <CodeEditor language={language} value={draft} label={label} testId={testId} readOnly={readOnly} minHeight={80}
    onChange={setDraft} onCommit={() => { if (draft !== value) onSave(draft); }} />;
}
