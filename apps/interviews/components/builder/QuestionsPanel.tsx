"use client";
import React from "react";
import type { Condition, SkipRule } from "@rescript/schema";
import {
  CODE_LANGUAGES, CODE_LANGUAGE_SAY, CODE_MAX_CHARS_CEILING, CODE_STARTER_MAX_CHARS,
  KIND_MEANS, KIND_SAY, KINDS_WITH_OPTIONS, MAX_ANSWER_SECONDS, QUESTION_CATEGORIES, QUESTION_KINDS,
  checkQuestion, forwardReferences, readCodeSettings, type CodeLanguage, type CodeSettings, type QuestionKind,
} from "@rescript/interviews";
import { PromptClip } from "./PromptClip";
import { ShowIfEditor, SkipRulesEditor, type EarlierQuestion } from "./LogicEditor";

export interface BuilderQuestion {
  id: string;
  code: string;
  prompt: string;
  guidance: string | null;
  kind: string;
  category: string;
  required: boolean;
  min_seconds: number | null;
  max_seconds: number | null;
  max_retries: number;
  think_seconds: number;
  position: number;
  options: { code: string; label: string }[];
  visible_if: Condition | null;
  skip_logic: SkipRule[];
  prompt_media_id: string | null;
  pool_id: string | null;
  /** per-kind settings; `{ code: CodeSettings }` for a code question */
  settings?: Record<string, unknown> | null;
}

export interface PoolChoice { id: string; code: string; name: string }

/**
 * THE QUESTION BANK, EDITABLE.
 *
 * What this replaces: a read-only table and a single text input that posted a
 * prompt and a hardcoded three-minute limit. Every other setting the schema
 * has carried since 0030 — guidance, minimum and maximum length, re-record
 * attempts, thinking time, the kind of answer, the category — was accepted by
 * the API and honoured by the runtime, and could not be set by anybody using
 * the product.
 *
 * ## Checked here and again on the server
 *
 * `checkQuestion` is the same function the routes call. Running it in the
 * browser is not the guard — the route is — it is so the interviewer finds out
 * that a minimum of two minutes against a maximum of one is unanswerable while
 * they are typing it, rather than after a round trip that throws their work
 * away.
 */
export function QuestionsPanel({ projectId, questions: initial, mayEdit, pools = [] }: {
  projectId: string;
  questions: BuilderQuestion[];
  mayEdit: boolean;
  pools?: PoolChoice[];
}) {
  const [questions, setQuestions] = React.useState(initial);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const sorted = React.useMemo(
    () => [...questions].sort((a, b) => a.position - b.position),
    [questions],
  );

  /*
   * A condition that reads a LATER question can never be true when its own
   * question is reached, so the engine hides that question for everybody,
   * silently. Reordering is the usual way this happens — the rule was fine
   * until somebody dragged its source below it — so it is checked against the
   * live order, not at save time only.
   */
  const forward = React.useMemo(() => forwardReferences(
    sorted.map((q) => ({
      id: q.id, code: q.code, kind: q.kind as never, prompt: q.prompt, required: q.required,
      visibleIf: q.visible_if, skipLogic: q.skip_logic,
    })),
    sorted.map((q) => q.id),
  ), [sorted]);

  async function save(draft: Partial<BuilderQuestion> & { id?: string }) {
    setBusy(true); setError(null); setNote(null);
    const isNew = !draft.id;
    const res = await fetch(
      isNew ? `/api/projects/${projectId}/questions` : `/api/projects/${projectId}/questions/${draft.id}`,
      {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: draft.prompt, guidance: draft.guidance, kind: draft.kind,
          category: draft.category, required: draft.required,
          minSeconds: draft.min_seconds, maxSeconds: draft.max_seconds,
          maxRetries: draft.max_retries, thinkSeconds: draft.think_seconds,
          options: draft.options, visibleIf: draft.visible_if ?? null, skipLogic: draft.skip_logic ?? [],
          poolId: draft.pool_id ?? null,
          settings: draft.settings ?? {},
        }),
      },
    );
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That question could not be saved."); return false; }
    setQuestions((qs) => isNew
      ? [...qs, reply.question]
      : qs.map((q) => (q.id === reply.question.id ? reply.question : q)));
    if (reply.warnings?.length) setNote(reply.warnings.join(" "));
    setEditing(null); setAdding(false);
    return true;
  }

  async function archive(q: BuilderQuestion) {
    setBusy(true); setError(null);
    const res = await fetch(`/api/projects/${projectId}/questions/${q.id}`, { method: "DELETE" });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That question could not be removed."); return; }
    setQuestions((qs) => qs.filter((x) => x.id !== q.id));
    setNote(reply.note ?? null);
  }

  /**
   * Move one question and send the whole order.
   *
   * Optimistic, because a list that waits for the network to reorder feels
   * broken, and the failure case restores from the server's answer rather than
   * from a local guess about what went wrong.
   */
  async function move(id: string, by: -1 | 1) {
    const at = sorted.findIndex((q) => q.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= sorted.length) return;
    const next = [...sorted];
    [next[at], next[to]] = [next[to], next[at]];
    setQuestions(next.map((q, i) => ({ ...q, position: i + 1 })));

    const res = await fetch(`/api/projects/${projectId}/questions`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: next.map((q) => q.id) }),
    });
    if (!res.ok) {
      setError("That order could not be saved — reload to see the real order.");
    }
  }

  return (
    <section className="card" data-testid="questions-panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>Questions</h2>
        {mayEdit && !adding && (
          <button className="btn" onClick={() => { setAdding(true); setEditing(null); }} data-testid="add-question">
            Add a question
          </button>
        )}
      </div>

      {sorted.length === 0 && !adding && (
        <p className="muted small">No questions yet. An interview needs at least one.</p>
      )}

      {forward.map((f) => {
        const q = sorted.find((x) => x.id === f.questionId);
        const ref = sorted.find((x) => x.id === f.refersTo);
        return (
          <p key={`${f.questionId}-${f.refersTo}`} className="note warn" data-testid="forward-reference">
            <strong>{q?.code}</strong> has a rule that depends on <strong>{ref?.code ?? "a question"}</strong>, which comes
            after it. That rule can never be true when {q?.code} is reached, so {q?.code} will be hidden from everyone.
            Move {ref?.code ?? "it"} earlier, or change the rule.
          </p>
        );
      })}

      {sorted.map((q, i) => (
        <div key={q.id} data-testid="question-row" data-code={q.code}
          style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
          {editing === q.id ? (
            <QuestionForm initial={q} busy={busy} onCancel={() => setEditing(null)}
              projectId={projectId} pools={pools}
              earlier={sorted.slice(0, i).map(asEarlier)}
              later={sorted.slice(i + 1).map(asEarlier)}
              onSave={(d) => save({ ...d, id: q.id })}
              onPromptChange={(mediaId) => setQuestions((qs) => qs.map((x) => (x.id === q.id ? { ...x, prompt_media_id: mediaId } : x)))} />
          ) : (
            <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong><code>{q.code}</code></strong>
                  <span className="pill">{KIND_SAY[q.kind as QuestionKind] ?? q.kind}</span>
                  {!q.required && <span className="pill">optional</span>}
                  {q.category !== "custom" && <span className="pill">{q.category}</span>}
                  {q.prompt_media_id && <span className="pill" title="The interviewer asks this on video">video prompt</span>}
                  {q.pool_id && <span className="pill" title="Drawn from a pool">{pools.find((p) => p.id === q.pool_id)?.name ?? "pool"}</span>}
                  {q.visible_if && <span className="pill" title="Shown only when a condition holds">show-if</span>}
                  {q.skip_logic?.length > 0 && <span className="pill" title="Can route the interview">skip rules</span>}
                </div>
                <p style={{ margin: "6px 0 0" }}>{q.prompt}</p>
                {q.guidance && <p className="small muted" style={{ margin: "4px 0 0" }}>{q.guidance}</p>}
                <p className="tiny muted" style={{ margin: "6px 0 0" }}>
                  {q.kind === "text" ? "Typed answer" : q.kind === "code" ? `Code · ${CODE_LANGUAGE_SAY[readCodeSettings(q.settings).language]}${readCodeSettings(q.settings).allowLanguageChoice ? " or the candidate's choice" : ""}` : describeLimits(q)}
                  {q.think_seconds > 0 ? ` · ${q.think_seconds}s to think first` : ""}
                </p>
              </div>
              {mayEdit && (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small secondary" disabled={i === 0 || busy}
                    onClick={() => void move(q.id, -1)} aria-label={`Move ${q.code} earlier`}>↑</button>
                  <button className="btn small secondary" disabled={i === sorted.length - 1 || busy}
                    onClick={() => void move(q.id, 1)} aria-label={`Move ${q.code} later`}>↓</button>
                  <button className="btn small secondary" onClick={() => { setEditing(q.id); setAdding(false); }}
                    data-testid="edit-question">Edit</button>
                  <button className="btn small secondary" disabled={busy} onClick={() => void archive(q)}
                    data-testid="archive-question">Remove</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {adding && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
          <QuestionForm busy={busy} onCancel={() => setAdding(false)} onSave={(d) => save(d)}
            projectId={projectId} pools={pools} earlier={sorted.map(asEarlier)} later={[]} />
        </div>
      )}

      {note && <p className="note" style={{ marginTop: 12 }} data-testid="question-note">{note}</p>}
      {error && <p className="note bad" style={{ marginTop: 12 }} data-testid="question-error">{error}</p>}
    </section>
  );
}

const asEarlier = (q: BuilderQuestion): EarlierQuestion => ({
  id: q.id, code: q.code, prompt: q.prompt, kind: q.kind, options: q.options ?? [],
});

function describeLimits(q: BuilderQuestion): string {
  const max = q.max_seconds ? `up to ${fmt(q.max_seconds)}` : "no limit";
  const min = q.min_seconds ? `, at least ${fmt(q.min_seconds)}` : "";
  const retries = q.max_retries > 0 ? ` · ${q.max_retries} re-record${q.max_retries === 1 ? "" : "s"}` : " · one take";
  return `${max}${min}${retries}`;
}

const fmt = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`);

/**
 * One question's settings.
 *
 * Deliberately one form rather than a wizard: the brief's complaint is that
 * configuring an interview meant walking through disconnected screens, and a
 * question has eight settings, which is a form.
 */
function QuestionForm({ initial, busy, onSave, onCancel, projectId, earlier, later, onPromptChange, pools }: {
  initial?: BuilderQuestion;
  busy: boolean;
  onSave: (d: Partial<BuilderQuestion>) => Promise<boolean>;
  onCancel: () => void;
  projectId: string;
  earlier: EarlierQuestion[];
  later: EarlierQuestion[];
  onPromptChange?: (mediaId: string | null) => void;
  pools: PoolChoice[];
}) {
  const [poolId, setPoolId] = React.useState<string | null>(initial?.pool_id ?? null);
  const [prompt, setPrompt] = React.useState(initial?.prompt ?? "");
  const [guidance, setGuidance] = React.useState(initial?.guidance ?? "");
  const [kind, setKind] = React.useState<QuestionKind>((initial?.kind as QuestionKind) ?? "video");
  const [category, setCategory] = React.useState(initial?.category ?? "custom");
  const [required, setRequired] = React.useState(initial?.required ?? true);
  const [minSeconds, setMinSeconds] = React.useState<number | null>(initial?.min_seconds ?? null);
  const [maxSeconds, setMaxSeconds] = React.useState<number | null>(initial?.max_seconds ?? 180);
  const [maxRetries, setMaxRetries] = React.useState(initial?.max_retries ?? 0);
  const [thinkSeconds, setThinkSeconds] = React.useState(initial?.think_seconds ?? 0);
  const [options, setOptions] = React.useState<{ code: string; label: string }[]>(
    initial?.options?.length ? initial.options : [{ code: "", label: "" }, { code: "", label: "" }],
  );
  const [visibleIf, setVisibleIf] = React.useState<Condition | null>(initial?.visible_if ?? null);
  const [skipLogic, setSkipLogic] = React.useState<SkipRule[]>(initial?.skip_logic ?? []);
  const [promptMediaId, setPromptMediaId] = React.useState<string | null>(initial?.prompt_media_id ?? null);
  const [codeSettings, setCodeSettings] = React.useState<CodeSettings>(readCodeSettings(initial?.settings));
  const hasOptions = KINDS_WITH_OPTIONS.includes(kind);
  const recorded = kind === "video" || kind === "audio";
  const isCode = kind === "code";

  const draft = {
    prompt, guidance, kind, category, required,
    min_seconds: minSeconds, max_seconds: maxSeconds,
    max_retries: maxRetries, think_seconds: thinkSeconds,
    options: hasOptions ? options : [],
    visible_if: visibleIf, skip_logic: skipLogic,
    pool_id: poolId,
    settings: isCode ? { code: codeSettings } : {},
  };
  /* the same function the route runs — see the file header */
  const check = checkQuestion({
    prompt, kind, category, minSeconds, maxSeconds, maxRetries, thinkSeconds,
    options: hasOptions ? options : undefined,
    settings: isCode ? { code: codeSettings } : undefined,
  });

  return (
    <form data-testid="question-form" onSubmit={(e) => { e.preventDefault(); void onSave(draft); }}>
      <label>
        <span>What are you asking?</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2}
          placeholder="Tell us about a system you designed and what you would change."
          data-testid="question-prompt-input" />
      </label>

      <label>
        <span>Guidance shown under the question (optional)</span>
        <input value={guidance ?? ""} onChange={(e) => setGuidance(e.target.value)}
          placeholder="Two or three minutes is plenty." data-testid="question-guidance" />
      </label>

      <div className="row" style={{ gap: 14, flexWrap: "wrap", marginTop: 10 }}>
        <label style={{ flex: "1 1 220px" }}>
          <span>How they answer</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as QuestionKind)} data-testid="question-kind">
            {QUESTION_KINDS.map((k) => <option key={k} value={k}>{KIND_SAY[k]}</option>)}
          </select>
          <span className="tiny muted">{KIND_MEANS[kind]}</span>
        </label>

        <label style={{ flex: "1 1 160px" }}>
          <span>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} data-testid="question-category">
            {QUESTION_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {pools.length > 0 && (
          <label style={{ flex: "1 1 160px" }}>
            <span>Pool</span>
            <select value={poolId ?? ""} onChange={(e) => setPoolId(e.target.value || null)} data-testid="question-pool">
              <option value="">— none (fixed position) —</option>
              {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="tiny muted">Pooled questions are drawn and ordered by the pool&apos;s settings.</span>
          </label>
        )}
      </div>

      {hasOptions && (
        <div style={{ marginTop: 10 }} data-testid="options-editor">
          <span className="small">Options</span>
          {options.map((o, i) => (
            <div key={i} className="row" style={{ gap: 8, marginTop: 6, alignItems: "center" }}>
              <input value={o.label} placeholder={`Option ${i + 1}`} data-testid="option-label"
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input value={o.code} placeholder="code" style={{ maxWidth: 120 }} data-testid="option-code"
                title="Rules refer to an option by this code. Leave blank to derive it from the label."
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
              <button type="button" className="btn small secondary" disabled={options.length <= 2}
                onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Remove option">×</button>
            </div>
          ))}
          <button type="button" className="btn small secondary" style={{ marginTop: 6 }} data-testid="option-add"
            onClick={() => setOptions([...options, { code: "", label: "" }])}>+ option</button>
        </div>
      )}

      {isCode && (
        <div style={{ marginTop: 10 }} data-testid="code-settings">
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            <label style={{ flex: "1 1 160px" }}>
              <span>Language</span>
              <select value={codeSettings.language} data-testid="code-setting-language"
                onChange={(e) => setCodeSettings({ ...codeSettings, language: e.target.value as CodeLanguage })}>
                {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{CODE_LANGUAGE_SAY[l]}</option>)}
              </select>
            </label>
            <label style={{ flex: "1 1 160px" }}>
              <span>Size limit (characters)</span>
              <input type="number" min={1} max={CODE_MAX_CHARS_CEILING} value={codeSettings.maxChars} data-testid="code-setting-max"
                onChange={(e) => setCodeSettings({ ...codeSettings, maxChars: Number(e.target.value) || codeSettings.maxChars })} />
            </label>
          </div>
          <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
            <input type="checkbox" checked={codeSettings.allowLanguageChoice} data-testid="code-setting-choice"
              onChange={(e) => setCodeSettings({ ...codeSettings, allowLanguageChoice: e.target.checked })} />
            <span className="small">The candidate may pick a different language</span>
          </label>
          <label style={{ display: "block", marginTop: 8 }}>
            <span>Starter code <span className="tiny muted">(optional — what the editor opens with; handing it back unchanged is not an answer)</span></span>
            <textarea value={codeSettings.starter} rows={5} maxLength={CODE_STARTER_MAX_CHARS} spellCheck={false} data-testid="code-setting-starter"
              style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, whiteSpace: "pre", tabSize: 2 }}
              onChange={(e) => setCodeSettings({ ...codeSettings, starter: e.target.value })} />
          </label>
          <p className="tiny muted" style={{ margin: "6px 0 0" }}>Nothing is executed. The reviewer reads the code beside the transcript, and the analysis quotes from it like any typed answer.</p>
        </div>
      )}

      {recorded && (
        <div className="row" style={{ gap: 14, flexWrap: "wrap", marginTop: 10 }}>
          <label style={{ flex: "1 1 140px" }}>
            <span>Longest answer (seconds)</span>
            <input type="number" min={1} max={MAX_ANSWER_SECONDS} value={maxSeconds ?? ""}
              onChange={(e) => setMaxSeconds(e.target.value === "" ? null : Number(e.target.value))}
              data-testid="question-max-seconds" />
          </label>
          <label style={{ flex: "1 1 140px" }}>
            <span>Shortest answer (optional)</span>
            <input type="number" min={1} value={minSeconds ?? ""}
              onChange={(e) => setMinSeconds(e.target.value === "" ? null : Number(e.target.value))}
              data-testid="question-min-seconds" />
          </label>
          <label style={{ flex: "1 1 140px" }}>
            <span>Re-records allowed</span>
            <input type="number" min={0} max={10} value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value))} data-testid="question-retries" />
          </label>
          <label style={{ flex: "1 1 140px" }}>
            <span>Thinking time (seconds)</span>
            <input type="number" min={0} max={600} value={thinkSeconds}
              onChange={(e) => setThinkSeconds(Number(e.target.value))} data-testid="question-think" />
          </label>
        </div>
      )}

      <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 10 }}>
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)}
          data-testid="question-required" />
        <span>They must answer this one to finish</span>
      </label>

      {/*
        * The clip can only be attached to a question that exists — it needs an
        * id to be stored against — so a brand-new question saves first and
        * gets its clip on the next edit. The form says so rather than hiding
        * the control.
        */}
      {initial ? (
        <PromptClip projectId={projectId} questionId={initial.id} promptMediaId={promptMediaId}
          onChange={(id) => { setPromptMediaId(id); onPromptChange?.(id); }} />
      ) : (
        <p className="tiny muted" style={{ marginTop: 10 }}>Save the question first to record yourself asking it.</p>
      )}

      <details style={{ marginTop: 12 }} open={!!visibleIf || skipLogic.length > 0} data-testid="logic-section">
        <summary className="small" style={{ cursor: "pointer" }}>Logic — when this is shown, and where it leads</summary>
        <div style={{ marginTop: 8 }}>
          <span className="small">Show this question only when…</span>
          <ShowIfEditor value={visibleIf} earlier={earlier} onChange={setVisibleIf} />
        </div>
        {initial && (
          <div style={{ marginTop: 12 }}>
            <span className="small">After it is answered…</span>
            <SkipRulesEditor value={skipLogic} onChange={setSkipLogic} later={later}
              self={{ id: initial.id, code: initial.code, prompt, kind, options: hasOptions ? options : [] }} />
          </div>
        )}
      </details>

      {check.errors.map((e) => (
        <p key={e} className="note bad" style={{ marginTop: 10 }} data-testid="question-form-error">{e}</p>
      ))}
      {check.warnings.map((w) => (
        <p key={w} className="note warn" style={{ marginTop: 10 }} data-testid="question-form-warning">{w}</p>
      ))}

      <div className="row" style={{ gap: 10, marginTop: 14 }}>
        <button className="btn" disabled={busy || !check.ok} data-testid="save-question">
          {initial ? "Save changes" : "Add question"}
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
