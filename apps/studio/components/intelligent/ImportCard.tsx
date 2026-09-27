"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { Icon } from "../ui/Icon";
import { formatCharge, type ReviewLine } from "../../lib/import/chat";

/**
 * THE IMPORT CARD — one file's way through the Super Intelligent import
 * (the import brief §2, §15–§17, §33–§35, §39), as a turn in the Intelligent
 * conversation:
 *
 *   estimating → ESTIMATE      what the file is (by content), how big, what it
 *                              would cost; choose the scope and the target
 *   running    → PREVIEW       detected → created, confidence, risks by
 *                              severity, the source → Rescript map; the
 *                              actual charge
 *              → created / merged / cancelled
 *
 * Nothing is written until the programmer presses Create project (a new,
 * separate project) or Add to this survey (one undoable edit, beside what is
 * there — nothing overwritten). The card only renders; IntelligentView owns
 * the requests.
 */

export type ImportScope = "full" | "structure" | "questions";
export interface ImportIssue { location: string; type: string; severity: "high" | "medium" | "low" | "info"; message: string; suggestion?: string; autoAttempted: boolean; refs?: string[] }
interface Stats { questions: number; blocks: number; pages: number; pageBreaks: number; embeddedFields: number; hiddenVariables: number; displayLogic: number; skipLogic: number; branches: number; randomizers: number; loops: number; quotas: number; validations: number; customLogic: number }
export interface ImportReport {
  source: { platform: string; format: string; fileName: string; title?: string; label: string; reasons: string[] };
  scope: ImportScope; detected: Stats; created: Stats | null;
  converted: ImportIssue[]; review: ImportIssue[]; risks: Record<"high" | "medium" | "low" | "info", ImportIssue[]>;
  confidence: Record<string, number>; validation: { errors: number; warnings: number; deployable: boolean } | null;
  merge?: { unchanged: string[]; changed: { source: string; rescript: string; differences: string[] }[]; added: string[] };
  summary: string[]; audit: string[]; ok: boolean;
}
export interface ImportJob {
  fileName: string;
  size: number;
  stage: "estimating" | "estimated" | "running" | "ready" | "failed" | "creating" | "created" | "merged" | "cancelled";
  scope: ImportScope;
  into: "new" | "merge";
  detection?: { format: string; platform: string; label: string; confidence: string; reasons: string[] };
  workload?: { questions: number; logicRules: number; customLogic: number; ambiguous: number; aiRequests: number } | null;
  title?: string | null;
  estimate?: { import: { customerCharge: number }; deepAnalysis: { requests: number; customerCharge: number; unavailable?: boolean }; currency: string };
  actual?: { customerCharge: number; currency: string };
  definition?: SurveyDefinition | null;
  report?: ImportReport;
  mapping?: { kind: string; source: string; rescript: string; reason?: string }[];
  error?: string;
  createdId?: string;
  panel?: "issues" | "map" | null;
  /** the survey as it was when a merge was previewed — applied only onto that */
  basedOn?: SurveyDefinition;
}

const ROWS: [keyof Stats, string][] = [
  ["questions", "Questions"], ["blocks", "Blocks"], ["pageBreaks", "Page breaks"], ["embeddedFields", "Embedded variables"], ["hiddenVariables", "Hidden variables"],
  ["displayLogic", "Display logic"], ["skipLogic", "Skip rules"], ["branches", "Branches"], ["randomizers", "Randomizers"], ["loops", "Loops"], ["quotas", "Quotas"], ["validations", "Validation rules"],
];
const SCOPES: { id: ImportScope; label: string; about: string }[] = [
  { id: "full", label: "Full migration", about: "questions, structure, logic, quotas" },
  { id: "structure", label: "Structure only", about: "questions, blocks, pages, loops, embedded data — no logic" },
  { id: "questions", label: "Questions only", about: "questions and their options, one page each" },
];
const CONF: [string, string][] = [["confirmed", "Confirmed"], ["high", "High confidence"], ["review", "Needs review"], ["ambiguous", "Ambiguous"], ["unsupported", "Unsupported"]];

export function ImportCard({ job, onPatch, onRun, onCreate, onMerge, onCancel, onReviewAfter, readOnly, sandbox }: {
  job: ImportJob;
  onPatch(p: Partial<ImportJob>): void;
  onRun(): void; onCreate(): void; onMerge(): void; onCancel(): void; onReviewAfter(): void;
  readOnly: boolean; sandbox: boolean;
}) {
  const cur = job.estimate?.currency ?? "USD";
  const r = job.report;
  const done = job.stage === "created" || job.stage === "merged";
  return (
    <article className={`iq-turn ${done ? "applied" : job.stage === "cancelled" ? "cancelled" : "open"}`} data-testid="iq-import" data-stage={job.stage} data-format={job.detection?.format ?? ""}>
      <div className="iq-said"><Icon name="upload" size={13} /> <span>Import <b>{job.fileName}</b> <span className="iqi-dim">({(job.size / 1024).toFixed(job.size < 10240 ? 1 : 0)} KB)</span></span></div>
      <div className={`iq-card proposal${job.stage === "failed" ? " blocked" : ""}`}>
        <div className="iq-card-head">
          <span className="iq-kicker">{KICKER[job.stage]}</span>
          {job.detection && <span className="iq-source" data-testid="iqi-detected" title={job.detection.reasons.join(" · ")}>{job.detection.label}</span>}
          {job.detection && <span className="iqi-dim" data-testid="iqi-detect-confidence">detected by content · {job.detection.confidence} confidence</span>}
        </div>

        {(job.stage === "estimating" || job.stage === "running" || job.stage === "creating") && <div className="iq-thinking" data-testid="iqi-busy"><span className="iq-dot" /><span className="iq-dot" /><span className="iq-dot" /></div>}
        {job.error && <p className="iq-error" data-testid="iqi-error" role="alert"><Icon name="warning" size={12} /> {job.error}</p>}

        {job.stage === "estimated" && job.workload && (
          <>
            {job.title && <p className="iq-summary" data-testid="iqi-title">“{job.title}”</p>}
            <p className="iqi-work" data-testid="iqi-workload">
              {job.workload.questions} questions · {job.workload.logicRules} logic rules · {job.workload.customLogic} custom code item{job.workload.customLogic === 1 ? "" : "s"}{job.workload.ambiguous ? ` · ${job.workload.ambiguous} ambiguous instruction${job.workload.ambiguous === 1 ? "" : "s"}` : ""}
            </p>
            <fieldset className="iqi-choice" data-testid="iqi-scope">
              <legend className="iq-label">Scope — what to migrate</legend>
              {SCOPES.map((s) => (
                <label key={s.id} className={job.scope === s.id ? "on" : ""}>
                  <input type="radio" name={`scope-${job.fileName}`} checked={job.scope === s.id} onChange={() => onPatch({ scope: s.id })} data-testid={`iqi-scope-${s.id}`} />
                  <span><b>{s.label}</b> <span className="iqi-dim">{s.about}</span></span>
                </label>
              ))}
            </fieldset>
            <fieldset className="iqi-choice" data-testid="iqi-into">
              <legend className="iq-label">Into</legend>
              <label className={job.into === "new" ? "on" : ""}><input type="radio" name={`into-${job.fileName}`} checked={job.into === "new"} onChange={() => onPatch({ into: "new" })} data-testid="iqi-into-new" /> <span><b>A new project</b> <span className="iqi-dim">this survey is not touched</span></span></label>
              <label className={job.into === "merge" ? "on" : ""}><input type="radio" name={`into-${job.fileName}`} checked={job.into === "merge"} onChange={() => onPatch({ into: "merge" })} data-testid="iqi-into-merge" disabled={readOnly} /> <span><b>This survey</b> <span className="iqi-dim">added beside what is here — nothing overwritten; identical questions are not duplicated</span></span></label>
            </fieldset>
            {job.estimate && (
              <div className="iqi-cost" data-testid="iqi-estimate">
                <span className="iq-label">Estimated cost</span>
                <span data-testid="iqi-estimate-import">Import: <b>{formatCharge(job.estimate.import.customerCharge, cur)}</b> <span className="iqi-dim">— reading and reconstruction are deterministic; no AI is used</span></span>
                {job.estimate.deepAnalysis.requests > 0 && (
                  <span data-testid="iqi-estimate-deep">Deep custom logic analysis (optional, after import): {job.estimate.deepAnalysis.unavailable ? <span className="iqi-dim">no language model is configured on this Studio</span> : <><b>≈ {formatCharge(job.estimate.deepAnalysis.customerCharge, cur)}</b> <span className="iqi-dim">for {job.estimate.deepAnalysis.requests} item{job.estimate.deepAnalysis.requests === 1 ? "" : "s"}, each run only when you ask</span></>}</span>
                )}
              </div>
            )}
            <div className="iq-actions">
              <span className="iq-spacer" />
              <button type="button" className="iq-btn" onClick={onCancel} data-testid="iqi-cancel">Cancel</button>
              <button type="button" className="iq-btn primary" onClick={onRun} data-testid="iqi-run">Analyze &amp; preview</button>
            </div>
          </>
        )}

        {r && (job.stage === "ready" || job.stage === "creating" || done || job.stage === "cancelled") && (
          <>
            {r.summary.map((line, i) => <p key={i} className={i === 0 ? "iq-summary" : "iqi-line"} data-testid="iqi-summary">{line}</p>)}
            <table className="iqi-table" data-testid="iqi-preview">
              <thead><tr><th /><th>Detected</th><th>Created</th></tr></thead>
              <tbody>
                {ROWS.filter(([k]) => r.detected[k] || r.created?.[k]).map(([k, label]) => (
                  <tr key={k} data-row={k}><td>{label}</td><td className="mono">{r.detected[k]}</td><td className="mono">{r.created ? r.created[k] : "—"}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="iqi-badges" data-testid="iqi-confidence">
              {CONF.filter(([k]) => r.confidence[k]).map(([k, label]) => <span key={k} className={`iqi-badge c-${k}`} data-level={k}>{label} <b>{r.confidence[k]}</b></span>)}
              <span className="iqi-sep" />
              {(["high", "medium", "low"] as const).map((sv) => <span key={sv} className={`iqi-badge r-${sv}`} data-testid={`iqi-risk-${sv}`}>{sv} risk <b>{r.risks[sv].length}</b></span>)}
            </div>
            {job.actual && <p className="iqi-dim" data-testid="iqi-actual">Charged for this import: <b>{formatCharge(job.actual.customerCharge, job.actual.currency)}</b>{job.estimate ? ` (estimated ${formatCharge(job.estimate.import.customerCharge, cur)})` : ""}</p>}

            {job.panel === "issues" && <IssueList report={r} />}
            {job.panel === "map" && job.mapping && <MapTable mapping={job.mapping} />}

            <div className="iq-actions">
              <button type="button" className={`iq-btn${job.panel === "issues" ? " on" : ""}`} onClick={() => onPatch({ panel: job.panel === "issues" ? null : "issues" })} data-testid="iqi-issues-btn">Review issues ({r.review.length})</button>
              <button type="button" className={`iq-btn${job.panel === "map" ? " on" : ""}`} onClick={() => onPatch({ panel: job.panel === "map" ? null : "map" })} data-testid="iqi-map-btn">Source → Rescript map</button>
              <span className="iq-spacer" />
              {job.stage === "ready" && <button type="button" className="iq-btn" onClick={onCancel} data-testid="iqi-cancel">Cancel</button>}
              {job.stage === "ready" && job.into === "new" && (
                <button type="button" className="iq-btn primary" onClick={onCreate} disabled={!job.definition || sandbox} data-testid="iqi-create" title={sandbox ? "The sandbox cannot create projects — sign in to the Studio" : "Create a new project from this import"}>Create project</button>
              )}
              {job.stage === "ready" && job.into === "merge" && (
                <button type="button" className="iq-btn primary" onClick={onMerge} disabled={!job.definition || readOnly} data-testid="iqi-merge" title={readOnly ? "Read-only" : "Add the imported questions and structure to this survey (undoable)"}>Add to this survey</button>
              )}
              {job.stage === "created" && job.createdId && <a className="iq-btn primary" href={`/studio/${job.createdId}?mode=intelligent`} data-testid="iqi-open">Open the new project</a>}
              {job.stage === "merged" && <button type="button" className="iq-btn primary" onClick={onReviewAfter} data-testid="iqi-review-after">What needs review?</button>}
            </div>
          </>
        )}
        {job.stage === "failed" && (
          <div className="iq-actions"><span className="iq-spacer" /><button type="button" className="iq-btn" onClick={onCancel} data-testid="iqi-cancel">Dismiss</button></div>
        )}
      </div>
    </article>
  );
}

const KICKER: Record<ImportJob["stage"], string> = {
  estimating: "READING THE FILE", estimated: "IMPORT — ESTIMATE", running: "RECONSTRUCTING", ready: "IMPORT PREVIEW",
  failed: "IMPORT — COULD NOT READ", creating: "CREATING THE PROJECT", created: "IMPORTED — NEW PROJECT", merged: "IMPORTED INTO THIS SURVEY", cancelled: "IMPORT CANCELLED",
};

function IssueList({ report }: { report: ImportReport }) {
  const groups = (["high", "medium", "low", "info"] as const).filter((s) => report.risks[s].length);
  if (!groups.length) return <p className="iqi-dim" data-testid="iqi-issues">Nothing to review — every element was migrated one-to-one.</p>;
  return (
    <div className="iq-review iqi-issues" data-testid="iqi-issues">
      {groups.map((sv) => (
        <section key={sv}>
          <div className="iq-label">{sv === "info" ? "Notes" : `${sv} risk`} · {report.risks[sv].length}</div>
          <ul>
            {report.risks[sv].slice(0, 200).map((i, n) => (
              <li key={n} data-severity={i.severity} data-type={i.type} data-testid="iqi-issue">
                <span className="iqi-loc mono">{i.location}</span> <span className="iqi-type">{i.type.replace(/_/g, " ")}</span>
                <div>{i.message}</div>
                {i.suggestion && <div className="iqi-dim">→ {i.suggestion}</div>}
                <div className="iqi-dim">{i.autoAttempted ? "An automatic conversion was attempted." : "Not converted automatically."}</div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MapTable({ mapping }: { mapping: NonNullable<ImportJob["mapping"]> }) {
  const [all, setAll] = React.useState(false);
  const rows = all ? mapping : mapping.filter((m) => m.kind !== "option" && m.kind !== "row");
  return (
    <div className="iq-review" data-testid="iqi-map">
      <label className="iqi-dim"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> include options and rows</label>
      <div className="iqi-map-scroll">
        <table className="iqi-table">
          <thead><tr><th>Kind</th><th>Source</th><th>Rescript</th><th>Why it differs</th></tr></thead>
          <tbody>
            {rows.slice(0, 1500).map((m, i) => <tr key={i} data-kind={m.kind} data-testid="iqi-map-row"><td>{m.kind}</td><td className="mono">{m.source}</td><td className="mono">{m.rescript}</td><td className="iqi-dim">{m.reason ?? ""}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ "what could not be migrated?" */

export interface ReviewScript { id: string; name: string; code: string; questionId?: string; questionCode?: string; state?: "idle" | "analyzing" | "done" | "failed"; explanation?: string; equivalent?: string; risk?: string; dependencies?: string[]; proposed?: boolean; error?: string; charge?: number }
export interface ReviewEntry { summary: string; lines: ReviewLine[]; scripts: ReviewScript[]; aiOff: boolean; estimate?: string }

export function ReviewCard({ text, entry, onSelect, onAnalyze }: { text: string; entry: ReviewEntry; onSelect(questionId: string): void; onAnalyze(scriptId: string): void }) {
  return (
    <article className="iq-turn applied" data-testid="iq-import-review">
      <div className="iq-said"><Icon name="user" size={13} /> <span>{text}</span></div>
      <div className="iq-card answer">
        <div className="iq-card-head"><span className="iq-kicker">MIGRATION REVIEW</span></div>
        <p className="iq-summary" data-testid="iqr-summary">{entry.summary}</p>
        {entry.lines.length > 0 && (
          <ul className="iqi-review-lines">
            {entry.lines.map((l, i) => (
              <li key={i} data-severity={l.severity} data-testid="iqr-line">
                {l.questionId ? <button type="button" className="iq-chip" onClick={() => onSelect(l.questionId!)} data-testid="iqr-go">{l.text}</button> : <span>{l.text}</span>}
              </li>
            ))}
          </ul>
        )}
        {entry.scripts.length > 0 && (
          <div className="iq-review" data-testid="iqr-scripts">
            <div className="iq-label">Custom logic kept as disabled scripts{entry.estimate ? ` · Deep analysis ≈ ${entry.estimate} each` : ""}</div>
            {entry.scripts.map((sc) => (
              <div key={sc.id} className="iqi-script" data-testid="iqr-script" data-state={sc.state ?? "idle"}>
                <div className="iqi-script-head">
                  <span className="mono">{sc.name}</span>
                  {sc.questionCode && <span className="iqi-dim">on {sc.questionCode}</span>}
                  <span className="iq-spacer" />
                  <button type="button" className="iq-btn" disabled={entry.aiOff || sc.state === "analyzing"} onClick={() => onAnalyze(sc.id)} data-testid="iqr-analyze" title={entry.aiOff ? "No language model is configured on this Studio" : "Ask the model what this code does and propose a Rescript rebuild — shown for review, never applied by itself"}>
                    <Icon name="sparkle" size={12} /> {sc.state === "analyzing" ? "Analyzing…" : sc.state === "done" ? "Analyze again" : "Analyze"}
                  </button>
                </div>
                <pre className="iq-json mono">{sc.code.slice(0, 1200)}</pre>
                {sc.error && <p className="iq-error" data-testid="iqr-error"><Icon name="warning" size={12} /> {sc.error}</p>}
                {sc.state === "done" && (
                  <div className="iqi-analysis" data-testid="iqr-analysis">
                    <p>{sc.explanation || "The model could not explain this code. Nothing was changed."}</p>
                    {sc.dependencies && sc.dependencies.length > 0 && <p className="iqi-dim">Reads: {sc.dependencies.join(", ")}</p>}
                    {sc.risk && <p className="iqi-dim">Risk: {sc.risk}</p>}
                    <p className="iqi-dim" data-testid="iqr-equivalent">{sc.proposed ? "A rebuild is proposed below — review it and press Apply if it is right." : "No faithful Rescript equivalent was proposed; rebuild it by hand."}{sc.charge ? ` · charged ${formatCharge(sc.charge)}` : ""}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
