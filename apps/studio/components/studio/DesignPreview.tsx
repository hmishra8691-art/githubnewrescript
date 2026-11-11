"use client";
import React from "react";

/**
 * A DESIGN FILE, READ AS A RESPONDENT AND A RESEARCHER SEE IT (2026-11-09): the first choice tasks as cards (CBC,
 * CVA), menus with their prices (MBC), best/worst sets (MaxDiff), the adaptive stages (ACBC), runs or sequences
 * (experimental designs) — then the file's own explanation and quality figures. Used by the samples and after
 * generating, so what is shown is always what the generator produced.
 */
type Row = Record<string, unknown>;
const SYS = new Set(["version", "task", "alt", "is_holdout", "none_option", "fixed_option", "position", "item_index", "item_label", "run", "stage", "step", "items", "note", "item", "price", "price_index", "price_value", "required", "practice", "treatment"]);

export function DesignPreview({ kind, file, tasks = 2 }: { kind: string; file: { columns: string[]; rows: Row[]; summary?: Record<string, unknown> }; tasks?: number }) {
  const v1 = file.rows.filter((r) => r.version === undefined || Number(r.version) === 1);
  const s = file.summary ?? {};
  return (
    <div className="dp" data-testid="design-preview" data-kind={kind}>
      {(kind === "conjoint" || kind === "cva") && <ChoiceTasks rows={v1} columns={file.columns} tasks={tasks} rating={kind === "cva"} />}
      {kind === "menu" && <MenuTasks rows={v1} tasks={tasks} />}
      {kind === "maxdiff" && <MaxDiffSets rows={v1} tasks={tasks + 1} />}
      {kind === "acbc" && <Table rows={file.rows} columns={["stage", "step", "items", "note"]} caption="The adaptive interview: each respondent's concepts are built from their own build-your-own answers, so the file is the plan of stages." />}
      {kind === "experiment" && <Table rows={file.rows.slice(0, 16)} columns={file.columns} caption={file.rows.length > 16 ? `First 16 of ${file.rows.length} rows` : undefined} />}
      {!["conjoint", "cva", "menu", "maxdiff", "acbc", "experiment"].includes(kind) && <Table rows={file.rows.slice(0, 12)} columns={file.columns} caption={file.rows.length > 12 ? `First 12 of ${file.rows.length} rows` : undefined} />}
      <DesignFacts kind={kind} file={file} />
      {typeof s.explanation === "string" && <p className="dp-why">{s.explanation}</p>}
    </div>
  );
}

function ChoiceTasks({ rows, columns, tasks, rating }: { rows: Row[]; columns: string[]; tasks: number; rating: boolean }) {
  const attrs = columns.filter((c) => !SYS.has(c));
  const taskIds = [...new Set(rows.map((r) => Number(r.task)))].slice(0, tasks);
  return (
    <div className="dp-tasks">
      {taskIds.map((t) => {
        const alts = rows.filter((r) => Number(r.task) === t);
        const none = alts.some((a) => Number(a.none_option) === 1);
        const shown = alts.filter((a) => Number(a.none_option) !== 1);
        /* partial profile: only the attributes this task shows (the rest are blank in every alternative) */
        const taskAttrs = attrs.filter((a) => shown.some((x) => String(x[a] ?? "") !== ""));
        return (
          <div key={t} className="dp-task" data-testid="design-task">
            <div className="dp-task-head">{rating ? `Profile ${t}` : `Task ${t}`}{alts.some((a) => Number(a.is_holdout) === 1) ? " · holdout" : ""}</div>
            <table className="dp-cards">
              <thead><tr><th />{shown.map((a, i) => <th key={i}>{rating ? "Rate 0–10" : Number(a.fixed_option) >= 1 ? `Fixed ${Number(a.fixed_option)}` : `Option ${i + 1}`}</th>)}{none && <th>None</th>}</tr></thead>
              <tbody>{taskAttrs.map((a) => <tr key={a}><th>{a}</th>{shown.map((x, i) => <td key={i}>{String(x[a] ?? "")}</td>)}{none && <td className="dp-none">{a === taskAttrs[0] ? "I would choose none of these" : ""}</td>}</tr>)}</tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function MenuTasks({ rows, tasks }: { rows: Row[]; tasks: number }) {
  const taskIds = [...new Set(rows.map((r) => Number(r.task)))].slice(0, tasks);
  return (
    <div className="dp-tasks">
      {taskIds.map((t) => (
        <div key={t} className="dp-task" data-testid="design-task">
          <div className="dp-task-head">Task {t} — tick what you would buy</div>
          <ul className="dp-menu">{rows.filter((r) => Number(r.task) === t).map((r, i) => <li key={i}><span>☐ {String(r.item_label)}</span><b>{String(r.price)}</b></li>)}</ul>
        </div>
      ))}
    </div>
  );
}

function MaxDiffSets({ rows, tasks }: { rows: Row[]; tasks: number }) {
  const taskIds = [...new Set(rows.map((r) => Number(r.task)).filter((t) => t > 0))].slice(0, tasks);
  return (
    <div className="dp-tasks">
      {taskIds.map((t) => (
        <div key={t} className="dp-task" data-testid="design-task">
          <div className="dp-task-head">Task {t} — most and least important</div>
          <table className="dp-cards"><thead><tr><th>Most</th><th>Item</th><th>Least</th></tr></thead>
            <tbody>{rows.filter((r) => Number(r.task) === t).sort((a, b) => Number(a.position) - Number(b.position)).map((r, i) => <tr key={i}><td className="dp-radio">○</td><td>{String(r.item_label)}</td><td className="dp-radio">○</td></tr>)}</tbody></table>
        </div>
      ))}
    </div>
  );
}

function Table({ rows, columns, caption }: { rows: Row[]; columns: string[]; caption?: string }) {
  return (
    <div className="dp-table">
      <div className="table-wrap" style={{ maxHeight: 300, overflow: "auto" }}>
        <table className="grid"><thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c}>{String(r[c] ?? "")}</td>)}</tr>)}</tbody></table>
      </div>
      {caption && <p className="muted dp-cap">{caption}</p>}
    </div>
  );
}

/** the figures that say whether the design is sound, in words */
export function DesignFacts({ kind, file }: { kind: string; file: { rows: Row[]; summary?: Record<string, unknown> } }) {
  const s = (file.summary ?? {}) as Record<string, any>;
  const facts: [string, string][] = [];
  const versions = new Set(file.rows.map((r) => r.version).filter((v) => v !== undefined)).size;
  if (versions) facts.push(["Versions", String(versions)]);
  if (kind === "conjoint") {
    if (s.tasksPerVersion) facts.push(["Tasks per version", String(s.tasksPerVersion)]);
    if (s.alternativesPerTask) facts.push(["Alternatives per task", String(s.alternativesPerTask)]);
    if (typeof s.efficiency?.pooled === "number") facts.push(["D-efficiency (pooled)", `${Math.round(s.efficiency.pooled * 1000) / 10}%`]);
    if (typeof s.efficiency?.perVersion?.mean === "number") facts.push(["D-efficiency per version (mean)", `${Math.round(s.efficiency.perVersion.mean * 1000) / 10}%`]);
    if (s.method) facts.push(["Design method", String(s.method)]);
    if (s.partialProfile) { const pp = s.partialProfile, pv = pp.shownPerVersion; facts.push(["Attributes shown per task", pv ? `${pp.attributesPerTask} — each attribute in ${pv.min === pv.max ? pv.min : `${pv.min}–${pv.max}`} of a respondent's ${pp.tasksPerVersion} tasks` : String(pp.attributesPerTask)]); }
    facts.push(["None option", s.noneOption ? "yes" : "no"]);
  }
  if (kind === "maxdiff") {
    if (s.itemsPerTask) facts.push(["Items per task", String(s.itemsPerTask)]);
    if (s.tasksPerVersion) facts.push(["Tasks per version", String(s.tasksPerVersion)]);
    const items = new Set(file.rows.map((r) => r.item_label)).size;
    if (items && s.itemsPerTask && s.tasksPerVersion) facts.push(["Times each item is seen per respondent", String(Math.round(((s.itemsPerTask * s.tasksPerVersion) / items) * 10) / 10)]);
  }
  if (kind === "cva") { if (s.profilesPerVersion) facts.push(["Profiles per version", String(s.profilesPerVersion)]); if (s.parameters) facts.push(["Parameters", String(s.parameters)]); }
  if (kind === "menu") { if (s.tasks) facts.push(["Tasks", String(s.tasks)]); if (Array.isArray(s.items)) facts.push(["Menu items", String(s.items.length)]); }
  if (kind === "acbc") { if (s.screeningTasks) facts.push(["Screening screens", String(s.screeningTasks)]); if (s.conceptsPerScreen) facts.push(["Concepts per screen", String(s.conceptsPerScreen)]); if (s.conceptSpace) facts.push(["Possible concepts", Number(s.conceptSpace).toLocaleString("en")]); }
  if (kind === "experiment") {
    if (s.designType) facts.push(["Design type", String(s.designType).replace("_", " ")]);
    if (s.runs) facts.push(["Runs", `${s.runs}${s.totalCombinations ? ` of ${s.totalCombinations} combinations` : ""}`]);
    if (typeof s.dEfficiency === "number") facts.push(["D-efficiency", `${s.dEfficiency}%`]);
    if (typeof s.maxCorrelation === "number") facts.push(["Largest correlation between factors", String(s.maxCorrelation)]);
    if (s.carryover) facts.push(["Carry-over", s.carryoverBalanced ? "balanced" : `${s.carryover.min}–${s.carryover.max}`]);
    if (s.pairConcurrence) facts.push(["Pairs together", s.pairConcurrence.min === s.pairConcurrence.max ? `${s.pairConcurrence.min} each` : `${s.pairConcurrence.min}–${s.pairConcurrence.max}`]);
  }
  if (!facts.length) return null;
  return <dl className="dp-facts" data-testid="design-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
