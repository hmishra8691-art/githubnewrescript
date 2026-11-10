"use client";
import * as React from "react";
import type { Question, SurveyDefinition } from "@rescript/schema";
import {
  advance, answerKey, autoNextReady, resolveAuthorHtml, createResponseState, languageName, localizeDefinition, offeredLanguages, otherTextsOf, setAnswer, setOtherText, setOtherTextFor, start, surveyLanguages, validatePage, visibleQuestions,
  type NavigationResult, type ResponseState, type ValidationError,
} from "@rescript/engine";
import { ProgressIndicator, QuestionRenderer, SafeImage, UxLayer, brandingClasses, brandingResponsiveCss, brandingVars, widthModeClass } from "@rescript/renderer";

/**
 * THE RESPONDENT VIEW OF A DOCS EXAMPLE (Developer Docs, 2026-11-09): the survey as a respondent meets it — the real
 * `QuestionRenderer` for every question and the real engine for everything between them (`start`, `visibleQuestions`,
 * `validatePage`, `advance`), so display logic, piping, skips, loops, randomizers, terminates and redirects behave
 * exactly as they do on a live link. The UX layer (styles and scripts) runs contained in the example, as in the
 * Studio's preview. Nothing is saved: the state lives in this component and Restart starts a new respondent.
 *
 * The survey's BRANDING is drawn as the runtime draws it (phase 3): the page background, the logo or header HTML,
 * the progress indicator (top or bottom), the footer, the per-device sizes (`viewport` shows the phone or tablet
 * overrides, as the Studio's device preview does), auto-advance, and — when the survey has more than one language —
 * the language selector over `localizeDefinition`. The survey-wide custom CSS is not injected here: it is written
 * for a whole page and would restyle these docs (the Custom CSS guide uses scoped UX styles instead).
 */
type Snap = { state: ResponseState; nav: NavigationResult };
const END_TEXT: Record<string, string> = {
  complete: "Thank you — the survey is complete.",
  screened: "Thank you for your time. Unfortunately you do not qualify for this survey (screened out).",
  quota_full: "Thank you — we already have enough responses from people like you (quota full).",
  terminated: "The survey has ended (terminated).",
};

export function LiveSurvey({ def: sourceDef, embedded = {}, viewport }: { def: SurveyDefinition; embedded?: Record<string, string>; viewport?: "mobile" | "tablet" }) {
  const langs = offeredLanguages(sourceDef, true);
  const [lang, setLang] = React.useState<string>(langs[0] ?? "");
  const def = React.useMemo(() => (langs.length > 1 && lang ? localizeDefinition(sourceDef, lang) : sourceDef), [sourceDef, lang, langs.length]);
  const [run, setRun] = React.useState(1);
  const [, setTick] = React.useState(0);
  const force = () => setTick((t) => t + 1);
  const [errors, setErrors] = React.useState<ValidationError[]>([]);
  const history = React.useRef<Snap[]>([]);
  const cur = React.useRef<Snap | null>(null);
  const shellRef = React.useRef<HTMLDivElement | null>(null);

  if (!cur.current || (cur.current as Snap & { run?: number }).run !== run) {
    const state = createResponseState(def, { embedded: { ...embedded }, seed: Math.floor(Math.random() * 2 ** 31) });
    const nav = start(def, state);
    cur.current = Object.assign({ state, nav }, { run });
    history.current = [];
  }
  const { state, nav } = cur.current;
  const restart = () => { setErrors([]); setRun((r) => r + 1); };
  const b = def.branding;
  const shellCls = `rs-shell rs-${b.layout.cardStyle} ${widthModeClass(b)} ${brandingClasses(b, { pageBackground: true })}`;
  const themeId = `docs-${sourceDef.meta.id}`.replace(/["\\]/g, "");
  const wrap = (node: React.ReactElement) => (viewport ? <div className={`rs-viewport ${viewport}`} data-testid="docs-live-viewport">{node}</div> : node);

  if (nav.done) {
    const endNode = findEnd(def, nav.endStatus ?? "complete");
    return (
      <div className="docs-live-done" data-testid="docs-live-end" data-status={nav.endStatus ?? "complete"}>
        {nav.redirectUrl ? (
          <>
            <div className="docs-live-end-title">The respondent is sent to:</div>
            <code className="docs-live-url" data-testid="docs-live-redirect">{nav.redirectUrl}</code>
            <p className="docs-live-note">On a live link the browser goes there now{nav.redirectNewWindow ? " (in a new tab)" : ""}; this preview stops here.</p>
          </>
        ) : (
          <>
            <div className="docs-live-end-title">End of survey — status: <b>{(nav.endStatus ?? "complete").replace(/_/g, " ")}</b></div>
            <p>{endNode?.message?.trim() || END_TEXT[nav.endStatus ?? "complete"]}</p>
          </>
        )}
        <Answers def={def} state={state} />
        <button type="button" className="btn small" onClick={restart} data-testid="docs-live-restart">↺ Restart as a new respondent</button>
      </div>
    );
  }

  const step = nav.steps[nav.stepIndex];
  if (!step || step.kind !== "page") return <p className="muted">This survey has no page to show.</p>;
  const loop = step.loop ?? null;
  const qs = visibleQuestions(def, step, state);
  const ctx = { def, state, loop, quotaCounts: {} };
  const values = Object.fromEntries(qs.map((q) => [q.id, state.answers[answerKey(q.id, loop)]]));
  const pageKey = `${run}:${step.pageId}:${loop ? JSON.stringify((loop as { index?: number }).index ?? "") : ""}`;
  const hasUx = !!def.ux && ((def.ux.styles?.length ?? 0) + (def.ux.behaviors?.length ?? 0) + (def.ux.animations?.length ?? 0)) > 0;

  const next = () => {
    const errs = validatePage(def, qs, ctx).filter((e) => e.severity !== "warning");
    setErrors(errs);
    if (errs.length) return;
    history.current.push({ state: structuredClone(state), nav: structuredClone(nav) });
    const n = advance(def, state, {}, { fromPageId: step.pageId });
    cur.current = Object.assign({ state, nav: n }, { run });
    force();
  };
  const steps = nav.steps;
  const current = steps.filter((x, i) => x.kind === "page" && i <= nav.stepIndex).length;
  const total = Math.max(steps.filter((x) => x.kind === "page").length, 1);
  const progress = <ProgressIndicator position={b.layout.progressBar} style={b.layout.progressStyle} current={current} total={total} testid="docs-live-progress" />;
  /* the last page shows the Submit label, as the runtime does */
  const isLast = current >= total;
  const onAnswered = () => {
    if (!autoNextReady(def, visibleQuestions(def, step, state), (x) => state.answers[answerKey(x.id, loop)])) return;
    const at = nav.stepIndex;
    setTimeout(() => { if (cur.current?.nav.stepIndex === at) next(); }, 450);
  };
  const back = () => {
    const prev = history.current.pop();
    if (!prev) return;
    setErrors([]);
    cur.current = Object.assign(prev, { run });
    force();
  };

  return (
    <div className="docs-live" data-testid="docs-live">
      {langs.length > 1 && (
        <label className="docs-live-lang" data-testid="docs-live-lang-bar">Language{" "}
          <select value={lang} onChange={(e) => { setLang(e.target.value); setErrors([]); setRun((r) => r + 1); }} data-testid="docs-live-lang">
            {langs.map((c) => <option key={c} value={c}>{languageName(c, surveyLanguages(sourceDef).find((l) => l.code === c))}</option>)}
          </select>
        </label>
      )}
      {wrap(
      <div ref={shellRef} className={shellCls} style={{ ...(brandingVars(b) as React.CSSProperties), transform: "translateZ(0)" }} data-rs-ux={def.meta.id} data-rs-page={step.pageId} data-rs-theme={themeId}>
        {b.responsive && <style dangerouslySetInnerHTML={{ __html: brandingResponsiveCss(b, `.rs-shell[data-rs-theme="${themeId}"]`) }} />}
        {(b.logoUrl || b.headerHtml) && (
          <div className={`rs-header ${b.logoPosition}`} data-testid="docs-live-header">
            {/* piped and sanitized exactly as the runtime does it (scripts, handlers and javascript: links removed) */}
            {b.headerHtml ? <div dangerouslySetInnerHTML={{ __html: resolveAuthorHtml(b.headerHtml, ctx) }} /> : b.logoUrl && <SafeImage src={b.logoUrl} alt="logo" imageOnly display={b.logoDisplay} />}
          </div>
        )}
        {b.layout.progressBar === "top" && progress}
        {hasUx && (
          <UxLayer contained def={def} rootRef={shellRef} values={values} allValues={state.answers as Record<string, unknown>} state={state} shown={qs.map((q) => q.id)} pageKey={pageKey}
            pageId={step.pageId} pageIndex={history.current.length + 1} onNavigate={() => ({ ok: false, reason: "not in the docs preview" })} />
        )}
        <div id="rs-questions">
          {qs.map((q: Question) => (
            <QuestionRenderer key={`${pageKey}:${q.id}`} def={def} q={q} state={state} loop={loop} value={values[q.id]}
              errors={errors.filter((e) => e.questionId === q.id)}
              otherValues={otherTextsOf(state, q, loop)}
              onChange={(v) => { setAnswer(def, state, q.id, v, loop); force(); onAnswered(); }}
              onOtherChange={(t, code) => { if (code == null) setOtherText(state, q, t, loop); else setOtherTextFor(state, q, code, t, loop); force(); }}
              onExtraChange={(suffix, v) => {
                const k = `${answerKey(q.id, loop)}__${suffix}`;
                if (v == null || v === "") delete (state.answers as Record<string, unknown>)[k];
                else (state.answers as Record<string, unknown>)[k] = v;
                force();
              }} />
          ))}
          {!qs.length && <p className="muted">Nothing on this page is shown with the answers so far.</p>}
        </div>
        {errors.some((e) => !e.questionId) && <div className="rs-error">{errors.filter((e) => !e.questionId).map((e) => e.message).join(" ")}</div>}
        <div className="rs-nav">
          {b.buttons.showBack && <button type="button" className={`rs-btn secondary ${b.buttons.style}`} onClick={back} disabled={!history.current.length} data-testid="docs-live-back">{b.buttons.backLabel}</button>}
          <button type="button" className={`rs-btn ${b.buttons.style}`} onClick={next} data-testid="docs-live-next">{isLast ? b.buttons.submitLabel : b.buttons.nextLabel}</button>
        </div>
        {b.layout.progressBar === "bottom" && progress}
        {b.footerHtml && <div className="rs-footer" data-testid="docs-live-footer" dangerouslySetInnerHTML={{ __html: resolveAuthorHtml(b.footerHtml, ctx) }} />}
      </div>)}
      <div className="docs-live-foot">
        <Answers def={def} state={state} />
        <button type="button" className="linkish" onClick={restart} data-testid="docs-live-restart">↺ Restart</button>
      </div>
    </div>
  );
}

function findEnd(def: SurveyDefinition, status: string): { message?: string } | null {
  const stack = [...(def.flow as unknown as Record<string, unknown>[])];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.type === "end" && n.status === status) return n as { message?: string };
    for (const k of ["children", "otherwise"]) if (Array.isArray(n[k])) stack.push(...(n[k] as Record<string, unknown>[]));
  }
  return null;
}

/** what is stored so far, by variable name — the data the example produces */
function Answers({ def, state }: { def: SurveyDefinition; state: ResponseState }) {
  const rows: [string, string][] = [];
  for (const [k, v] of Object.entries(state.answers)) {
    if (v === undefined || v === null || v === "") continue;
    const [id, ...rest] = k.split("__");
    const q = def.questions.find((x) => x.id === id.split("@")[0]);
    if (!q) continue;
    const suffix = rest.length ? `_${rest.join("_").replace(/^other_/, "OTHER_").toUpperCase()}` : "";
    const iter = id.includes("@") ? `[${id.split("@")[1]}]` : "";
    rows.push([`${q.variableName}${iter}${suffix}`, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  for (const [k, v] of Object.entries(state.embedded ?? {})) if (v !== undefined && v !== "") rows.push([`ed.${k}`, String(v)]);
  if (!rows.length) return <span className="docs-live-data muted">No answers stored yet.</span>;
  return <span className="docs-live-data" data-testid="docs-live-data">Stored: {rows.map(([k, v]) => <code key={k}>{k} = {v.length > 60 ? `${v.slice(0, 60)}…` : v}</code>)}</span>;
}
