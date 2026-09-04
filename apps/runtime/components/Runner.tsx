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
  applyPunches,
  answerKey,
  questionDependencies,
  type ResponseState,
  type RuntimeStep,
  type QuotaCounts,
  type InspectorSnapshot,
} from "@rescript/engine";
import { QuestionRenderer } from "./QuestionRenderer";
import { Inspector } from "./Inspector";
import { MediaEmbed, SafeImage } from "./Media";
import { createTelemetryCollector, type TelemetryCollector } from "@/lib/telemetry";
import type { ResponseTelemetry } from "@rescript/quality";

export interface RunnerProps {
  definition: SurveyDefinition;
  mode: "live" | "test" | "preview";
  /** a session already minted server-side (legacy path; the pages now use sessionBoot) */
  session?: { sessionId: string; seed: number; surveyDbId: string; versionDbId: string; respondentCode?: string | null };
  /**
   * How to obtain the response row: the runner POSTs /api/session/start once
   * it is running, and after a reload hands back the session id it kept in
   * sessionStorage so the same row is resumed (answers and position restored)
   * instead of a fresh one being written. Absent in preview mode.
   */
  sessionBoot?: { client: string; study: string; mode: "test" | "live"; token?: string; requestedVersionId?: string | null; seed?: number; surveyDbId: string; versionDbId: string };
  quotaCounts?: QuotaCounts;
  urlParams?: Record<string, string>;
  /**
   * Test mode: exactly which saved state this is — the version number (or
   * "draft"), the row revision, where it came from. Shown in the toolbar so a
   * tester can tell at a glance whether they are looking at what they just
   * saved, instead of discovering it question by question.
   */
  build?: { source: "requested" | "draft" | "current"; version: string; versionId: string; revision: number | null; draftUpdatedAt?: string | null };
  /**
   * "Preview block": start at this flow node instead of the first page. Same
   * compiled flow, same logic, piping, masking, page breaks and punching —
   * only the entry point moves. `seedAnswers` are answers to earlier questions
   * (keyed by question id) the tester supplied so the block's dependencies
   * behave as they would mid-survey.
   */
  startAt?: string;
  seedAnswers?: Record<string, unknown>;
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

type SaveOutcome = { ok: true; response?: any } | { ok: false; error: string; status?: number } | { ok: true; skipped: true };

/**
 * Save the response state. Every save carries the WHOLE state (answers,
 * position, telemetry), so a lost intermediate save costs nothing once the
 * next one lands — the final save is the one that must land, and it is
 * awaited, retried, and confirmed by the server before the respondent sees
 * the thank-you page (see handleNext). The old code fired a sendBeacon AND a
 * fetch for the completion and awaited neither's result: the engine could run
 * twice, and a failed completion still showed "Thank you".
 */
async function persist(mode: string, session: RunnerProps["session"], state: ResponseState, done: boolean, telemetry?: ResponseTelemetry | null, build?: RunnerProps["build"]): Promise<SaveOutcome> {
  if (!session || mode === "preview") return { ok: true, skipped: true };
  try {
    const body = JSON.stringify({
      sessionId: session.sessionId,
      status: state.status,
      stepIndex: state.stepIndex,
      answers: state.answers,
      calculated: state.calculated,
      embedded: state.embedded,
      flags: state.flags,
      completed: done,
      surveyDbId: session.surveyDbId,
      // behavioural metadata for the quality engine — derived counts and
      // durations only (see lib/telemetry.ts); the server runs the engine on
      // the final save
      telemetry: telemetry ?? undefined,
      // which build this test session is running (draft / requested version /
      // current version), so the server assesses it with the settings the
      // respondent actually ran — a draft-run session is recorded against the
      // draft's base version, whose settings may be older
      build: build ? { source: build.source, versionId: build.versionId, revision: build.revision } : undefined,
    });
    // keepalive lets the completion save outlive a redirect that follows it
    const r = await fetch("/api/session/save", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: done, cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error ?? `save failed (${r.status})`, status: r.status };
    return { ok: true, response: j };
  } catch (e) {
    // offline tolerant for intermediate saves — the next save carries everything
    return { ok: false, error: (e as Error).message || "network error" };
  }
}

/** The final save, retried with backoff: three attempts before the respondent is told. */
async function persistFinal(mode: string, session: RunnerProps["session"], state: ResponseState, telemetry: ResponseTelemetry | null, build: RunnerProps["build"]): Promise<SaveOutcome> {
  let last: SaveOutcome = { ok: false, error: "not attempted" };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await persist(mode, session, state, true, telemetry, build);
    if (last.ok) return last;
    // a 4xx will not change on retry (unknown/finalised session); a network error or 5xx might
    if (last.status && last.status < 500) return last;
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
  }
  return last;
}

const SESSION_KEY = (mode: string, surveyDbId: string) => `rescript:session:${mode}:${surveyDbId}`;

export function Runner({ definition: def, mode, session: initialSession, sessionBoot, quotaCounts: initialCounts, urlParams, build, startAt, seedAnswers }: RunnerProps) {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  /**
   * The response row this run writes to. With `sessionBoot` it is obtained
   * (or resumed) from /api/session/start before the first page renders —
   * the seed drives randomisation, so nothing can be shown until it is
   * known. `saved` holds a resumed row's answers and position.
   */
  const [session, setSession] = React.useState<RunnerProps["session"] | undefined>(initialSession);
  const [bootError, setBootError] = React.useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = React.useState(0);
  const savedRef = React.useRef<{ answers: Record<string, unknown>; calculated: Record<string, unknown>; embedded: Record<string, unknown>; flags: unknown[]; stepIndex: number } | null>(null);
  const [resumed, setResumed] = React.useState(false);
  /** the final save's state: pending → saving → saved | failed (with Retry) */
  const [finalSave, setFinalSave] = React.useState<{ kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; error: string }>({ kind: "idle" });
  const booting = !!sessionBoot && !session && !bootError;

  React.useEffect(() => {
    if (!sessionBoot || session) return;
    let cancelled = false;
    const key = SESSION_KEY(sessionBoot.mode, sessionBoot.surveyDbId);
    let resume: string | null = null;
    try { resume = window.sessionStorage.getItem(key); } catch { /* storage unavailable */ }
    (async () => {
      try {
        const r = await fetch("/api/session/start", {
          method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ client: sessionBoot.client, study: sessionBoot.study, mode: sessionBoot.mode, token: sessionBoot.token, requestedVersionId: sessionBoot.requestedVersionId ?? null, resume }),
        });
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !j.session) { setBootError(j.error ?? `The survey could not be started (${r.status}).`); return; }
        try { window.sessionStorage.setItem(key, j.session.sessionId); } catch { /* ignore */ }
        if (j.resumed && j.saved) { savedRef.current = j.saved; setResumed(true); }
        setSession({ ...j.session, seed: sessionBoot.seed ?? j.session.seed });
      } catch (e) {
        if (!cancelled) setBootError((e as Error).message || "The survey could not be started.");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionBoot, bootAttempt]);
  const stateRef = React.useRef<ResponseState | null>(null);
  const [steps, setSteps] = React.useState<RuntimeStep[]>([]);
  const [errors, setErrors] = React.useState<ReturnType<typeof validatePage>>([]);
  const [ended, setEnded] = React.useState<{ status: string; message?: string; redirectUrl?: string } | null>(null);
  const [logs, setLogs] = React.useState<string[]>([]);
  const [counts] = React.useState<QuotaCounts>(initialCounts ?? {});
  const [device, setDevice] = React.useState<"desktop" | "tablet" | "mobile">("desktop");
  const [epoch, setEpoch] = React.useState(0);
  /**
   * Debug is OPTIONAL and off by default.
   *
   * The inspector used to be pinned open in preview and test, permanently
   * taking a 380px column — which is why testing a survey felt like looking at
   * it through a letterbox rather than seeing what a respondent sees. It is a
   * tool you reach for, so it is now behind a toggle and the survey gets the
   * full page until you ask for it.
   */
  const [startNote, setStartNote] = React.useState<string | null>(null);
  /** the quality engine's event collector — derived behavioural metadata only */
  const telemetryRef = React.useRef<TelemetryCollector | null>(null);
  const notePage = (allSteps: RuntimeStep[], index: number, via: "start" | "next" | "back" | "reload" | "jump") => {
    const st = allSteps[index];
    if (st?.kind === "page") telemetryRef.current?.enterPage(st.pageId, index, st.questionIds, via);
  };
  const canDebug = mode === "test" || mode === "preview";
  const [debug, setDebug] = React.useState(false);
  const showInspector = canDebug && debug;

  /** Restart the test session (req: test links must be repeatable).
   *  Test mode reloads the URL so the server issues a fresh session id;
   *  preview mode just re-seeds locally. */
  const restart = () => {
    if (mode === "test") {
      // a restart is a NEW attempt: forget the row so the reload mints another
      if (sessionBoot) { try { window.sessionStorage.removeItem(SESSION_KEY(sessionBoot.mode, sessionBoot.surveyDbId)); } catch { /* ignore */ } }
      window.location.reload();
      return;
    }
    setEnded(null);
    setErrors([]);
    setLogs([]);
    setEpoch((e) => e + 1);
  };

  // init once per session epoch — and not before the row is known
  React.useEffect(() => {
    if (sessionBoot && !session) return;
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
    // test and preview only: the live state, for the inspector's consumers and
    // the browser suites — the same object, so it is never stale
    if (mode !== "live" && typeof window !== "undefined") (window as any).__rescriptState = state;
    if (seedAnswers) {
      for (const [id, v] of Object.entries(seedAnswers)) {
        if (v === undefined || v === null || v === "") continue;
        state.answers[id] = v as never;
      }
    }
    // event collector: honours the survey's telemetry switches; a preview
    // collects too (so testers can see it in the inspector) but never posts
    telemetryRef.current?.dispose();
    telemetryRef.current = createTelemetryCollector(def.quality?.telemetry, session?.sessionId);
    if (mode !== "live" && typeof window !== "undefined") (window as any).__rescriptTelemetry = telemetryRef.current.data;
    const r = runScripts(def, state, "on_load");
    setLogs(r.logs);
    const nav = start(def, state, counts, startAt ? { startAt } : {});
    /*
     * Resume: the row's answers come back, the flow is recompiled with them
     * (branches depend on answers) and the position is restored, clamped in
     * case the survey got shorter since. Only in_progress rows resume — a
     * finished one starts a new attempt.
     */
    const saved = savedRef.current;
    if (saved) {
      Object.assign(state.answers, saved.answers ?? {});
      Object.assign(state.calculated, saved.calculated ?? {});
      Object.assign(state.embedded, saved.embedded ?? {});
      state.flags = [...(saved.flags as never[] ?? [])];
      const steps2 = compileFlow(def, state, counts);
      state.stepIndex = Math.max(0, Math.min(saved.stepIndex ?? 0, steps2.length - 1));
      nav.steps = steps2;
      savedRef.current = null;
    }
    notePage(nav.steps, state.stepIndex, saved || telemetryRef.current.data.navigation.reloads > 0 ? "reload" : "start");
    setStartNote(
      nav.startAt && !nav.startAt.found
        ? "This block is not reachable with the current test values — its display logic (or an enclosing branch) hides it — so the preview starts at the first page instead."
        : null,
    );
    setSteps(nav.steps);
    if (nav.done) {
      // ended before the first page (quota full, screened by embedded data):
      // still a finished response — record it like any other completion
      setEnded({ status: nav.endStatus ?? "complete", redirectUrl: nav.redirectUrl });
      if (session && mode !== "preview") {
        setFinalSave({ kind: "saving" });
        void persistFinal(mode, session, state, telemetryRef.current?.data ?? null, build).then((out) => {
          setFinalSave(out.ok ? { kind: "saved" } : { kind: "failed", error: out.error });
          force();
        });
      }
    }
    force();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, session]);

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
  if (bootError) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end" data-testid="rs-boot-error">
        <h2>{bootError}</h2>
        <button type="button" className="rs-btn" style={{ marginTop: 18 }} onClick={() => { setBootError(null); setBootAttempt((n) => n + 1); }}>Try again</button>
      </div></div>
    );
  }
  if (booting || !state) {
    return <div className="rs-shell"><div className="rs-card rs-end" data-testid="rs-booting"><h2>Loading survey…</h2></div></div>;
  }

  const step = steps[state.stepIndex];
  const pageStep = step?.kind === "page" ? step : null;
  const questions = pageStep ? visibleQuestions(def, pageStep, state, counts) : [];
  const ctx = { def, state, loop: pageStep?.loop ?? null, quotaCounts: counts };

  const snap: InspectorSnapshot | null = showInspector ? inspect(def, state, steps, counts) : null;

  /**
   * Where the respondent is — "Page 3 of 5".
   *
   * These steps are PAGES, and since a block can hold several of them the
   * label has to say so: "Block 3 of 5" was only ever right while a block and
   * a page were the same thing. The block is named alongside it when there is
   * one, which is the part a programmer is usually looking for.
   */
  const blockSteps = steps.filter((x) => x.kind === "page");
  const blockIndex = pageStep ? blockSteps.indexOf(pageStep) + 1 : 0;
  // a wrapped block names itself in the section path; a single-page block
  // carries its name on the page, which is the same thing said two ways
  // The toolbar is programmer chrome, but it renders in live mode too, so a
  // hidden name must not leak through it to respondents. In test and preview
  // the programmer still sees it, marked as hidden, so they can tell the
  // setting took without opening the inspector.
  const rawBlockName = pageStep?.sectionPath?.[pageStep.sectionPath.length - 1] ?? pageStep?.title;
  const blockName = !rawBlockName
    ? undefined
    : pageStep?.showTitle
      ? rawBlockName
      : mode === "live"
        ? undefined
        : `${rawBlockName} (name hidden from respondents)`;

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
    telemetryRef.current?.leavePage();
    const nav = advance(def, state, counts);
    setSteps(nav.steps);
    if (nav.done) {
      const endStep = nav.steps[nav.stepIndex];
      setEnded({
        status: nav.endStatus ?? "complete",
        message: endStep?.kind === "end" ? endStep.message : undefined,
        redirectUrl: nav.redirectUrl,
      });
      telemetryRef.current?.submitted();
      setFinalSave({ kind: "saving" });
      force();
      const out = await persistFinal(mode, session, state, telemetryRef.current?.data ?? null, build);
      if (!out.ok) {
        console.warn("[rescript:save] completion NOT saved", { session: session?.sessionId.slice(0, 8), error: out.error });
        setFinalSave({ kind: "failed", error: out.error });
        force();
        return;
      }
      setFinalSave({ kind: "saved" });
      if (sessionBoot) { try { window.sessionStorage.removeItem(SESSION_KEY(sessionBoot.mode, sessionBoot.surveyDbId)); } catch { /* ignore */ } }
      if (nav.redirectUrl && mode === "live") {
        // "new window" keeps the completion page in place behind the panel's
        // own page — some panels require the survey tab to stay open
        if (nav.redirectNewWindow) window.open(nav.redirectUrl, "_blank", "noopener");
        else window.location.href = nav.redirectUrl;
      }
    } else {
      notePage(nav.steps, nav.stepIndex, "next");
      void persist(mode, session, state, false, telemetryRef.current?.data ?? null, build).then((o) => {
        if (!o.ok) console.warn("[rescript:save] page save failed — the next save carries everything", { session: session?.sessionId.slice(0, 8), error: o.error });
      });
      window.scrollTo({ top: 0 });
    }
    force();
  };

  /** Retry a failed completion save: same state, same session, same row. */
  const retryFinalSave = async () => {
    if (!state) return;
    setFinalSave({ kind: "saving" });
    force();
    const out = await persistFinal(mode, session, state, telemetryRef.current?.data ?? null, build);
    setFinalSave(out.ok ? { kind: "saved" } : { kind: "failed", error: out.error });
    if (out.ok && sessionBoot) { try { window.sessionStorage.removeItem(SESSION_KEY(sessionBoot.mode, sessionBoot.surveyDbId)); } catch { /* ignore */ } }
    force();
  };

  const handleBack = () => {
    telemetryRef.current?.leavePage();
    const nav = goBack(def, state, counts);
    notePage(nav.steps, nav.stepIndex, "back");
    setErrors([]);
    force();
    window.scrollTo({ top: 0 });
  };

  const content = ended && finalSave.kind === "failed" ? (
    <div className="rs-card rs-end" data-testid="rs-save-failed">
      <h2>Your answers have not been saved yet</h2>
      <p style={{ color: "var(--rs-subtle)" }}>The connection to the server failed ({finalSave.error}). Nothing has been lost — please try again.</p>
      <button type="button" className="rs-btn" style={{ marginTop: 18 }} onClick={retryFinalSave}>Retry saving</button>
    </div>
  ) : ended && finalSave.kind === "saving" ? (
    <div className="rs-card rs-end" data-testid="rs-saving"><h2>Saving your answers…</h2></div>
  ) : ended ? (
    <div className="rs-card rs-end" data-testid="rs-ended" data-saved={finalSave.kind === "saved" || mode === "preview" ? "1" : "0"}>
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
        <p style={{ color: "var(--rs-subtle)" }} data-testid="rs-would-redirect">
          (test mode: would redirect to {ended.redirectUrl})
        </p>
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
      {pageStep.title && pageStep.showTitle && (
        <h1 data-testid="rs-block-title" style={{ fontWeight: "var(--rs-heading-weight)" as any, fontSize: "1.3em" }}>
          {resolvePiping(pageStep.title, ctx)}
        </h1>
      )}
      {pageStep.mediaUrl && (
        <div className="rs-block-media" data-testid="rs-block-media">
          <MediaEmbed url={pageStep.mediaUrl} title={pageStep.title} />
        </div>
      )}
      {errors.length > 0 && (
        <div className="rs-error-banner">Please review the highlighted questions below.</div>
      )}
      {startNote && (
        <div className="rs-error-banner" data-testid="rs-start-note" style={{ background: "#fff7e6", color: "#7a4b00", borderColor: "#f0c36d" }}>{startNote}</div>
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
              telemetryRef.current?.answerChanged(q.id);
              /*
               * Auto punch on the SAME page: "if Q1.A is selected → select
               * Q2.B" with Q1 and Q2 side by side must react as the respondent
               * clicks, not on the next page arrival. Only questions whose punch
               * rules read the question just answered are recomputed, with the
               * same applyPunches the flow interpreter uses on arrival.
               */
              for (const other of questions) {
                if (other.id === q.id || !other.punches?.length) continue;
                if (!questionDependencies(def, other).has(q.id)) continue;
                applyPunches(other, ctx, (qq) => answerKey(qq.id, pageStep.loop ?? null));
              }
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
            b.logoUrl && <SafeImage src={b.logoUrl} alt="logo" imageOnly />
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
      {def.quality?.enabled && def.quality.telemetry?.disclosure && (
        <div className="rs-footer rs-disclosure" data-testid="rs-quality-disclosure">{def.quality.telemetry.disclosure}</div>
      )}
      {mode !== "live" && <div className="rs-testbadge">{mode.toUpperCase()} MODE</div>}
    </div>
  );

  if (!canDebug) return shell;

  /**
   * Preview and test run the REAL runtime — the same engine, flow, validation,
   * logic, quotas and piping a respondent gets. The only additions are this
   * slim toolbar and the optional inspector, so what you test is what ships.
   */
  const toolbar = (
    <div className="rs-toolbar" data-testid="runtime-toolbar">
      <span className="rs-toolbar-mode">{mode.toUpperCase()}</span>
      {build && (
        <span className="rs-toolbar-build" data-testid="test-build"
          title={build.source === "requested"
            ? "The exact version the Studio saved when you clicked Test Survey"
            : build.source === "draft"
              ? `The latest autosaved draft${build.draftUpdatedAt ? ` (saved ${new Date(build.draftUpdatedAt).toLocaleTimeString()})` : ""} — not yet cut as a version`
              : "The survey's current saved version"}>
          {build.version === "draft" ? "draft" : `v${build.version}`}
          {build.revision != null && ` · rev ${build.revision}`}
          {build.source === "draft" && " · autosaved"}
        </span>
      )}
      {blockIndex > 0 && (
        <span className="rs-toolbar-pos" data-testid="block-position">
          {blockName ? `${blockName} · ` : ""}Page {blockIndex} of {Math.max(blockSteps.length, 1)}
        </span>
      )}
      <span className="rs-toolbar-gap" />
      <div className="rs-devicebar">
        {(["desktop", "tablet", "mobile"] as const).map((d) => (
          <button key={d} className={device === d ? "on" : ""} onClick={() => setDevice(d)}
            title={`Preview at ${d} width`} aria-label={`${d} viewport`}>
            {d === "desktop" ? "🖥 Desktop" : d === "tablet" ? "▭ Tablet" : "📱 Mobile"}
          </button>
        ))}
      </div>
      <button className={`rs-debug-toggle ${debug ? "on" : ""}`} data-testid="debug-toggle"
        onClick={() => setDebug((v) => !v)}
        title="Show how the engine is evaluating this page">
        {debug ? "✕ Hide debug" : "🐞 Debug"}
      </button>
    </div>
  );

  const body = (
    <div className={device !== "desktop" ? `rs-viewport ${device}` : undefined}>{shell}</div>
  );

  return (
    <>
      {toolbar}
      {showInspector && snap ? (
        <div className="rs-with-inspector">
          <div>{body}</div>
          <Inspector snap={snap} logs={logs} />
        </div>
      ) : (
        body
      )}
    </>
  );
}
