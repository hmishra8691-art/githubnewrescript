"use client";
import React from "react";
import { MediaUrlInput } from "../MediaUrlInput";
import type { Question } from "@rescript/schema";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";
import { BalanceSettings } from "../FlowNodeEditors";

/**
 * Studio authoring for the experimental family.
 *
 *   attention    which option(s) pass, and what failing does
 *   experiment   the arms (A/B and Random Stimulus share the editor)
 *
 * Terminating on a failed attention check is written as an ordinary question
 * `skipLogic` rule — `this question notIn expectedCodes → end/terminated` —
 * rather than as renderer behaviour. That way the flow engine, the logic map,
 * the linter and the QA report all see the termination they already know how
 * to see, and switching back to "flag" removes exactly that rule and nothing
 * else the programmer wrote.
 */

const FAIL_RULE_ID = "attention_fail";

/**
 * "Failed" is `answered AND notIn expected` — not `notIn expected` alone.
 * `notIn` on an unanswered question is vacuously true, so the bare rule would
 * terminate every respondent who skipped a non-required attention check
 * before they ever got it wrong.
 */
function failRule(q: Question) {
  const codes = (q.settings.expectedCodes ?? []).map((c) => String(c));
  return {
    id: FAIL_RULE_ID,
    label: "Attention check failed",
    when: {
      type: "group" as const,
      op: "and" as const,
      children: [
        { type: "rule" as const, source: { kind: "question" as const, ref: q.id }, operator: "answered" as const },
        { type: "rule" as const, source: { kind: "question" as const, ref: q.id }, operator: "notIn" as const, value: codes },
      ],
    },
    target: { kind: "end" as const, status: "terminated" as const },
  };
}

registerVariantSettings("attention", ({ q, patch, patchSettings }) => {
  const expected = (q.settings.expectedCodes ?? []).map(String);
  const onFail = q.settings.onFail ?? "flag";
  const hasRule = q.skipLogic.some((r) => r.id === FAIL_RULE_ID);

  /** Keep settings.onFail and the skip rule in step — one action, both writes. */
  const writeFail = (mode: "flag" | "terminate", codes = expected) => {
    const others = q.skipLogic.filter((r) => r.id !== FAIL_RULE_ID);
    patch({
      settings: { ...q.settings, onFail: mode, expectedCodes: codes },
      skipLogic: mode === "terminate"
        ? [...others, failRule({ ...q, settings: { ...q.settings, expectedCodes: codes } })]
        : others,
    });
  };

  const toggleCode = (code: string) => {
    const next = expected.includes(code) ? expected.filter((c) => c !== code) : [...expected, code];
    if (onFail === "terminate") writeFail("terminate", next);
    else patchSettings({ expectedCodes: next.length ? next : undefined });
  };

  return (
    <>
      <h3 className="sec">Attention check</h3>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Put the trap in the question text (“select Somewhat agree to show you are
        reading”). The respondent sees an ordinary single select — that is the point.
      </div>

      <div className="flabel">Expected answer(s)</div>
      {q.options.length === 0 ? (
        <div className="chip warn" data-testid="attention-needs">Add the options first.</div>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {q.options.map((o) => {
            const code = String(o.code);
            return (
              <label key={code} className="row" style={{ gap: 6, fontSize: 13, marginBottom: 3 }}>
                <input type="checkbox" data-testid={`attention-expected-${code}`}
                  checked={expected.includes(code)}
                  onChange={() => toggleCode(code)} />
                <span>{o.label.replace(/<[^>]*>/g, "")}</span>
                <span className="muted mono" style={{ fontSize: 12.5 }}>{code}</span>
              </label>
            );
          })}
        </div>
      )}

      <label className="f">
        <span>When the check is failed</span>
        <select className="select" data-testid="attention-onfail" value={onFail}
          onChange={(e) => writeFail(e.target.value as "flag" | "terminate")}>
          <option value="flag">Flag it and carry on (exports 0/1)</option>
          <option value="terminate">Terminate the interview</option>
        </select>
      </label>

      {expected.length === 0 && (
        <div className="chip warn" data-testid="attention-nokey">
          Nothing is marked as expected, so every respondent fails.
        </div>
      )}
      {onFail === "terminate" && (
        <div className={hasRule ? "chip on" : "chip warn"} data-testid="attention-rule">
          {hasRule
            ? "Skip logic written: fails → end (terminated). It appears in the logic map like any other termination."
            : "Waiting to write the termination rule…"}
        </div>
      )}
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Exports the chosen code plus <span className="mono">{q.variableName}_PASSED</span> (1/0).
      </div>
    </>
  );
});

registerVariantSettings("experiment", ({ q, patchSettings }) => {
  const arms = q.settings.arms ?? [];
  const write = (next: typeof arms) => patchSettings({ arms: next.length ? next : undefined });
  const setAt = (i: number, patch: Partial<NonNullable<typeof arms>[number]>) =>
    write(arms.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const total = arms.reduce((s, a) => s + (a.weight == null ? 1 : Math.max(0, a.weight)), 0);

  return (
    <>
      <h3 className="sec">Experiment arms</h3>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {q.settings.armBalance?.exact
          ? <>Each respondent&apos;s arm is CLAIMED when the page is entered — the arm furthest below its weighted share first — and stored in <span className="mono">{q.variableName}_ARM</span>.</>
          : <>One arm is assigned per respondent from their seed, so the same respondent always sees the same arm and the assignment is reproducible.</>}
        {" "}A weight of 0 parks an arm without deleting it.
      </div>
      {/* S4c (RA-08): the same exact claim as a randomizer, weighted by the arms' weights */}
      <BalanceSettings value={q.settings.armBalance} onChange={(b) => patchSettings({ armBalance: b })} what="each arm" testId="arm-balance" />

      {arms.map((a, i) => (
        <div key={i} data-testid={`arm-${i}`}
          style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input mono" style={{ width: 70 }} placeholder="code"
              data-testid={`arm-code-${i}`}
              value={String(a.code ?? "")}
              onChange={(e) => setAt(i, { code: e.target.value })} />
            <input className="input grow" placeholder="label (Control, Treatment…)"
              data-testid={`arm-label-${i}`}
              value={a.label ?? ""}
              onChange={(e) => setAt(i, { label: e.target.value })} />
            <CountInput data-testid={`arm-weight-${i}`} min={0} width={64}
              title="weight"
              value={a.weight}
              onChange={(v) => setAt(i, { weight: v })} />
            <button className="btn small danger" data-testid={`arm-remove-${i}`}
              onClick={() => write(arms.filter((_, j) => j !== i))}>×</button>
          </div>
          <div style={{ marginBottom: 6 }}>
            <MediaUrlInput compact label="Media URL (image, video, YouTube or Drive)" testId={`arm-media-${i}`}
              placeholder="https://…" value={a.mediaUrl} onChange={(v) => setAt(i, { mediaUrl: v })} />
          </div>
          <label className="f" style={{ marginBottom: 0 }}>
            <span>HTML shown for this arm</span>
            <textarea className="ta" style={{ minHeight: 60 }} data-testid={`arm-html-${i}`}
              value={a.html ?? ""}
              onChange={(e) => setAt(i, { html: e.target.value || undefined })} />
          </label>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {total > 0
              ? `${Math.round(((a.weight == null ? 1 : Math.max(0, a.weight)) / total) * 100)}% of respondents`
              : "no positive weights — the arms split evenly"}
          </div>
        </div>
      ))}

      <button className="btn small" data-testid="arm-add"
        onClick={() => write([...arms, {
          code: String.fromCharCode(65 + arms.length),
          label: `Arm ${arms.length + 1}`,
          weight: 1,
        }])}>
        + add arm
      </button>
      {arms.length === 0 && (
        <div className="chip warn" data-testid="experiment-noarms" style={{ marginLeft: 8 }}>
          No arms — the question has nothing to assign.
        </div>
      )}
    </>
  );
});

/*
 * S5c (SM-18): the reaction-time block's IAT role and answer key. Tag the four combined blocks (compatible /
 * incompatible × practice / test) and the engine scores them with Greenwald et al.'s (2003) improved D into
 * IAT_D / IAT_TRIALS / IAT_FAST_SHARE / IAT_EXCLUDED (engine iatScore.ts). Untagged = an ordinary timed block.
 */
type IatBlock = NonNullable<Question["settings"]["iatBlock"]>;
registerVariantSettings("iat", ({ q, patchSettings }) => {
  const b = q.settings.iatBlock;
  const set = (next: IatBlock | undefined) => patchSettings({ iatBlock: next });
  return (
    <div className="card" style={{ padding: 10 }} data-testid="iat-editor">
      <label className="ax-field"><span className="flabel">IAT block</span>
        <select className="input" data-testid="iat-role" value={b?.role ?? ""} onChange={(e) => set(e.target.value ? { role: e.target.value as IatBlock["role"], key: b?.key } : undefined)}>
          <option value="">not part of a D-score</option>
          <option value="compatible_practice">B3 — compatible pairing, practice</option>
          <option value="compatible_test">B4 — compatible pairing, test</option>
          <option value="incompatible_practice">B6 — incompatible pairing, practice</option>
          <option value="incompatible_test">B7 — incompatible pairing, test</option>
        </select>
      </label>
      {b?.role && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", marginTop: 6 }} data-testid="iat-key">
          {(q.rows ?? []).map((r) => (
            <React.Fragment key={String(r.code)}>
              <span className="flabel">{r.label.replace(/<[^>]*>/g, "")}</span>
              <select className="input" value={String(b.key?.[String(r.code)] ?? "")} onChange={(e) => set({ ...b, key: { ...(b.key ?? {}), [String(r.code)]: e.target.value } })}>
                <option value="">— correct category —</option>
                {(q.options ?? []).map((o) => <option key={String(o.code)} value={String(o.code)}>{o.label.replace(/<[^>]*>/g, "")}</option>)}
              </select>
            </React.Fragment>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>D600: trials over 10 s dropped, errors = block mean + 600 ms, respondents with more than 10 % of trials under 300 ms excluded. A stimulus with no correct category set counts as correct.</p>
    </div>
  );
});
