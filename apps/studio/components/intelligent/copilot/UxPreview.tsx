"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { createResponseState, setAnswer } from "@rescript/engine";
import { QuestionRenderer, UxLayer, brandingVars, widthModeClass } from "@rescript/renderer";
import type { UxPreviewScope } from "../../../lib/copilot/client";

/**
 * THE UX PREVIEW — the proposal's look and behaviour on the REAL components:
 * the respondent renderer, the survey's theme, the compiled scoped styles and
 * the same UX layer the runtime mounts (animations, behaviours, sandboxed
 * scripts). Answer the questions to see select / answer behaviour; switch to
 * phone width for the mobile rules; Before shows the survey as it is now.
 * Nothing here is saved: the answers live in this preview only.
 */
export function UxPreview({ after, before, scope }: { after: SurveyDefinition; before: SurveyDefinition; scope: UxPreviewScope }) {
  const [side, setSide] = React.useState<"after" | "before">("after");
  const [device, setDevice] = React.useState<"desktop" | "mobile">("desktop");
  const [replay, setReplay] = React.useState(0);
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const def = side === "after" ? after : before;
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  const questions = scope.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is NonNullable<typeof q> => !!q);
  const state = React.useMemo(() => {
    const st = createResponseState(def);
    for (const [id, v] of Object.entries(values)) setAnswer(def, st, id, v);
    return st;
  }, [def, values]);
  const b = def.branding;
  return (
    <div className="cp-ux-preview" data-testid="cp-ux-preview" data-side={side} data-device={device}>
      <div className="cp-structure-head">
        <span className="iq-label">Preview</span>
        <span className="iq-spacer" />
        <button type="button" className={`iq-btn${side === "after" ? " on" : ""}`} onClick={() => setSide("after")} data-testid="cp-ux-after">After</button>
        <button type="button" className={`iq-btn${side === "before" ? " on" : ""}`} onClick={() => setSide("before")} data-testid="cp-ux-before">Before</button>
        <button type="button" className={`iq-btn${device === "mobile" ? " on" : ""}`} onClick={() => setDevice((d) => (d === "mobile" ? "desktop" : "mobile"))} data-testid="cp-ux-mobile">{device === "mobile" ? "Phone" : "Desktop"}</button>
        <button type="button" className="iq-btn" onClick={() => { setValues({}); setReplay((n) => n + 1); }} data-testid="cp-ux-replay" title="Play the animations again and clear the preview's answers">Replay</button>
      </div>
      <div className={`cp-ux-stage${device === "mobile" ? " rs-viewport mobile" : ""}`}>
        <div key={`${side}-${replay}`} ref={shellRef} className={`rs-shell rs-${b.layout.cardStyle} ${widthModeClass(b)}`} style={{ ...(brandingVars(b) as React.CSSProperties), padding: "12px 14px 18px" }}
          data-rs-ux={def.meta.id} data-rs-block={scope.blockId} data-rs-page={scope.pageId} data-testid="cp-ux-shell">
          <UxLayer def={def} rootRef={shellRef} values={values} allValues={values} shown={questions.map((q) => q.id)} pageKey={`${side}-${replay}`} blockId={scope.blockId} pageId={scope.pageId} pageIndex={1} />
          {scope.chrome && b.layout.progressBar !== "none" && <div className="rs-progress-track"><div className="rs-progress-fill" style={{ width: `${Object.keys(values).length ? 60 : 35}%` }} /></div>}
          <div id="rs-questions">
            {questions.map((q) => (
              <QuestionRenderer key={q.id} def={def} q={q} state={state} loop={null} value={values[q.id]} errors={[]}
                onChange={(v) => setValues((x) => ({ ...x, [q.id]: v }))} onOtherChange={() => {}} />
            ))}
          </div>
          {scope.chrome && (
            <div className="rs-nav">
              <button type="button" className={`rs-btn secondary ${b.buttons.style}`} data-rs-button="back">{b.buttons.backLabel}</button>
              <button type="button" className={`rs-btn ${b.buttons.style}`} data-rs-button="next" data-testid="cp-ux-next">{b.buttons.nextLabel}</button>
            </div>
          )}
        </div>
      </div>
      <p className="iqi-dim cp-ux-caption">The real question components with this survey's theme — answer them to see the selected and answered behaviour. Nothing here is saved.</p>
    </div>
  );
}
