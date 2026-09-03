"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { SingleSelect } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { activate, getSide, metaText, rng, seedFor, setSide, useOptions, useRows } from "./shared";

/**
 * Gamified / Assessment family — Quiz, Timed Question, Matching.
 *
 * All three store what their base type stores; the scoring lives BESIDE the
 * answer under `<id>__correct` / `<id>__rt` (like `__other`), so the export
 * gains a VAR_CORRECT / VAR_RT column without a new response model:
 *
 *   quiz      single_select  → code            + __correct 1|0
 *   timed     single_select  → code            + __rt ms, __timeout 1
 *   matching  matrix_single  → {row: option}   + __correct (pairs right)
 */

const truthy = (v: unknown) =>
  v === true || v === 1 || v === "1" || v === "true" || v === "yes";

/* ------------------------------------------------------------------- quiz */
export function Quiz(p: QRProps) {
  const options = useOptions(p);
  const feedback = p.q.settings.showFeedback !== false;
  const correct = options.filter((o) => truthy(o.meta?.correct)).map((o) => String(o.code));
  const answered = p.value != null && p.value !== "";
  // with feedback on, the answer is final — seeing which one was right and
  // then being allowed to change it is not a knowledge test
  const locked = feedback && answered;

  const pick = (code: string | number) => {
    if (locked || p.q.settings.readOnly) return;
    setSide(p, "correct", correct.includes(String(code)) ? 1 : 0);
    p.onChange(code);
  };

  const chosen = answered ? String(p.value) : null;
  const gotItRight = chosen != null && correct.includes(chosen);

  return (
    <div className="rs-quiz" data-testid="quiz">
      <div className="rs-options" role="radiogroup">
        {options.map((o) => {
          const code = String(o.code);
          const sel = chosen === code;
          const isRight = correct.includes(code);
          const reveal = locked;
          const mark = reveal ? (isRight ? "✓" : sel ? "✗" : "") : sel ? "●" : "";
          const cls = [
            "rs-quizopt",
            sel ? "selected" : "",
            reveal && isRight ? "right" : "",
            reveal && sel && !isRight ? "wrong" : "",
            locked ? "locked" : "",
          ].filter(Boolean).join(" ");
          const explanation = metaText(o, "explanation");
          return (
            <div key={code} className={cls} data-code={code}
              role="radio" aria-checked={sel} aria-disabled={locked}
              tabIndex={locked ? -1 : 0}
              onClick={() => pick(o.code)} onKeyDown={activate(() => pick(o.code))}>
              <span className="rs-quizopt-mark" aria-hidden>{mark}</span>
              <span className="rs-quizopt-body">
                <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
                {reveal && explanation && (isRight || sel) && (
                  <span className="rs-quizopt-why" dangerouslySetInnerHTML={{ __html: explanation }} />
                )}
              </span>
            </div>
          );
        })}
      </div>
      {locked && (
        <div className={`rs-quiz-verdict ${gotItRight ? "right" : "wrong"}`} data-testid="quiz-verdict"
          role="status">
          {gotItRight ? "✓ Correct" : "✗ Not quite — the correct answer is highlighted."}
        </div>
      )}
      {correct.length === 0 && (
        <div className="rs-quiz-note" data-testid="quiz-nokey">
          No correct answer is marked yet — tick “correct” on an option in the editor.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ timed */
export function TimedQuestion(p: QRProps) {
  const limitMs = Math.max(1, p.q.settings.timeLimitSeconds ?? 10) * 1000;
  const onTimeout = p.q.settings.onTimeout ?? "lock";
  const answered = p.value != null && p.value !== "";
  const startRef = React.useRef<number>(0);
  if (startRef.current === 0) startRef.current = Date.now();
  const [elapsed, setElapsed] = React.useState(0);

  // stop ticking the moment there is an answer or the clock runs out —
  // a timer left running keeps re-rendering the whole page for nothing
  const expired = !answered && elapsed >= limitMs;
  React.useEffect(() => {
    if (answered || expired) return;
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 100);
    return () => clearInterval(t);
  }, [answered, expired]);

  React.useEffect(() => {
    if (!expired) return;
    if (getSide(p, "timeout") === 1) return;
    setSide(p, "rt", null);
    setSide(p, "timeout", 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  const record = () => {
    if (getSide(p, "rt") == null) {
      setSide(p, "rt", Math.max(1, Date.now() - startRef.current));
      setSide(p, "timeout", 0);
    }
  };

  const remaining = Math.max(0, limitMs - (answered ? Math.min(elapsed, limitMs) : elapsed));
  const frac = Math.max(0, Math.min(1, remaining / limitMs));
  const R = 22;
  const C = 2 * Math.PI * R;
  const rt = getSide<number | null>(p, "rt");

  // the clock is over: nothing more may be answered. `advance` differs from
  // `lock` only in the record it leaves — the runner advances on Next either
  // way, so a timed question set to `advance` should not be required.
  const inner: QRProps = expired
    ? { ...p, q: { ...p.q, settings: { ...p.q.settings, readOnly: true } } }
    : { ...p, onChange: (v: unknown) => { record(); p.onChange(v); } };

  return (
    <div className={`rs-timed ${expired ? "expired" : ""}`} data-testid="timed"
      data-expired={expired ? "1" : "0"}>
      <div className="rs-timed-clock" aria-hidden={false} role="timer"
        aria-label={`${Math.ceil(remaining / 1000)} seconds remaining`}>
        <svg viewBox="0 0 52 52" width="52" height="52">
          <circle cx="26" cy="26" r={R} className="ring-track" />
          <circle cx="26" cy="26" r={R} className={`ring-fill ${frac < 0.25 ? "low" : ""}`}
            strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
            transform="rotate(-90 26 26)" />
        </svg>
        <span className="rs-timed-secs" data-testid="timed-remaining">
          {answered ? "✓" : Math.ceil(remaining / 1000)}
        </span>
      </div>
      <div className="rs-timed-body">
        <SingleSelect {...inner} />
        <div className="rs-timed-status" data-testid="timed-status">
          {expired
            ? onTimeout === "advance"
              ? "Time’s up — no answer recorded for this question."
              : "Time’s up — this question is now locked."
            : answered
              ? `Answered in ${((rt ?? 0) / 1000).toFixed(2)}s`
              : `Answer within ${Math.round(limitMs / 1000)}s`}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- matching */
/**
 * Rows are the prompts, options the answers, and a respondent draws the pairs.
 * Stored exactly like a single-select matrix (`{rowCode: optionCode}`), so a
 * matching task reports as an ordinary grid.
 *
 * The answer column is shuffled per respondent from `seedFor`, never
 * `Math.random`, so the inspector can reproduce what they saw.
 */
export function Matching(p: QRProps) {
  const rows = useRows(p);
  const options = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const feedback = p.q.settings.showFeedback !== false;
  const readOnly = !!p.q.settings.readOnly;

  const shuffled = React.useMemo(() => {
    const arr = [...options];
    const r = rng(seedFor(p, "matching"));
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.map((o) => String(o.code)).join("|"), p.state.seed, p.q.id]);

  const [activeRow, setActiveRow] = React.useState<string | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [lines, setLines] = React.useState<{ row: string; x1: number; y1: number; x2: number; y2: number }[]>([]);

  const answers = new Map<string, string>();
  for (const [rc, code] of Object.entries(vals)) {
    if (code != null && code !== "") answers.set(rc, String(code));
  }
  const takenBy = new Map<string, string>(); // optionCode -> rowCode
  for (const [rc, code] of answers) takenBy.set(code, rc);

  const rowKeys = rows.map((r) => String(r.code));
  const allMatched = rowKeys.length > 0 && rowKeys.every((rc) => answers.has(rc));
  const keyed = rows.some((r) => r.meta?.answer != null && r.meta.answer !== "");
  const reveal = feedback && keyed && allMatched;
  const rightCount = rowKeys.filter(
    (rc) => String(rows.find((r) => String(r.code) === rc)?.meta?.answer) === answers.get(rc),
  ).length;

  React.useEffect(() => {
    if (!reveal) return;
    if (getSide(p, "correct") === rightCount) return;
    setSide(p, "correct", rightCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, rightCount]);

  const commit = (next: Record<string, unknown>) => p.onChange(next);

  const clickRow = (rc: string) => {
    if (readOnly || reveal) return;
    if (answers.has(rc)) {
      const next = { ...vals };
      delete next[rc];
      setActiveRow(null);
      commit(next);
      return;
    }
    setActiveRow((cur) => (cur === rc ? null : rc));
  };

  const clickOption = (code: string) => {
    if (readOnly || reveal) return;
    const owner = takenBy.get(code);
    if (owner) {
      // each answer connects once — clicking a taken answer frees it
      const next = { ...vals };
      delete next[owner];
      commit(next);
      return;
    }
    if (!activeRow) return;
    commit({ ...vals, [activeRow]: code });
    setActiveRow(null);
  };

  /** Redraw the connector lines whenever the pairs, the layout or the size change. */
  const measure = React.useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const base = wrap.getBoundingClientRect();
    const out: { row: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const [rc, code] of answers) {
      const a = wrap.querySelector<HTMLElement>(`[data-row="${rc}"]`);
      const b = wrap.querySelector<HTMLElement>(`[data-code="${code}"]`);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      out.push({
        row: rc,
        x1: ra.right - base.left, y1: ra.top + ra.height / 2 - base.top,
        x2: rb.left - base.left, y2: rb.top + rb.height / 2 - base.top,
      });
    }
    setLines(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(Array.from(answers.entries()))]);

  React.useLayoutEffect(() => {
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    if (ro && wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure]);

  if (rows.length === 0 || options.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="matching-empty">
        A matching task needs <strong>rows</strong> (the prompts) and{" "}
        <strong>options</strong> (the answers) — add them in the question editor.
      </div>
    );
  }

  return (
    <div className="rs-matching" data-testid="matching">
      <div className="rs-matching-status" data-testid="matching-progress">
        {answers.size} of {rows.length} matched
        {reveal && <strong className="rs-matching-score"> · {rightCount} of {rows.length} correct</strong>}
      </div>
      <div className="rs-matching-wrap" ref={wrapRef}>
        <svg className="rs-matching-lines" aria-hidden>
          {lines.map((l) => {
            const rowAnswer = rows.find((r) => String(r.code) === l.row)?.meta?.answer;
            const ok = reveal ? String(rowAnswer) === answers.get(l.row) : null;
            return (
              <line key={l.row} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                className={ok == null ? "" : ok ? "ok" : "bad"} />
            );
          })}
        </svg>
        <div className="rs-matching-col">
          {rows.map((r) => {
            const rc = String(r.code);
            const on = answers.has(rc);
            const rowAnswer = r.meta?.answer;
            const ok = reveal ? String(rowAnswer) === answers.get(rc) : null;
            return (
              <div key={rc} data-row={rc}
                className={`rs-matching-item left ${on ? "matched" : ""} ${activeRow === rc ? "active" : ""} ${ok == null ? "" : ok ? "ok" : "bad"}`}
                role="button" aria-pressed={activeRow === rc} tabIndex={0}
                onClick={() => clickRow(rc)} onKeyDown={activate(() => clickRow(rc))}>
                <span className="lbl" dangerouslySetInnerHTML={{ __html: r.label }} />
                <span className="rs-matching-dot" aria-hidden>{ok == null ? "" : ok ? "✓" : "✗"}</span>
              </div>
            );
          })}
        </div>
        <div className="rs-matching-col rcol">
          {shuffled.map((o) => {
            const code = String(o.code);
            const owner = takenBy.get(code);
            return (
              <div key={code} data-code={code}
                className={`rs-matching-item rcol ${owner ? "matched" : ""}`}
                role="button" aria-pressed={!!owner} tabIndex={0}
                onClick={() => clickOption(code)} onKeyDown={activate(() => clickOption(code))}>
                <span className="rs-matching-dot" aria-hidden />
                <span className="lbl" dangerouslySetInnerHTML={{ __html: o.label }} />
              </div>
            );
          })}
        </div>
      </div>
      <div className="rs-matching-hint">
        {reveal
          ? "All pairs made."
          : activeRow
            ? "Now choose its match on the right."
            : "Choose a prompt on the left, then its match on the right. Click a pair to undo it."}
      </div>
    </div>
  );
}

registerVariantRenderer("quiz", Quiz);
registerVariantRenderer("timed", TimedQuestion);
registerVariantRenderer("matching", Matching);
