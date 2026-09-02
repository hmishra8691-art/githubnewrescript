"use client";
import React from "react";
import type { SurveyDefinition, Branding } from "@rescript/schema";
import {
  createResponseState,
  compileFlow,
  start,
  advance,
  goBack,
  setAnswer,
  visibleQuestions,
  validatePage,
  resolvePiping,
  runScripts,
  inspect,
  type ResponseState,
  type RuntimeStep,
  type QuotaCounts,
  type InspectorSnapshot,
} from "@rescript/engine";
import { QuestionRenderer } from "./QuestionRenderer";
import { Inspector } from "./Inspector";

export interface RunnerProps {
  definition: SurveyDefinition;
  mode: "live" | "test" | "preview";
  /** server session bootstrap (absent in preview mode) */
  session?: { sessionId: string; seed: number; surveyDbId: string; versionDbId: string };
  quotaCounts?: QuotaCounts;
  urlParams?: Record<string, string>;
}

function brandingVars(b: Branding): React.CSSProperties {
  return {
    "--rs-primary": b.colors.primary,
    "--rs-secondary": b.colors.secondary,
    "--rs-bg": b.colors.background,
    "--rs-surface": b.colors.surface,
    "--rs-text": b.colors.text,
    "--rs-subtle": b.colors.subtleText,
    "--rs-border": b.colors.border,
    "--rs-error": b.colors.error,
    "--rs-font": b.typography.fontFamily,
    "--rs-base-size": b.typography.baseSize,
    "--rs-heading-weight": String(b.typography.headingWeight),
    "--rs-max-width": b.layout.maxWidth,
    "--rs-radius": b.layout.radius,
    "--rs-gap": b.layout.spacing === "compact" ? "12px" : b.layout.spacing === "relaxed" ? "28px" : "20px",
  } as React.CSSProperties;
}

async function persist(mode: string, session: RunnerProps["session"], state: ResponseState, done: boolean) {
  if (!session || mode === "preview") return;
  try {
    await fetch("/api/session/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        status: state.status,
        stepIndex: state.stepIndex,
        answers: state.answers,
        calculated: state.calculated,
        embedded: state.embedded,
        flags: state.flags,
        completed: done,
        surveyDbId: session.surveyDbId,
      }),
    });
  } catch {
    /* offline tolerant — retried on next transition */
  }
}

export function Runner({ definition: def, mode, session, quotaCounts: initialCounts, urlParams }: RunnerProps) {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const stateRef = React.useRef<ResponseState | null>(null);
  const [steps, setSteps] = React.useState<RuntimeStep[]>([]);
  const [errors, setErrors] = React.useState<ReturnType<typeof validatePage>>([]);
  const [ended, setEnded] = React.useState<{ status: string; message?: string; redirectUrl?: string } | null>(null);
  const [logs, setLogs] = React.useState<string[]>([]);
  const [counts] = React.useState<QuotaCounts>(initialCounts ?? {});
  const [device, setDevice] = React.useState<"desktop" | "tablet" | "mobile">("desktop");
  const [epoch, setEpoch] = React.useState(0);
  const showInspector = mode === "test" || mode === "preview";

  /** Restart the test session (req: test links must be repeatable).
   *  Test mode reloads the URL so the server issues a fresh session id;
   *  preview mode just re-seeds locally. */
  const restart = () => {
    if (mode === "test") {
      window.location.reload();
      return;
    }
    setEnded(null);
    setErrors([]);
    setLogs([]);
    setEpoch((e) => e + 1);
  };

  // init once per session epoch
  React.useEffect(() => {
    const state = createResponseState(def, {
      sessionId: session?.sessionId,
      seed: session?.seed,
      embedded: Object.fromEntries(
        def.embeddedData
          .filter((e) => urlParams && e.name in urlParams)
          .map((e) => [e.name, urlParams![e.name]]),
      ),
    });
    // also capture flow-declared url embedded fields
    for (const node of def.flow) {
      if (node.type === "embedded_data") {
        for (const f of node.fields) {
          if (f.source === "url" && urlParams?.[f.name] != null) state.embedded[f.name] = urlParams[f.name];
        }
      }
    }
    stateRef.current = state;
    const r = runScripts(def, state, "on_load");
    setLogs(r.logs);
    const nav = start(def, state, counts);
    setSteps(nav.steps);
    if (nav.done) setEnded({ status: nav.endStatus ?? "complete", redirectUrl: nav.redirectUrl });
    force();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  /**
   * Live preview: the Studio pushes the definition on every edit, so the
   * compiled flow has to be rebuilt — otherwise a newly added page or a
   * changed branch never appears. The respondent's position and answers are
   * kept, and the index is clamped in case the survey got shorter.
   */
  React.useEffect(() => {
    if (mode !== "preview" || !stateRef.current) return;
    const next = compileFlow(def, stateRef.current, counts);
    setSteps(next);
    if (stateRef.current.stepIndex >= next.length) {
      stateRef.current.stepIndex = Math.max(0, next.length - 1);
    }
    force();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def]);

  const state = stateRef.current;
  if (!state) return null;

  const step = steps[state.stepIndex];
  const pageStep = step?.kind === "page" ? step : null;
  const questions = pageStep ? visibleQuestions(def, pageStep, state, counts) : [];
  const ctx = { def, state, loop: pageStep?.loop ?? null, quotaCounts: counts };

  const snap: InspectorSnapshot | null = showInspector ? inspect(def, state, steps, counts) : null;

  const b = def.branding;
  const pageIndexAmongPages = steps.filter((s, i) => s.kind === "page" && i <= state.stepIndex).length;
  const totalPages = Math.max(steps.filter((s) => s.kind === "page").length, 1);
  const progress = ended ? 100 : Math.round((pageIndexAmongPages / (totalPages + 1)) * 100);

  const handleNext = async () => {
    if (!pageStep) return;
    const errs = validatePage(def, questions, ctx);
    const scriptRes = runScripts(def, state, "on_submit", { scopeRef: pageStep.pageId.split("@")[0], loop: pageStep.loop });
    setLogs((l) => [...l, ...scriptRes.logs]);
    const allErrs = [...errs, ...scriptRes.errors.map((e) => ({ questionId: e.questionRef ?? "", message: e.message }))];
    if (allErrs.length > 0) {
      setErrors(allErrs);
      return;
    }
    setErrors([]);
    const nav = advance(def, state, counts);
    setSteps(nav.steps);
    if (nav.done) {
      const endStep = nav.steps[nav.stepIndex];
      setEnded({
        status: nav.endStatus ?? "complete",
        message: endStep?.kind === "end" ? endStep.message : undefined,
        redirectUrl: nav.redirectUrl,
      });
      await persist(mode, session, state, true);
      if (nav.redirectUrl && mode === "live") window.location.href = nav.redirectUrl;
    } else {
      persist(mode, session, state, false);
      window.scrollTo({ top: 0 });
    }
    force();
  };

  const handleBack = () => {
    goBack(def, state, counts);
    setErrors([]);
    force();
    window.scrollTo({ top: 0 });
  };

  const content = ended ? (
    <div className="rs-card rs-end">
      {ended.message ? (
        <h2 dangerouslySetInnerHTML={{ __html: resolvePiping(ended.message, ctx) }} />
      ) : (
        <h2>
          {ended.status === "complete"
            ? "Thank you for completing this survey!"
            : ended.status === "quota_full"
              ? "Unfortunately the group you belong to is already complete."
              : ended.status === "screened"
                ? "Thank you — you do not qualify for this study."
                : "The survey has ended."}
        </h2>
      )}
      {ended.redirectUrl && mode !== "live" && (
        <p style={{ color: "var(--rs-subtle)" }}>(test mode: would redirect to {ended.redirectUrl})</p>
      )}
      {mode !== "live" && (
        <button type="button" className="rs-btn" style={{ marginTop: 18 }} onClick={restart}>
          ↻ Restart test session
        </button>
      )}
    </div>
  ) : !pageStep ? (
    <div className="rs-card rs-end"><h2>Loading…</h2></div>
  ) : (
    <>
      {pageStep.title && (
        <h1 style={{ fontWeight: "var(--rs-heading-weight)" as any, fontSize: "1.3em" }}>
          {resolvePiping(pageStep.title, ctx)}
        </h1>
      )}
      {errors.length > 0 && (
        <div className="rs-error-banner">Please review the highlighted questions below.</div>
      )}
      {questions.map((q) => {
        const key = pageStep.loop ? `${q.id}@${pageStep.loop.code}` : q.id;
        return (
          <QuestionRenderer
            key={key}
            def={def}
            q={q}
            state={state}
            loop={pageStep.loop ?? null}
            value={state.answers[key]}
            otherValue={(state.answers[`${q.id}__other`] as string) ?? ""}
            errors={errors.filter((e) => e.questionId === q.id).map((e) => e.message)}
            onChange={(v) => {
              setAnswer(def, state, q.id, v, pageStep.loop);
              const r = runScripts(def, state, "on_change", { scopeRef: q.id, loop: pageStep.loop });
              if (r.logs.length) setLogs((l) => [...l, ...r.logs]);
              force();
            }}
            onOtherChange={(t) => {
              state.answers[`${q.id}__other`] = t;
              force();
            }}
          />
        );
      })}
      <div className="rs-nav">
        {b.buttons.showBack && state.stepIndex > 0 ? (
          <button type="button" className={`rs-btn secondary ${b.buttons.style}`} onClick={handleBack}>
            {b.buttons.backLabel}
          </button>
        ) : <span />}
        <button type="button" className={`rs-btn ${b.buttons.style}`} onClick={handleNext}>
          {pageIndexAmongPages >= totalPages ? b.buttons.submitLabel : b.buttons.nextLabel}
        </button>
      </div>
    </>
  );

  const shell = (
    <div className={`rs-shell rs-${b.layout.cardStyle}`} style={brandingVars(b)}>
      {b.customCss && <style dangerouslySetInnerHTML={{ __html: b.customCss }} />}
      {(b.logoUrl || b.headerHtml) && (
        <div className={`rs-header ${b.logoPosition}`}>
          {b.headerHtml ? (
            <div dangerouslySetInnerHTML={{ __html: resolvePiping(b.headerHtml, ctx) }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            b.logoUrl && <img src={b.logoUrl} alt="logo" />
          )}
        </div>
      )}
      {b.layout.progressBar !== "none" && !ended && (
        <>
          <div className="rs-progress-track"><div className="rs-progress-fill" style={{ width: `${progress}%` }} /></div>
          {b.layout.progressStyle === "percent" && <div className="rs-progress-label">{progress}%</div>}
        </>
      )}
      {content}
      {b.footerHtml && (
        <div className="rs-footer" dangerouslySetInnerHTML={{ __html: resolvePiping(b.footerHtml, ctx) }} />
      )}
      {mode !== "live" && <div className="rs-testbadge">{mode.toUpperCase()} MODE</div>}
    </div>
  );

  if (showInspector && snap) {
    return (
      <div className="rs-with-inspector">
        <div>
          {/* Mobile testing mode (req §16): constrain the respondent viewport */}
          <div className="rs-devicebar">
            {(["desktop", "tablet", "mobile"] as const).map((d) => (
              <button key={d} className={device === d ? "on" : ""} onClick={() => setDevice(d)}>
                {d === "desktop" ? "🖥 Desktop" : d === "tablet" ? "▭ Tablet" : "📱 Mobile"}
              </button>
            ))}
          </div>
          <div className={device !== "desktop" ? `rs-viewport ${device}` : undefined}>{shell}</div>
        </div>
        <Inspector snap={snap} logs={logs} />
      </div>
    );
  }
  return shell;
}
