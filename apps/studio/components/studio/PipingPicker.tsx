"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import {
  PIPE_FORMATS,
  PIPE_PROPERTIES,
  serializePipeToken,
  describePipeToken,
  parsePipeBody,
  type PipeFormat,
  type PipeProperty,
  type PipeToken,
} from "@rescript/engine";
import { useLoopScope } from "./loopScope";
import { useStudio } from "./store";

/**
 * Visual piping builder (reqs §16–25).
 *
 * The programmer picks a source, what to read from it and how to format it;
 * the picker composes a structured token and serialises it. Nobody has to
 * remember `{{Q1.labels|and}}`.
 */

const MULTI_TYPES = [
  "multi_select",
  "multi_dropdown",
  "image_select",
  "ranking",
  "image_ranking",
  "matrix_multi",
  "hotspot",
];

/** Only offer properties that exist for the chosen source (req §7 spirit). */
export function propertiesForQuestion(q: Question | undefined) {
  if (!q) return PIPE_PROPERTIES;
  const isMulti = MULTI_TYPES.includes(q.type);
  const hasOptions = (q.options?.length ?? 0) > 0 || !!q.carryForward;
  return PIPE_PROPERTIES.filter((p) => {
    if (p.value === "rank") return q.type === "ranking" || q.type === "image_ranking";
    if (p.value === "displayed" || p.value === "remaining") return hasOptions;
    if (p.multiOnly) return isMulti;
    return true;
  });
}

export interface PipingPickerProps {
  onInsert(token: string): void;
  onClose(): void;
  /** question being edited — used to warn about piping from a later question */
  currentQuestionId?: string;
}

export function PipingPicker({ onInsert, onClose, currentQuestionId }: PipingPickerProps) {
  const s = useStudio();
  const questions = s.def.questions;
  const [kind, setKind] = React.useState<PipeToken["kind"]>("question");
  const [ref, setRef] = React.useState(
    questions.find((q) => q.id !== currentQuestionId)?.code ?? questions[0]?.code ?? "",
  );
  const [rowCode, setRowCode] = React.useState("");
  const [property, setProperty] = React.useState<PipeProperty>("label");
  const [format, setFormat] = React.useState<PipeFormat>("comma");
  const [expr, setExpr] = React.useState("");

  const q = questions.find((x) => x.code === ref || x.id === ref);
  const props = propertiesForQuestion(q);
  React.useEffect(() => {
    if (kind === "question" && !props.some((p) => p.value === property)) setProperty("label");
  }, [ref, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The loops around the question being edited, innermost first. Their
   * reference columns are offered by name; a loop the question is not inside
   * is not, because {{loop.X}} would be empty there.
   */
  const loopScope = useLoopScope();
  const [loopTarget, setLoopTarget] = React.useState<string>("");   // "" = innermost, else an outer loopVar
  const scopedLoop = loopTarget ? loopScope.find((l) => l.loopVar === loopTarget) : loopScope[0];

  const token: Omit<PipeToken, "raw" | "text"> =
    kind === "expr"
      ? { kind: "expr", ref: expr, property: "value" }
      : kind === "question"
        ? { kind, ref, rowCode: rowCode || undefined, property, format }
        : kind === "loop"
          ? { kind, ref, property: "value", format, scope: loopTarget || undefined }
          : { kind, ref, property: "value", format };

  const text = serializePipeToken(token);
  const multiValued =
    kind === "question" &&
    ["labels", "rank", "displayed", "remaining", "value"].includes(property);

  const laterThanCurrent =
    !!currentQuestionId &&
    !!q &&
    questions.findIndex((x) => x.id === q.id) > questions.findIndex((x) => x.id === currentQuestionId);

  return (
    <div className="pipe-picker" role="dialog" aria-label="Insert piped text">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Insert piped text</strong>
        <span className="grow" />
        <button className="btn small" onClick={onClose}>×</button>
      </div>

      <label className="f"><span>Insert from</span>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="question">Previous question</option>
          <option value="calc">Calculated value</option>
          <option value="embedded">Embedded data / URL parameter</option>
          <option value="loop">Loop item</option>
          <option value="expr">Expression (calc DSL)</option>
        </select>
      </label>

      {kind === "question" && (
        <>
          <label className="f"><span>Question</span>
            <select className="select" data-testid="pipe-question" value={ref}
              onChange={(e) => setRef(e.target.value)}>
              {questions.map((x) => (
                <option key={x.id} value={x.code}>{x.code} — {(x.text || x.variableName).replace(/<[^>]*>/g, "").slice(0, 46)}</option>
              ))}
            </select>
          </label>
          {(q?.rows?.length ?? 0) > 0 && (
            <label className="f"><span>Row (optional)</span>
              <select className="select" value={rowCode} onChange={(e) => setRowCode(e.target.value)}>
                <option value="">whole answer</option>
                {q!.rows.map((r) => (
                  <option key={String(r.code)} value={String(r.code)}>{r.label.replace(/<[^>]*>/g, "")}</option>
                ))}
              </select>
            </label>
          )}
          <label className="f"><span>Insert</span>
            <select className="select" data-testid="pipe-property" value={property}
              onChange={(e) => setProperty(e.target.value as PipeProperty)}>
              {props.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
        </>
      )}

      {kind === "calc" && (
        <label className="f"><span>Calculation</span>
          <select className="select" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">— pick —</option>
            {s.def.calculations.map((c) => (
              <option key={c.id} value={c.targetVariable}>{c.targetVariable}</option>
            ))}
          </select>
        </label>
      )}
      {kind === "embedded" && (
        <label className="f"><span>Field</span>
          <select className="select" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">— pick —</option>
            {s.def.embeddedData.map((e2) => <option key={e2.name} value={e2.name}>{e2.name}</option>)}
          </select>
        </label>
      )}
      {kind === "loop" && (
        <>
          {loopScope.length > 1 && (
            <label className="f"><span>Which loop</span>
              <select className="select" data-testid="pipe-loop-scope" value={loopTarget} onChange={(e) => { setLoopTarget(e.target.value); setRef("label"); }}>
                <option value="">{loopScope[0].loopVar} (innermost)</option>
                {loopScope.slice(1).map((l) => <option key={l.id} value={l.loopVar}>{l.loopVar} (outer)</option>)}
              </select>
            </label>
          )}
          <label className="f"><span>Loop property</span>
            <select className="select" data-testid="pipe-loop-ref" value={ref} onChange={(e) => setRef(e.target.value)}>
              <option value="label">item label</option>
              <option value="code">item code</option>
              <option value="index">position (1, 2, …)</option>
              <option value="count">number of iterations</option>
              {(scopedLoop?.references?.columns ?? []).length > 0 && (
                <optgroup label={`Reference columns of “${scopedLoop!.loopVar}”`}>
                  {scopedLoop!.references!.columns.map((c) => (
                    <option key={c.name} value={c.name}>{c.name}{c.description ? ` — ${c.description}` : ""}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {loopScope.length === 0 && (
            <p className="muted" style={{ fontSize: 11 }}>This question is not inside a loop, so a loop token here will render empty.</p>
          )}
        </>
      )}
      {kind === "expr" && (
        <label className="f"><span>Expression</span>
          <input className="input mono" placeholder="Q1 + Q2" value={expr}
            onChange={(e) => setExpr(e.target.value)} />
        </label>
      )}

      {multiValued && (
        <label className="f"><span>Format</span>
          <select className="select" data-testid="pipe-format" value={format}
            onChange={(e) => setFormat(e.target.value as PipeFormat)}>
            {PIPE_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label} — {f.example}</option>)}
          </select>
        </label>
      )}

      {laterThanCurrent && (
        <div className="chip warn" style={{ marginBottom: 6 }}>
          {q!.code} is asked after this question — it will be blank unless the respondent goes back.
        </div>
      )}

      <div className="pipe-preview mono">{text}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary small" data-testid="pipe-insert"
          onClick={() => { onInsert(text); onClose(); }}>
          Insert
        </button>
        <button className="btn small" onClick={onClose}>cancel</button>
      </div>
    </div>
  );
}

/** Button + popover, for anywhere a token can be inserted. */
export function InsertPipingButton({ onInsert, currentQuestionId, label = "＋ Piping", className = "btn small" }: {
  onInsert(token: string): void; currentQuestionId?: string; label?: string; className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="pipe-anchor">
      <button type="button" className={className} title="Insert piped text from an earlier answer"
        data-testid="insert-piping"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <PipingPicker currentQuestionId={currentQuestionId}
          onInsert={onInsert} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

/* ------------------------------------------------------------- token chips */

const TOKEN_RE = /\{\{([^}]+?)\}\}/g;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Render `{{…}}` tokens as non-editable chips inside the rich-text surface
 * (req §20). Only text outside of tags is touched, so an attribute that
 * happens to contain braces is left alone.
 */
export function tokensToChips(html: string, codeFor?: (ref: string) => string): string {
  if (!html || !html.includes("{{")) return html;
  return html
    .split(/(<[^>]*>)/g)
    .map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(TOKEN_RE, (m, body) => {
        const t = parsePipeBody(body, m);
        if (!t) return m;
        return `<span class="pipe-chip" contenteditable="false" data-pipe="${esc(m)}">${esc(
          describePipeToken(t, codeFor),
        )}</span>`;
      });
    })
    .join("");
}

/** Turn the chips back into storable token text. */
export function chipsToTokens(html: string): string {
  if (!html || !html.includes("pipe-chip")) return html;
  if (typeof document === "undefined") {
    return html.replace(/<span[^>]*data-pipe="([^"]*)"[^>]*>.*?<\/span>/g, (_m, tok) =>
      tok.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    );
  }
  const host = document.createElement("div");
  host.innerHTML = html;
  host.querySelectorAll("span.pipe-chip").forEach((el) => {
    el.replaceWith(document.createTextNode(el.getAttribute("data-pipe") ?? ""));
  });
  return host.innerHTML;
}
