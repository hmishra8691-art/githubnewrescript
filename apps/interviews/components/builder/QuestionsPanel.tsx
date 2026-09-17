"use client";
import React from "react";
import {
  KIND_MEANS, KIND_SAY, MAX_ANSWER_SECONDS, QUESTION_CATEGORIES, QUESTION_KINDS,
  checkQuestion, type QuestionKind,
} from "@rescript/interviews";

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
}

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
export function QuestionsPanel({ projectId, questions: initial, mayEdit }: {
  projectId: string;
  questions: BuilderQuestion[];
  mayEdit: boolean;
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

      {sorted.map((q, i) => (
        <div key={q.id} data-testid="question-row" data-code={q.code}
          style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
          {editing === q.id ? (
            <QuestionForm initial={q} busy={busy} onCancel={() => setEditing(null)}
              onSave={(d) => save({ ...d, id: q.id })} />
          ) : (
            <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <strong><code>{q.code}</code></strong>
                  <span className="pill">{KIND_SAY[q.kind as QuestionKind] ?? q.kind}</span>
                  {!q.required && <span className="pill">optional</span>}
                  {q.category !== "custom" && <span className="pill">{q.category}</span>}
                </div>
                <p style={{ margin: "6px 0 0" }}>{q.prompt}</p>
                {q.guidance && <p className="small muted" style={{ margin: "4px 0 0" }}>{q.guidance}</p>}
                <p className="tiny muted" style={{ margin: "6px 0 0" }}>
                  {q.kind === "text" ? "Typed answer" : describeLimits(q)}
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
          <QuestionForm busy={busy} onCancel={() => setAdding(false)} onSave={(d) => save(d)} />
        </div>
      )}

      {note && <p className="note" style={{ marginTop: 12 }} data-testid="question-note">{note}</p>}
      {error && <p className="note bad" style={{ marginTop: 12 }} data-testid="question-error">{error}</p>}
    </section>
  );
}

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
function QuestionForm({ initial, busy, onSave, onCancel }: {
  initial?: BuilderQuestion;
  busy: boolean;
  onSave: (d: Partial<BuilderQuestion>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = React.useState(initial?.prompt ?? "");
  const [guidance, setGuidance] = React.useState(initial?.guidance ?? "");
  const [kind, setKind] = React.useState<QuestionKind>((initial?.kind as QuestionKind) ?? "video");
  const [category, setCategory] = React.useState(initial?.category ?? "custom");
  const [required, setRequired] = React.useState(initial?.required ?? true);
  const [minSeconds, setMinSeconds] = React.useState<number | null>(initial?.min_seconds ?? null);
  const [maxSeconds, setMaxSeconds] = React.useState<number | null>(initial?.max_seconds ?? 180);
  const [maxRetries, setMaxRetries] = React.useState(initial?.max_retries ?? 0);
  const [thinkSeconds, setThinkSeconds] = React.useState(initial?.think_seconds ?? 0);

  const draft = {
    prompt, guidance, kind, category, required,
    min_seconds: minSeconds, max_seconds: maxSeconds,
    max_retries: maxRetries, think_seconds: thinkSeconds,
  };
  /* the same function the route runs — see the file header */
  const check = checkQuestion({
    prompt, kind, category, minSeconds, maxSeconds, maxRetries, thinkSeconds,
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
      </div>

      {kind !== "text" && (
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
