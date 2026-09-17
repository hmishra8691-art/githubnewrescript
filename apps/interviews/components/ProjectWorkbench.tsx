"use client";
import React from "react";
import { QuestionsPanel, type BuilderQuestion } from "./builder/QuestionsPanel";
import { RequirementsPanel, type BuilderRequirement } from "./builder/RequirementsPanel";
import { SettingsPanel, type BuilderProject } from "./builder/SettingsPanel";
import { PoolsPanel, type BuilderPool } from "./builder/PoolsPanel";

/**
 * ONE SCREEN TO BUILD AN INTERVIEW.
 *
 * The brief's complaint was that configuring an interview meant walking
 * through disconnected screens. The truth was worse: most of it could not be
 * configured at all. This was a read-only question table, a single text input,
 * and an invite button — no requirements, no settings, no per-question
 * options, no editing of anything already added.
 *
 * Tabs rather than routes, so moving between the questions and the things they
 * are assessed against does not cost a page load or lose a half-typed form.
 * The readiness line sits above them because it is the one thing that is true
 * of the project as a whole, and the answer it gives — "this will record but
 * not evaluate" — is the answer somebody needs before they invite thirty
 * people, not after.
 */
type Tab = "questions" | "order" | "requirements" | "settings" | "invite";

export function ProjectWorkbench({
  project, role, questions, requirements, readiness, pools, randomizePools,
}: {
  project: BuilderProject;
  role: string;
  questions: BuilderQuestion[];
  requirements: BuilderRequirement[];
  readiness: { ready: boolean; say: string };
  pools: BuilderPool[];
  randomizePools: boolean;
}) {
  const [tab, setTab] = React.useState<Tab>("questions");
  const mayEdit = role === "manager" || role === "interviewer";

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "questions", label: "Questions", count: questions.length },
    { id: "order", label: "Order", count: pools.length || undefined },
    { id: "requirements", label: "Assessing", count: requirements.length },
    { id: "settings", label: "Settings" },
    ...(mayEdit ? [{ id: "invite" as const, label: "Invite" }] : []),
  ];

  return (
    <>
      {/*
        * Said once, at the top, in terms of what will happen rather than what
        * is missing. "No requirements" is a fact about a table; "answers will
        * be recorded but not evaluated" is a fact about the interviewer's
        * afternoon.
        */}
      {!readiness.ready && (
        <p className="note warn" data-testid="readiness">{readiness.say}</p>
      )}
      {readiness.ready && readiness.say !== "Ready to evaluate." && (
        <p className="note" data-testid="readiness">{readiness.say}</p>
      )}

      <nav className="row" style={{ gap: 6, marginBottom: 14 }} aria-label="Interview builder">
        {TABS.map((t) => (
          <button key={t.id} type="button"
            className={`btn small ${tab === t.id ? "" : "secondary"}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}{typeof t.count === "number" ? ` (${t.count})` : ""}
          </button>
        ))}
      </nav>

      {tab === "questions" && (
        <QuestionsPanel projectId={project.id} questions={questions} mayEdit={mayEdit}
          pools={pools.map((p) => ({ id: p.id, code: p.code, name: p.name }))} />
      )}
      {tab === "order" && (
        <PoolsPanel projectId={project.id} pools={pools} randomizePools={randomizePools} mayEdit={mayEdit}
          questionCounts={questions.reduce<Record<string, number>>((acc, q) => {
            if (q.pool_id) acc[q.pool_id] = (acc[q.pool_id] ?? 0) + 1;
            return acc;
          }, {})} />
      )}
      {tab === "requirements" && (
        <RequirementsPanel projectId={project.id} requirements={requirements} mayEdit={mayEdit} />
      )}
      {tab === "settings" && <SettingsPanel project={project} mayEdit={mayEdit} />}
      {tab === "invite" && (
        <InvitePanel projectId={project.id} canInvite={questions.length > 0} />
      )}
    </>
  );
}

/**
 * The candidate's link, shown once.
 *
 * This is the only moment the plaintext token exists outside their browser —
 * the database stores only its SHA-256 — so it is shown plainly with the
 * warning that it cannot be recovered. A UI that quietly dropped it would turn
 * the security decision in the invite route into a usability bug.
 */
function InvitePanel({ projectId, canInvite }: { projectId: string; canInvite: boolean }) {
  const [candidate, setCandidate] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [expiresInDays, setExpiresInDays] = React.useState(14);
  const [isTest, setIsTest] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<{ url: string; name: string | null } | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setLink(null); setCopied(false);
    const res = await fetch(`/api/projects/${projectId}/invite`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateName: candidate || undefined,
        candidateEmail: email || undefined,
        expiresInDays, isTest,
      }),
    });
    const reply = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !reply.ok) { setError(reply.error ?? "That did not work."); return; }
    setLink({ url: reply.link, name: candidate || null });
    setCandidate(""); setEmail("");
  }

  return (
    <section className="card" data-testid="invite-panel">
      <h2 style={{ marginTop: 0 }}>Invite a candidate</h2>
      <form onSubmit={invite}>
        <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 220px" }}>
            <span>Their name (optional — only they see it)</span>
            <input value={candidate} onChange={(e) => setCandidate(e.target.value)}
              placeholder="Alex Morgan" data-testid="candidate-name" />
          </label>
          <label style={{ flex: "1 1 220px" }}>
            <span>Their email (optional — for your records)</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              data-testid="candidate-email" />
          </label>
          <label style={{ flex: "0 1 160px" }}>
            <span>Link expires in (days)</span>
            <input type="number" min={1} max={90} value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))} data-testid="invite-expiry" />
          </label>
        </div>

        <label className="row" style={{ gap: 8, alignItems: "center", marginTop: 10 }}>
          <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)}
            data-testid="invite-test" />
          <span>
            A test run — kept out of reporting.{" "}
            <span className="tiny muted">Use this to sit your own interview before anybody else does.</span>
          </span>
        </label>

        <button className="btn" disabled={busy || !canInvite} style={{ marginTop: 14 }} data-testid="invite">
          Create an interview link
        </button>
        {!canInvite && (
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Add a question first — otherwise the link opens onto an empty interview.
          </p>
        )}
      </form>

      {link && (
        <div className="note warn" style={{ marginTop: 14 }} data-testid="invite-link">
          <strong>This link is shown once.</strong> It cannot be recovered — if it is lost, issue a
          new one.
          <p style={{ margin: "8px 0 0", wordBreak: "break-all" }}><code>{link.url}</code></p>
          <button className="btn secondary" style={{ marginTop: 8 }}
            onClick={() => { void navigator.clipboard?.writeText(link.url); setCopied(true); }}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {error && <p className="note bad" style={{ marginTop: 12 }}>{error}</p>}
    </section>
  );
}
