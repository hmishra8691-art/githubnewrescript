"use client";
import React from "react";
import type { SuiteSummary, TestCaseResult, TestExpectations } from "@rescript/templates";
import { useStudio } from "./store";

/**
 * TEST CASES AND REGRESSION TESTING (§55, §56).
 *
 * The Quality Check in the Logic panel answers "is this survey fit to field"
 * from the definition alone. This answers the question that actually holds a
 * release up: does it still do what it did yesterday, for the respondents
 * that matter — the 17-year-old who must be screened out, the non-user who
 * must skip the usage block, the person whose quota is full.
 *
 * ## The screen is built around one distinction
 *
 * A case can differ from its blessed baseline WITHOUT being broken, because
 * the programmer may have just made that change on purpose. So a changed case
 * is amber and asks a question — "is this right?" — with the change written
 * out in a sentence and an Accept button beside it. A failed case is red and
 * needs no question: a stated expectation is broken.
 *
 * Everything else follows from that. The summary counts them separately, the
 * release verdict ignores amber and blocks on red, and Accept is the one
 * control that turns amber into green.
 *
 * ## What it grades
 *
 * The autosaved draft when there is one, otherwise the current version — the
 * same rule the test link follows. The header says which, before the button
 * is pressed, because a suite that silently graded the published version
 * while you were testing your draft would report green on work you have not
 * saved.
 */

interface SuiteRow {
  test_case_id: string;
  name: string;
  enabled: boolean;
  has_baseline: boolean;
  baseline_at: string | null;
  last_verdict: "pass" | "changed" | "fail" | "stale" | "error" | null;
  last_run_at: string | null;
  last_version_label: string | null;
  last_failures: string[];
  last_changes: { kind: string; detail: string; ref?: string }[];
  run_count: number;
}

interface CaseRow {
  id: string;
  name: string;
  notes: string | null;
  enabled: boolean;
  input: { answers: Record<string, unknown>; seed?: number; embedded?: Record<string, string> };
  expectations: TestExpectations;
  baseline: unknown;
  baseline_at: string | null;
}

interface QuestionInfo {
  id: string; code: string; variableName: string; type: string; text: string;
  options: { code: string; label: string }[];
}

interface Payload {
  suite: SuiteRow[];
  cases: CaseRow[];
  questions: QuestionInfo[];
  pages: { id: string; label: string }[];
  runsAgainst: { source: "draft" | "version"; version: string | null; revision: number | null } | null;
  definitionError: string | null;
  migration?: string;
}

const VERDICT_WORDS: Record<string, string> = {
  pass: "Passing",
  changed: "Changed — needs a decision",
  fail: "Failing",
  stale: "Out of date",
  error: "Could not run",
};
const VERDICT_CLASS: Record<string, string> = {
  pass: "on", changed: "warn", fail: "warn", stale: "warn", error: "warn",
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";

export function TestsPanel() {
  const s = useStudio();
  const [data, setData] = React.useState<Payload | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [lastRun, setLastRun] = React.useState<{ summary: SuiteSummary; results: TestCaseResult[]; label: string } | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | "new" | null>(null);

  const url = `/api/surveys/${s.surveyDbId}/tests`;

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* a loader that swallows its error leaves the panel spinning for ever */
        setLoadError(body.error ?? `The test suite could not be read (${res.status}).`);
        setData(body.migration ? ({ ...body, suite: [], cases: [], questions: [], pages: [] } as Payload) : null);
        return;
      }
      setData(body as Payload);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [url]);

  React.useEffect(() => { void load(); }, [load]);

  const post = async (payload: Record<string, unknown>, label: string) => {
    setBusy(label); setError(null); setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error ?? `That did not work (${res.status}).`); return null; }
      setNote(body.note ?? "Done.");
      await load();
      return body;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !data?.migration) {
    return (
      <div className="auth-note err" data-testid="tests-error">
        <strong>The test suite could not be read.</strong>
        <div style={{ marginTop: 4 }}>{loadError}</div>
      </div>
    );
  }
  if (!data) return <p className="muted">Reading the test suite…</p>;
  if (data.migration) {
    return (
      <div className="auth-note err" data-testid="tests-migration">
        Test cases need migration {data.migration}. Until it is applied there is nowhere to store a case.
      </div>
    );
  }

  const runAll = async () => {
    const body = await post({ action: "run_all" }, "run_all");
    if (body?.summary) {
      setLastRun({ summary: body.summary, results: body.results ?? [], label: body.ranAgainst?.label ?? "" });
    }
  };

  const grading = data.runsAgainst
    ? data.runsAgainst.source === "draft"
      ? `your autosaved draft (revision ${data.runsAgainst.revision ?? "?"})`
      : `the saved version ${data.runsAgainst.version ?? ""}`.trim()
    : null;

  const summary = lastRun?.summary;

  return (
    <div data-testid="tests-panel">
      <h3 className="sec">Test cases</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        A test case is a respondent: the answers they give, and what must happen to them. Running the suite walks
        each one through the survey headlessly and compares the result with the last one you accepted — so a
        change to the questionnaire tells you which respondents it moved, before a client finds out.
      </p>

      {data.definitionError && (
        <div className="auth-note err" data-testid="tests-def-error">
          <strong>The suite cannot run against this survey right now.</strong>
          <div style={{ marginTop: 4 }}>{data.definitionError}</div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <button
          className="btn primary" data-testid="tests-run-all"
          disabled={!!busy || !!data.definitionError || data.cases.length === 0}
          onClick={() => void runAll()}
        >
          {busy === "run_all" ? "Running…" : "Run the whole suite"}
        </button>
        <button className="btn small" data-testid="tests-new" onClick={() => setEditing("new")} disabled={!!busy}>
          + test case
        </button>
        {grading && (
          /* said before the button is pressed, not after */
          <span className="muted" style={{ fontSize: 12.5 }} data-testid="tests-grading">
            Runs against {grading}.
          </span>
        )}
      </div>

      {error && <div className="auth-note err" role="alert" data-testid="tests-error-note">{error}</div>}
      {note && !error && <div className="auth-note ok" data-testid="tests-note">{note}</div>}

      {summary && (
        <div className="card" style={{ padding: 12, marginBottom: 10 }} data-testid="tests-summary">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={`badge ${summary.releasable ? "success" : "danger"}`} data-testid="tests-verdict">
              {summary.releasable ? "Nothing broken" : "Not ready to release"}
            </span>
            <span className="chip on">{summary.pass} passing</span>
            {summary.changed > 0 && <span className="chip warn" data-testid="tests-changed-count">{summary.changed} changed</span>}
            {summary.fail > 0 && <span className="chip warn" data-testid="tests-fail-count">{summary.fail} failing</span>}
            {summary.stale > 0 && <span className="chip warn">{summary.stale} out of date</span>}
            {summary.skipped > 0 && <span className="chip">{summary.skipped} disabled</span>}
            {lastRun?.label && <span className="muted" style={{ fontSize: 12.5 }}>against {lastRun.label}</span>}
          </div>
          {summary.changed > 0 && summary.fail === 0 && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6, marginBottom: 0 }}>
              A changed case is not a failure — it may be exactly the change you just made. Read what moved, then
              accept it or fix it.
            </p>
          )}
        </div>
      )}

      {data.cases.length === 0 && !editing && (
        <div className="card" style={{ padding: 12 }} data-testid="tests-empty">
          <div className="flabel">NO TEST CASES YET</div>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            The ones worth writing first are the paths a client would notice: somebody who screens out, somebody
            who skips a whole block, and somebody who completes. Three cases catch most of what a change breaks.
          </p>
        </div>
      )}

      {editing === "new" && (
        <CaseEditor
          questions={data.questions} pages={data.pages}
          onCancel={() => setEditing(null)}
          onSave={async (payload) => {
            const ok = await post({ action: "create", ...payload }, "create");
            if (ok) setEditing(null);
          }}
          busy={!!busy}
        />
      )}

      {data.suite.map((row) => {
        const full = data.cases.find((c) => c.id === row.test_case_id);
        const fresh = lastRun?.results.find((r) => r.caseId === row.test_case_id);
        const verdict = fresh?.verdict ?? row.last_verdict;
        const failures = fresh?.failures ?? row.last_failures ?? [];
        const changes = fresh?.changes ?? row.last_changes ?? [];
        const isOpen = open === row.test_case_id;

        if (editing === row.test_case_id && full) {
          return (
            <CaseEditor
              key={row.test_case_id}
              existing={full} questions={data.questions} pages={data.pages}
              onCancel={() => setEditing(null)}
              onSave={async (payload) => {
                const ok = await post({ action: "update", caseId: row.test_case_id, ...payload }, "update");
                if (ok) setEditing(null);
              }}
              busy={!!busy}
            />
          );
        }

        return (
          <div
            key={row.test_case_id}
            className="card" style={{ padding: "9px 12px", marginBottom: 6, opacity: row.enabled ? 1 : 0.6 }}
            data-testid="test-case" data-case-id={row.test_case_id} data-verdict={verdict ?? "unrun"}
          >
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{row.name}</strong>
              {verdict
                ? <span className={`chip ${VERDICT_CLASS[verdict] ?? ""}`} data-testid="tc-verdict">{VERDICT_WORDS[verdict] ?? verdict}</span>
                : <span className="chip" data-testid="tc-verdict">Never run</span>}
              {!row.has_baseline && (
                /* the difference between "green" and "nothing has been proved yet" */
                <span className="chip" title="Nothing has been accepted as correct for this case yet">No baseline</span>
              )}
              {!row.enabled && <span className="chip">Disabled</span>}
              <span className="grow" />
              <span className="muted" style={{ fontSize: 12 }}>
                {row.run_count > 0 ? `last run ${when(row.last_run_at)}${row.last_version_label ? ` · ${row.last_version_label}` : ""}` : ""}
              </span>
            </div>

            {(failures.length > 0 || changes.length > 0) && (
              <div style={{ marginTop: 6 }}>
                {failures.map((f, i) => (
                  <div key={`f${i}`} className="chip warn" style={{ marginBottom: 4 }} data-testid="tc-failure">✕ {f}</div>
                ))}
                {changes.map((c, i) => (
                  <div key={`c${i}`} className="chip" style={{ marginBottom: 4 }} data-testid="tc-change">
                    ! {c.detail}
                  </div>
                ))}
              </div>
            )}

            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <button
                className="btn small" data-testid="tc-run" disabled={!!busy || !!data.definitionError}
                onClick={() => void post({ action: "run", caseId: row.test_case_id }, `run:${row.test_case_id}`)}
              >
                {busy === `run:${row.test_case_id}` ? "Running…" : "Run"}
              </button>
              {(verdict === "changed" || (verdict === "pass" && !row.has_baseline && row.run_count > 0)) && (
                <button
                  className="btn small primary" data-testid="tc-bless" disabled={!!busy}
                  onClick={() => void post({ action: "bless", caseId: row.test_case_id }, `bless:${row.test_case_id}`)}
                  title="Record the behaviour of the last run as the one this case should keep"
                >
                  {verdict === "changed" ? "This is correct — accept it" : "Accept as the baseline"}
                </button>
              )}
              <button className="btn small" data-testid="tc-edit" disabled={!!busy} onClick={() => setEditing(row.test_case_id)}>
                Edit
              </button>
              <button
                className="btn small" data-testid="tc-toggle" disabled={!!busy}
                onClick={() => void post({ action: "update", caseId: row.test_case_id, enabled: !row.enabled }, "toggle")}
              >
                {row.enabled ? "Disable" : "Enable"}
              </button>
              <button className="btn small" data-testid="tc-details" onClick={() => setOpen(isOpen ? null : row.test_case_id)}>
                {isOpen ? "Hide detail" : "Detail"}
              </button>
              <button
                className="btn small danger" data-testid="tc-delete" disabled={!!busy}
                onClick={() => { if (confirm(`Delete the test case “${row.name}”? Its run history goes with it.`)) void post({ action: "delete", caseId: row.test_case_id }, "delete"); }}
              >
                ×
              </button>
            </div>

            {isOpen && (
              <div style={{ marginTop: 8, fontSize: 12.5 }} data-testid="tc-detail">
                {full?.notes && <p className="muted" style={{ marginTop: 0 }}>{full.notes}</p>}
                <div className="flabel">ANSWERS</div>
                <div className="mono" style={{ fontSize: 12, marginBottom: 6 }}>
                  {Object.entries(full?.input?.answers ?? {}).map(([qid, v]) => {
                    const q = data.questions.find((x) => x.id === qid);
                    return (
                      <div key={qid}>
                        {q?.code ?? qid} = {JSON.stringify(v)}
                        {!q && <span className="chip warn" style={{ marginLeft: 6 }}>no longer in the survey</span>}
                      </div>
                    );
                  })}
                  {Object.keys(full?.input?.answers ?? {}).length === 0 && (
                    <span className="muted">None — every question gets a default answer for its type.</span>
                  )}
                </div>
                <div className="muted">Seed {full?.input?.seed ?? 1} · baseline accepted {when(full?.baseline_at ?? null)}</div>
                {fresh && (
                  <>
                    <div className="flabel" style={{ marginTop: 8 }}>THE PATH THIS RUN TOOK</div>
                    <div className="mono" style={{ fontSize: 12 }}>
                      {fresh.outcome.path.join(" → ") || "(no pages)"} → <strong>{fresh.outcome.endStatus}</strong>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Writing a case.
 *
 * Answers are chosen per QUESTION, by its code, with the real option labels —
 * the alternative is a JSON blob of ids, which is how a suite ends up written
 * once and never edited. Only the questions a case actually pins are stored;
 * anything left blank gets a default answer for its type at run time, so a
 * case about a screener does not have to answer forty later questions.
 */
function CaseEditor({
  existing, questions, pages, onSave, onCancel, busy,
}: {
  existing?: CaseRow;
  questions: QuestionInfo[];
  pages: { id: string; label: string }[];
  onSave: (payload: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [notes, setNotes] = React.useState(existing?.notes ?? "");
  const [seed, setSeed] = React.useState(String(existing?.input?.seed ?? 1));
  const [answers, setAnswers] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(existing?.input?.answers ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])),
  );
  const [endStatus, setEndStatus] = React.useState(existing?.expectations?.endStatus ?? "");
  const [notVisits, setNotVisits] = React.useState<string[]>(existing?.expectations?.notVisits ?? []);
  const [visits, setVisits] = React.useState<string[]>(existing?.expectations?.visits ?? []);
  const [vars, setVars] = React.useState(
    Object.entries(existing?.expectations?.variables ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
  );

  const setAnswer = (qid: string, raw: string) =>
    setAnswers((a) => {
      const next = { ...a };
      if (raw === "") delete next[qid];
      else next[qid] = raw;
      return next;
    });

  const save = () => {
    /*
     * A typed answer is parsed here, once. `"3"` for a numeric question and
     * `3` are different values to the engine, and a suite that stored the
     * string would test something the runtime never sees.
     */
    const parsed: Record<string, unknown> = {};
    for (const [qid, raw] of Object.entries(answers)) {
      const q = questions.find((x) => x.id === qid);
      if (q && (q.type === "numeric" || q.type === "slider" || q.type === "nps")) {
        const n = Number(raw);
        parsed[qid] = Number.isFinite(n) ? n : raw;
      } else if (raw.startsWith("[") || raw.startsWith("{")) {
        try { parsed[qid] = JSON.parse(raw); } catch { parsed[qid] = raw; }
      } else if (q?.options.length) {
        const opt = q.options.find((o) => o.code === raw);
        parsed[qid] = opt && /^-?\d+$/.test(opt.code) ? Number(opt.code) : raw;
      } else {
        parsed[qid] = raw;
      }
    }
    const variables: Record<string, string | number> = {};
    for (const line of vars.split("\n")) {
      const [k, ...rest] = line.split("=");
      if (!k?.trim() || !rest.length) continue;
      const v = rest.join("=").trim();
      variables[k.trim()] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    const expectations: TestExpectations = {
      ...(endStatus ? { endStatus: endStatus as TestExpectations["endStatus"] } : {}),
      ...(visits.length ? { visits } : {}),
      ...(notVisits.length ? { notVisits } : {}),
      ...(Object.keys(variables).length ? { variables } : {}),
    };
    void onSave({
      name, notes,
      input: { answers: parsed, seed: Number(seed) || 1 },
      expectations,
    });
  };

  return (
    <div className="card" style={{ padding: 12, marginBottom: 10, borderColor: "var(--accent)" }} data-testid="tc-editor">
      <div className="row" style={{ marginBottom: 8, gap: 8 }}>
        <input
          className="input grow" placeholder="What respondent is this? e.g. “A 17-year-old is screened out”"
          data-testid="tc-name" value={name} onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input" style={{ width: 100 }} type="number" placeholder="seed"
          data-testid="tc-seed" value={seed} onChange={(e) => setSeed(e.target.value)}
          title="Fixed so randomisation and option order are the same on every run"
        />
      </div>
      <input
        className="input" style={{ width: "100%", marginBottom: 10 }} placeholder="Why this case matters (optional)"
        data-testid="tc-notes" value={notes} onChange={(e) => setNotes(e.target.value)}
      />

      <div className="flabel">ANSWERS — leave a question blank to let it take a default</div>
      <div style={{ maxHeight: 260, overflowY: "auto", marginBottom: 10 }}>
        {questions.map((q) => (
          <div key={q.id} className="row" style={{ gap: 8, marginBottom: 4, alignItems: "center" }}>
            <span className="mono" style={{ width: 62, fontSize: 12 }}>{q.code}</span>
            <span className="muted grow" style={{ fontSize: 12 }}>{q.text}</span>
            {q.options.length > 0 ? (
              <select
                className="select" style={{ width: 200 }} data-testid={`tc-answer-${q.code}`}
                value={answers[q.id] ?? ""} onChange={(e) => setAnswer(q.id, e.target.value)}
              >
                <option value="">— default —</option>
                {q.options.map((o) => <option key={o.code} value={o.code}>{o.code} — {o.label}</option>)}
              </select>
            ) : (
              <input
                className="input" style={{ width: 200 }} data-testid={`tc-answer-${q.code}`}
                placeholder="default" value={answers[q.id] ?? ""} onChange={(e) => setAnswer(q.id, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flabel">WHAT MUST HAPPEN — optional, and what turns a snapshot into a test</div>
      <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <select className="select" style={{ width: 190 }} data-testid="tc-end-status"
          value={endStatus} onChange={(e) => setEndStatus(e.target.value as never)}>
          <option value="">any ending</option>
          <option value="complete">must complete</option>
          <option value="screened">must be screened out</option>
          <option value="quota_full">must hit a full quota</option>
          <option value="terminated">must be terminated</option>
        </select>
        <PagePicker label="must reach" pages={pages} value={visits} onChange={setVisits} testId="tc-visits" />
        <PagePicker label="must NOT reach" pages={pages} value={notVisits} onChange={setNotVisits} testId="tc-not-visits" />
      </div>
      <textarea
        className="input" style={{ width: "100%", minHeight: 54, fontFamily: "var(--mono)", fontSize: 12 }}
        placeholder={"Variables, one per line:\nANNUAL=300\nNPS_GROUP=Promoter"}
        data-testid="tc-variables" value={vars} onChange={(e) => setVars(e.target.value)}
      />

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn primary" data-testid="tc-save" disabled={busy || !name.trim()} onClick={save}>
          {existing ? "Save case" : "Add case"}
        </button>
        <button className="btn" data-testid="tc-cancel" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Pages are picked, never typed: a mistyped page id is an expectation that
 * can never hold, and it would fail for the wrong reason for ever.
 *
 * The chosen pages show as chips with a remove control, because a picker you
 * can only add to is one where a wrong click is permanent.
 */
function PagePicker({
  label, pages, value, onChange, testId,
}: {
  label: string; pages: { id: string; label: string }[];
  value: string[]; onChange: (v: string[]) => void; testId: string;
}) {
  const remaining = pages.filter((p) => !value.includes(p.id));
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <select
        className="select" style={{ width: 230 }} data-testid={testId}
        value=""
        disabled={remaining.length === 0}
        onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}
      >
        <option value="">{remaining.length ? `${label}…` : `${label}: all chosen`}</option>
        {remaining.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {value.length > 0 && (
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }} data-testid={`${testId}-chosen`}>
          {value.map((id) => (
            <button
              key={id} type="button" className="chip"
              title="Remove"
              onClick={() => onChange(value.filter((x) => x !== id))}
            >
              {pages.find((p) => p.id === id)?.label ?? id} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
