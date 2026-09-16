"use client";
import React from "react";

interface Question {
  id: string; code: string; prompt: string; kind: string;
  required: boolean; max_seconds: number | null; max_retries: number;
  position: number; category: string;
}

/**
 * The question bank and the invite button.
 *
 * The invite reply carries the candidate's link, and this is the only moment
 * it exists outside their browser — so it is shown once, plainly, with the
 * warning that it cannot be recovered. A UI that quietly dropped it would
 * make the security decision in the invite route into a usability bug.
 */
export function ProjectWorkbench({ projectId, role, questions: initial }: {
  projectId: string; role: string; questions: Question[];
}) {
  const [questions, setQuestions] = React.useState(initial);
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<{ url: string; name: string | null } | null>(null);
  const [candidate, setCandidate] = React.useState("");

  const mayEdit = role === "manager" || role === "interviewer";

  async function addQuestion(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch(`/api/projects/${projectId}/questions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, maxSeconds: 180 }),
    });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That did not work."); return; }
    setQuestions((qs) => [...qs, reply.question]);
    setPrompt("");
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setLink(null);
    const res = await fetch(`/api/projects/${projectId}/invite`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateName: candidate }),
    });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That did not work."); return; }
    setLink({ url: reply.link, name: candidate || null });
    setCandidate("");
  }

  return (
    <>
      <div className="card">
        <h2>Questions</h2>
        {questions.length === 0 ? (
          <p className="muted small">No questions yet. An interview needs at least one.</p>
        ) : (
          <table>
            <thead><tr><th>Code</th><th>Question</th><th>Length</th><th>Retries</th></tr></thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id}>
                  <td><code>{q.code}</code></td>
                  <td>{q.prompt}{!q.required && <span className="pill" style={{ marginLeft: 8 }}>optional</span>}</td>
                  <td className="muted tiny">{q.max_seconds ? `${Math.round(q.max_seconds / 60)} min` : "—"}</td>
                  <td className="muted tiny">{q.max_retries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {mayEdit && (
          <form onSubmit={addQuestion} style={{ marginTop: 14 }}>
            <label>
              <span>Add a question</span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder="Tell us about a system you designed and what you would change."
                data-testid="question-prompt-input" />
            </label>
            <button className="btn" disabled={busy || !prompt.trim()} data-testid="add-question">
              Add question
            </button>
          </form>
        )}
      </div>

      {mayEdit && (
        <div className="card">
          <h2>Invite a candidate</h2>
          <form onSubmit={invite}>
            <label>
              <span>Their name (optional — it only appears on their own screen)</span>
              <input value={candidate} onChange={(e) => setCandidate(e.target.value)}
                placeholder="Alex Morgan" data-testid="candidate-name" />
            </label>
            <button className="btn" disabled={busy || questions.length === 0} data-testid="invite">
              Create an interview link
            </button>
            {questions.length === 0 && (
              <p className="tiny muted" style={{ marginTop: 8 }}>
                Add a question first — otherwise the link opens onto an empty interview.
              </p>
            )}
          </form>

          {link && (
            <div className="note warn" style={{ marginTop: 14 }} data-testid="invite-link">
              <strong>This link is shown once.</strong> It cannot be recovered — if it is lost,
              issue a new one.
              <p style={{ margin: "8px 0 0", wordBreak: "break-all" }}>
                <code>{link.url}</code>
              </p>
              <button className="btn secondary" style={{ marginTop: 8 }}
                onClick={() => void navigator.clipboard?.writeText(link.url)}>
                Copy link
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="note bad">{error}</p>}
    </>
  );
}
