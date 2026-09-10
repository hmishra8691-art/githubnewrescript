"use client";
import React from "react";
import type { SurveyDefinition, Branding, Question } from "@rescript/schema";
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
  allEmbeddedFields,
  blockingErrors,
  warnings,
  inspect,
  applyPunches,
  answerKey,
  questionDependencies,
  pendingListFills,
  serverResolvedQuestions,
  dueProbes,
  probeHasFixedPrompt,
  probeSourceText,
  renderFixedProbe,
  probeQuestion,
  recordProbePrompt,
  forgetProbe,
  decideListFill,
  listFillVariables,
  applyListFillDestinations,
  type ResponseState,
  type LoopContext,
  type RuntimeStep,
  type QuotaCounts,
  type InspectorSnapshot,
} from "@rescript/engine";
import { QuestionRenderer } from "@rescript/renderer";
import { Inspector } from "./Inspector";
import { MediaEmbed, SafeImage, spokenText, speechLangFor, useReadAloud, readAloudAvailable } from "@rescript/renderer";
import {
  readResume, writeResume, clearResume, resumeLink,
  cachePending, readPending, clearPending, RESUME_MAX_AGE_DAYS,
} from "@/lib/resume";
import { createTelemetryCollector, type TelemetryCollector } from "@/lib/telemetry";
import type { ResponseTelemetry } from "@rescript/quality";

export interface RunnerProps {
  definition: SurveyDefinition;
  mode: "live" | "test" | "preview";
  /** a session already minted server-side (legacy path; the pages now use sessionBoot) */
  session?: { sessionId: string; seed: number; surveyDbId: string; versionDbId: string; respondentCode?: string | null };
  /**
   * How to obtain the response row: the runner POSTs /api/session/start once
   * it is running, and hands back the session id it kept (localStorage, or a
   * `?r=` resume link — see lib/resume.ts) so the same row is resumed,
   * answers and position restored, instead of a fresh one being written.
   * Absent in preview mode.
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

/**
 * Run any List Fill whose source has just become available (§1, §38).
 *
 * LIVE AND TEST go to the server, which decides with the pinned definition
 * and claims the slot atomically — the client is told the answer, it does not
 * compute one. PREVIEW has no session and no sample, so it runs the identical
 * pure engine in the browser against empty counters: the same code path the
 * builder's simulator uses, which is why a preview and a live respondent with
 * the same answers and the same counters get the same list.
 *
 * Returns the ids of the lists that allocated, so the caller knows the state
 * changed and the flow must be recompiled (a `listFill` loop source expands
 * from the result).
 */
/**
 * AI-DERIVED VARIABLES for the page just answered — same slot as List Fill.
 *
 * Only the calculated questions whose SOURCE is on this page are sent, and
 * only when the source text differs from the last text classified for that
 * question (a respondent who goes back and changes nothing does not cost a
 * second provider call). Results are merged into `state.answers` here, before
 * the flow advances, so the next page's logic can read them; the ordinary
 * save that follows persists them like any other answer.
 *
 * Preview has no session. It still asks — with `sessionId: "preview"` and the
 * definition — and the route answers only if the runtime is on the FAKE
 * provider (dev and the test corpus); against a real provider it is refused,
 * because a real provider must never be reachable without a session. A
 * provider that is unconfigured (501), refused (403), slow, or down changes
 * nothing about the interview: the value stays unset and the respondent moves
 * on. AI must never be the reason a page will not turn.
 */
const lastClassified = new Map<string, string>();
async function runAiResolutions(
  def: SurveyDefinition,
  state: ResponseState,
  pageQuestionIds: string[],
  mode: string,
  session: RunnerProps["session"],
  build: RunnerProps["build"],
  onTrace?: (line: string) => void,
): Promise<string[]> {
  if (mode !== "preview" && !session) return [];
  const onPage = new Set(pageQuestionIds);
  const due = serverResolvedQuestions(def).filter(({ question, source }) => {
    if (!source || !onPage.has(source.id)) return false;
    const raw = state.answers[source.id];
    const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : JSON.stringify(raw);
    if (!text) return false;
    return lastClassified.get(question.id) !== text;
  });
  if (!due.length) return [];
  try {
    const r = await fetch("/api/session/ai", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({
        sessionId: session?.sessionId ?? "preview",
        definition: session ? undefined : def,
        questionIds: due.map((d) => d.question.id),
        answers: state.answers,
        build: build ? { source: build.source, versionId: build.versionId, revision: build.revision } : undefined,
      }),
    });
    if (r.status === 501 || r.status === 403) return []; // not configured, or a preview against a real provider — silently none
    if (!r.ok) { onTrace?.(`[ai] resolution failed (${r.status}); variables left unset`); return []; }
    const j = await r.json().catch(() => ({})) as { answers?: Record<string, string | null> };
    const done: string[] = [];
    for (const { question, source } of due) {
      const v = j.answers?.[question.id];
      if (v === undefined) continue;
      state.answers[question.id] = v as never;
      const raw = state.answers[source!.id];
      lastClassified.set(question.id, typeof raw === "string" ? raw.trim() : JSON.stringify(raw));
      done.push(question.id);
      onTrace?.(`[ai] ${question.code} = ${v === null ? "(unresolved)" : JSON.stringify(v)} from ${source!.code}`);
    }
    return done;
  } catch (e) {
    onTrace?.(`[ai] ${(e as Error).message}; variables left unset`);
    return [];
  }
}

/**
 * THE WORDING OF ONE FOLLOW-UP PROBE. Fixed in the definition → rendered in
 * the browser with `{answer}` and ordinary piping. Not fixed → asked of the
 * provider through `/api/session/probe`. Null means "no probe this time": an
 * unconfigured provider (501), a preview against a real provider (403), a
 * slow or failed call — the interview continues, the follow-up is simply not
 * asked. A probe must never be the reason a page will not turn.
 */
async function probeWording(
  def: SurveyDefinition,
  state: ResponseState,
  q: Question,
  n: number,
  ctx: Parameters<typeof renderFixedProbe>[2],
  mode: string,
  session: RunnerProps["session"],
  build: RunnerProps["build"],
): Promise<string | null> {
  const p = q.probe!;
  const answer = probeSourceText(state.answers[q.id]);
  if (probeHasFixedPrompt(p)) return renderFixedProbe(p, answer, ctx).trim() || null;
  if (mode !== "preview" && !session) return null;
  try {
    const r = await fetch("/api/session/probe", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({
        sessionId: session?.sessionId ?? "preview",
        definition: session ? undefined : def,
        questionId: q.id,
        n,
        answers: state.answers,
        build: build ? { source: build.source, versionId: build.versionId, revision: build.revision } : undefined,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({})) as { prompt?: string | null };
    return typeof j.prompt === "string" && j.prompt.trim() ? j.prompt.trim() : null;
  } catch {
    return null;
  }
}

async function runListFills(
  def: SurveyDefinition,
  state: ResponseState,
  mode: string,
  session: RunnerProps["session"],
  build: RunnerProps["build"],
  onTrace?: (line: string) => void,
): Promise<string[]> {
  const due = pendingListFills(def, state);
  if (!due.length) return [];

  if (mode === "preview" || !session) {
    const ran: string[] = [];
    for (const lf of due) {
      const res = decideListFill({ def, listFill: lf, state });
      Object.assign(state.calculated, listFillVariables(lf, res));
      applyListFillDestinations(lf, res, state);
      ran.push(lf.id);
      onTrace?.(`[list fill] ${res.name}: ${res.trace.reason}`);
    }
    return ran;
  }

  try {
    const r = await fetch("/api/session/listfill", {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({
        sessionId: session.sessionId,
        listFillIds: due.map((lf) => lf.id),
        answers: state.answers, calculated: state.calculated, embedded: state.embedded, flags: state.flags,
        build: build ? { source: build.source, versionId: build.versionId, revision: build.revision } : undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(j.allocations)) {
      // Do NOT allocate locally as a fallback: only the server's claim can
      // honour a cap, and inventing an item here is how two respondents end
      // up sharing the last slot. The list simply has not run yet, and the
      // next page submit will try again.
      onTrace?.(`[list fill] not allocated — ${j.error ?? `server error (${r.status})`}`);
      return [];
    }
    const ran: string[] = [];
    for (const a of j.allocations) {
      const lf = def.listFills.find((x) => x.id === a.listFillId);
      if (!lf) continue;
      Object.assign(state.calculated, a.variables ?? {});
      // the confirmed items are the truth, so the destinations are written
      // from those rather than from anything decided in the browser
      applyListFillDestinations(lf, { listFillId: lf.id, name: a.name, items: a.items ?? [], preference: [], trace: a.trace }, state);
      ran.push(lf.id);
      if (a.trace?.reason) onTrace?.(`[list fill] ${a.name}: ${a.trace.reason}`);
    }
    return ran;
  } catch (e) {
    onTrace?.(`[list fill] not allocated — ${(e as Error).message || "network error"}`);
    return [];
  }
}


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
  /** §24: embedded data from this respondent's row on the invitation list. */
  const respondentEmbeddedRef = React.useRef<Record<string, unknown> | null>(null);
  const [resumed, setResumed] = React.useState(false);
  /** answers that were only in this browser until now */
  const [recovered, setRecovered] = React.useState(false);
  /** the final save's state: pending → saving → saved | failed (with Retry) */
  const [finalSave, setFinalSave] = React.useState<{ kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; error: string }>({ kind: "idle" });
  const booting = !!sessionBoot && !session && !bootError;

  React.useEffect(() => {
    if (!sessionBoot || session) return;
    let cancelled = false;
    /*
     * The pointer now outlives the tab, and can arrive in a link — see
     * lib/resume.ts. It also expires, so a months-old in_progress row is
     * not silently stitched back onto.
     */
    const resume = readResume(sessionBoot.mode, sessionBoot.surveyDbId);
    (async () => {
      try {
        const r = await fetch("/api/session/start", {
          method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
          /*
           * The query string goes with the request so the response row can
           * record which supplier sent this respondent (§23). It is sent once,
           * at session start, because that is the only moment it exists — by
           * page two the parameter is gone and no later request can recover
           * it. The server decides which parameter is the source.
           */
          body: JSON.stringify({ client: sessionBoot.client, study: sessionBoot.study, mode: sessionBoot.mode, token: sessionBoot.token, requestedVersionId: sessionBoot.requestedVersionId ?? null, resume, urlParams: urlParams ?? null }),
        });
        const j = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !j.session) { setBootError(j.error ?? `The survey could not be started (${r.status}).`); return; }
        writeResume(sessionBoot.mode, sessionBoot.surveyDbId, j.session.sessionId);
        if (j.resumed && j.saved) { savedRef.current = j.saved; setResumed(true); }
        /*
         * A page whose save never reached the server. It is newer than
         * anything the server has for this session by definition — the cache
         * is cleared the moment a save is acknowledged — so it is merged over
         * the resumed state rather than under it.
         */
        const pending = readPending(j.session.sessionId);
        if (pending) {
          savedRef.current = {
            answers: { ...(j.saved?.answers ?? {}), ...pending.answers },
            calculated: { ...(j.saved?.calculated ?? {}), ...pending.calculated },
            embedded: { ...(j.saved?.embedded ?? {}), ...pending.embedded },
            flags: (pending.flags ?? j.saved?.flags ?? []) as never[],
            stepIndex: Math.max(pending.stepIndex ?? 0, j.saved?.stepIndex ?? 0),
          };
          setResumed(true);
          setRecovered(true);
        }
        /*
         * §24 — the fields the invitation list carries for this person. Kept
         * in a ref rather than state because the init effect below reads it
         * once, while building the response state, and a second render just
         * to deliver it would re-seed a survey already in progress.
         */
        if (j.respondentEmbedded && typeof j.respondentEmbedded === "object") {
          respondentEmbeddedRef.current = j.respondentEmbedded as Record<string, unknown>;
        }
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
  /** the warning set the respondent has already been shown on this page */
  const ackWarnRef = React.useRef<string | null>(null);
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
  /**
   * THE FOLLOW-UP PROBE BEING SHOWN, if any — an overlay between this page and
   * the next. The flow's step index does not move while it is up; Back
   * returns to the page it belongs to. See engine probe.ts.
   */
  const [probe, setProbe] = React.useState<{ q: Question; n: number; pq: Question } | null>(null);
  /** conversational presentation: which of the page's visible questions is on screen */
  const [convo, setConvo] = React.useState<{ pageId: string; index: number }>({ pageId: "", index: 0 });
  /** probes the provider had no wording for on this page visit — skipped, not retried on every Next */
  const skippedProbesRef = React.useRef<Set<string>>(new Set());
  /** the quality engine's event collector — derived behavioural metadata only */
  const telemetryRef = React.useRef<TelemetryCollector | null>(null);
  const notePage = (allSteps: RuntimeStep[], index: number, via: "start" | "next" | "back" | "reload" | "jump") => {
    const st = allSteps[index];
    if (st?.kind === "page") telemetryRef.current?.enterPage(st.pageId, index, st.questionIds, via);
  };
  const canDebug = mode === "test" || mode === "preview";
  const [debug, setDebug] = React.useState(false);
  const showInspector = canDebug && debug;

  /**
   * THE TESTING TOOLBAR IS A STICKY STACK, AND EVERYTHING BELOW IT NEEDS TO
   * KNOW HOW TALL IT IS.
   *
   * The toolbar sticks under whatever banner the host page puts above it
   * (`--rs-stack-top`, set by the preview page). Its own height then has to
   * reach the inspector — which is sticky too — and the device frames, or the
   * first 45px of each would sit underneath it. Measuring beats hard-coding:
   * the row wraps on a narrow window and the build/position chips come and go.
   */
  const toolbarRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = toolbarRef.current;
    const root = document.documentElement;
    if (!el) { root.style.removeProperty("--rs-toolbar-h"); return; }
    const measure = () => root.style.setProperty("--rs-toolbar-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); root.style.removeProperty("--rs-toolbar-h"); };
    // no dependency list on purpose: the toolbar is not in the tree during the
    // boot render, so a fixed list would leave the height unmeasured for good
  });

  /** Restart the test session (req: test links must be repeatable).
   *  Test mode reloads the URL so the server issues a fresh session id;
   *  preview mode just re-seeds locally. */
  const restart = () => {
    if (mode === "test") {
      // a restart is a NEW attempt: forget the row so the reload mints another
      if (sessionBoot) clearResume(sessionBoot.mode, sessionBoot.surveyDbId);
      window.location.reload();
      return;
    }
    setEnded(null);
    setErrors([]);
    setProbe(null);
    skippedProbesRef.current = new Set();
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
    /*
     * Also capture flow-declared url embedded fields — from ANYWHERE in the
     * flow. This used to walk `def.flow` one level deep, so an embedded-data
     * node inside a block, a branch or a loop never captured its parameter:
     * the field existed, the URL carried the value, and the survey behaved as
     * if the respondent had arrived without it. `allEmbeddedFields` is the
     * engine's own recursive walker, which the piping picker and the variable
     * dictionary already use — so all three now agree on what is declared.
     */
    /*
     * §24 — the invitation list's own fields, applied BEFORE the URL's.
     *
     * A respondent invited by a personal link may arrive with data the client
     * supplied about them: their region, their store, their plan, their
     * language. Only DECLARED fields are taken: an upload can contain any
     * column at all, and letting an arbitrary spreadsheet heading create a
     * variable would mean a typo in a client's file silently inventing one.
     *
     * The URL still wins over this, which is the existing precedence
     * (definition default, then URL) left alone — and it is the right way
     * round for the one case that matters: a link built for a specific
     * respondent that also carries an explicit parameter is a link somebody
     * constructed on purpose.
     */
    if (respondentEmbeddedRef.current) {
      const declared = new Set(allEmbeddedFields(def).map((f) => f.name));
      for (const e of def.embeddedData) declared.add(e.name);
      for (const [k, v] of Object.entries(respondentEmbeddedRef.current)) {
        if (declared.has(k) && v != null && v !== "") state.embedded[k] = v as never;
      }
    }
    for (const f of allEmbeddedFields(def)) {
      if (f.source === "url" && urlParams?.[f.name] != null) state.embedded[f.name] = urlParams[f.name];
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
    /*
     * The resume machinery, for the test suites — the same seam
     * `__rescriptState` and `__rescriptTelemetry` already use, and for the
     * same reason: these are decisions about a respondent's own browser
     * storage, and a test that re-implements them is testing itself. Never
     * exposed in a live interview.
     */
    if (mode !== "live" && typeof window !== "undefined") {
      (window as any).__rescriptResume = {
        readResume, writeResume, clearResume, resumeLink,
        cachePending, readPending, clearPending, RESUME_MAX_AGE_DAYS,
      };
    }
    const r = runScripts(def, state, "on_load");
    setLogs(r.logs);
    /*
     * The survey's own script, from Branding → custom JavaScript. It was
     * stored, edited and never executed. It runs once per session, after
     * on_load scripts, with no arguments — it is page-level glue (a pixel, a
     * class on the shell, a listener), and anything that touches the response
     * belongs in a real script with a ctx.
     */
    if (def.branding.customJs) {
      try {
        // eslint-disable-next-line no-new-func
        new Function(def.branding.customJs)();
      } catch (e) {
        console.error("[rescript:script] survey custom JS", e);
        if (mode !== "live") setLogs((l) => [...l, `[survey JS] ERROR: ${e instanceof Error ? e.message : String(e)}`]);
      }
    }
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
        : recovered
          ? "We have put your answers back — the last page you filled in had not reached us, and it was still on this device."
          : resumed
            ? "Welcome back. Your answers were saved, and you are where you left off."
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
    // a follow-up on screen belongs to the definition that produced it
    setProbe((p) => (p && def.questions.find((q) => q.id === p.q.id)?.probe ? p : null));
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

  /*
   * PRESENTATION MODE (branding.layout.presentation / .voice) — how the same
   * survey is shown. "conversational" walks the page's visible questions one
   * at a time with a cursor, the earlier ones staying above as a transcript;
   * the flow, validation, logic and saves are untouched — a page is still a
   * page, it is just revealed in order. "voice" switches two per-question
   * capabilities on survey-wide: dictation on every text question, and
   * read-aloud of whatever is on screen (VoiceLayer below).
   */
  const layout = def.branding.layout;
  const conversational = layout.presentation === "conversational";
  const voice = layout.voice ?? { readAloud: false, dictation: false };
  const withVoice = (q: Question): Question =>
    voice.dictation && (q.type === "open_text" || q.type === "long_text") && !q.settings.speechInput
      ? { ...q, settings: { ...q.settings, speechInput: true } }
      : q;
  const convoIndex = conversational && pageStep
    ? (convo.pageId === pageStep.pageId ? Math.min(convo.index, Math.max(0, questions.length - 1)) : 0)
    : 0;
  const shownQuestions = conversational ? questions.slice(convoIndex, convoIndex + 1) : questions;
  /** what has been asked so far, for the conversational transcript: earlier pages, then this page's earlier questions */
  const transcript: { q: Question; loop: LoopContext | null; answer: string }[] = conversational && pageStep
    ? [
      ...steps.slice(0, state.stepIndex).flatMap((s) => (s.kind === "page"
        ? visibleQuestions(def, s, state, counts).map((q) => ({ q, loop: s.loop ?? null }))
        : [])),
      ...questions.slice(0, convoIndex).map((q) => ({ q, loop: pageStep.loop ?? null })),
    ]
      .filter(({ q }) => q.type !== "html" && !q.settings.hidden)
      .map(({ q, loop }) => ({ q, loop, answer: resolvePiping(`{{${q.code}}}`, { ...ctx, loop }).trim() }))
    : [];

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
    /*
     * on_validate runs FIRST and on its own: it is the event whose whole
     * purpose is to add errors, and it was the one event `runScripts` was
     * never called with — so every validation script ever written on this
     * platform did nothing. on_submit still runs after it, for the work a
     * page does on the way out.
     */
    const validateRes = runScripts(def, state, "on_validate", { scopeRef: pageStep.pageId.split("@")[0], loop: pageStep.loop });
    const scriptRes = runScripts(def, state, "on_submit", { scopeRef: pageStep.pageId.split("@")[0], loop: pageStep.loop });
    setLogs((l) => [...l, ...validateRes.logs, ...scriptRes.logs]);
    const fromScripts = [...validateRes.errors, ...scriptRes.errors]
      .map((e) => ({ questionId: e.questionRef ?? "", message: e.message }));
    const allErrs = [...errs, ...fromScripts];
    const blocking = blockingErrors(allErrs);
    if (blocking.length > 0) {
      setErrors(allErrs);
      return;
    }
    /*
     * Warnings are shown once and then let go. A soft check exists to make a
     * respondent look again ("that is unusually high — are you sure?"), not
     * to make a legitimate answer impossible, so the first Next surfaces them
     * and the second proceeds. The acknowledgement is keyed to the messages
     * themselves, so changing the answer and re-triggering warns again.
     */
    const soft = warnings(allErrs);
    const softKey = soft.map((w) => `${w.questionId}:${w.message}`).join("|");
    if (soft.length > 0 && ackWarnRef.current !== softKey) {
      ackWarnRef.current = softKey;
      setErrors(soft);
      return;
    }
    ackWarnRef.current = null;
    setErrors([]);
    /*
     * List Fill runs HERE — after the page's answers are valid and before the
     * flow moves. That order matters: the allocation is what a later branch,
     * a repeat block or a destination question depends on, so deciding it
     * after navigation would show the respondent a page built from an item
     * they had not been given yet.
     */
    const allocated = await runListFills(def, state, mode, session, build, (line) => setLogs((l) => [...l, line]));
    if (allocated.length && mode !== "live") {
      console.info("[rescript:listfill] allocated", allocated.map((id) => ({
        id, items: def.listFills.find((lf) => lf.id === id)?.name ?? id,
      })));
    }
    /*
     * AI-derived variables run in the same slot and for the same reason: a
     * classification of this page's open end is what a display rule or quota
     * on the NEXT page may read.
     */
    await runAiResolutions(def, state, pageStep.questionIds, mode, session, build, (line) => setLogs((l) => [...l, line]));
    /*
     * FOLLOW-UP PROBES come last in this slot: the page is valid, the derived
     * variables exist, so a probe's `when` can read them. If one is due, it is
     * shown INSTEAD of moving on; when the respondent answers it (or skips
     * it), `handleProbeNext` asks again and finally calls `leavePage`. The
     * flow has not moved in the meantime.
     */
    if (await showNextProbe()) return;
    await leavePage();
  };

  /**
   * Show the next due follow-up for this page, if there is one with a wording.
   * Returns true when a probe is now on screen.
   */
  const showNextProbe = async (): Promise<boolean> => {
    if (!pageStep) return false;
    for (const { q, n } of dueProbes(questions, ctx)) {
      const key = `${q.id}:${n}`;
      if (skippedProbesRef.current.has(key)) continue;
      const wording = await probeWording(def, state, q, n, ctx, mode, session, build);
      if (!wording) {
        skippedProbesRef.current.add(key);
        if (mode !== "live") setLogs((l) => [...l, `[probe] ${q.code} follow-up ${n}: no wording available — skipped`]);
        continue;
      }
      recordProbePrompt(state, q.id, n, wording);
      if (mode !== "live") setLogs((l) => [...l, `[probe] ${q.code} follow-up ${n}: ${JSON.stringify(wording)}`]);
      setProbe({ q, n, pq: probeQuestion(q, n, wording) });
      setErrors([]);
      force();
      window.scrollTo({ top: 0 });
      return true;
    }
    return false;
  };

  /** Next on a probe screen: validate it, then either the next probe or the page's exit. */
  const handleProbeNext = async () => {
    if (!probe) return;
    const errs = validatePage(def, [probe.pq], ctx);
    if (blockingErrors(errs).length > 0) { setErrors(errs); return; }
    setErrors([]);
    setProbe(null);
    if (await showNextProbe()) return;
    await leavePage();
  };

  /** Back on a probe screen returns to its page; the abandoned follow-up is forgotten. */
  const handleProbeBack = () => {
    if (!probe) return;
    forgetProbe(state, probe.q.id, probe.n);
    setProbe(null);
    setErrors([]);
    force();
    window.scrollTo({ top: 0 });
  };

  /** Leave the current page: telemetry, advance, and everything that follows. */
  const leavePage = async () => {
    if (!pageStep) return;
    skippedProbesRef.current = new Set();
    telemetryRef.current?.leavePage();
    // name the page being left: a List Fill decided just above may have added steps before it
    const nav = advance(def, state, counts, { fromPageId: pageStep.pageId });
    setSteps(nav.steps);
    if (nav.done) {
      /*
       * on_complete: the last event a survey can act on, and the other one
       * that never fired. It runs before the final save, so anything it
       * writes — a computed variable, a flag, a status field — is part of the
       * response that is persisted rather than a change nobody records.
       */
      const completeRes = runScripts(def, state, "on_complete");
      if (completeRes.logs.length) setLogs((l) => [...l, ...completeRes.logs]);
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
      if (sessionBoot) clearResume(sessionBoot.mode, sessionBoot.surveyDbId);
      if (nav.redirectUrl && mode === "live") {
        // "new window" keeps the completion page in place behind the panel's
        // own page — some panels require the survey tab to stay open
        if (nav.redirectNewWindow) window.open(nav.redirectUrl, "_blank", "noopener");
        else window.location.href = nav.redirectUrl;
      }
    } else {
      notePage(nav.steps, nav.stepIndex, "next");
      /*
       * Cache first, then save, then clear.
       *
       * "The next save carries everything" was true only while the tab
       * stayed open: a respondent who lost connection and reloaded lost the
       * page. The cache is written before the attempt and removed when the
       * server acknowledges, so what survives a reload is exactly the work
       * the server has not got.
       */
      if (session && mode !== "preview") {
        cachePending(session.sessionId, {
          answers: state.answers as Record<string, unknown>,
          calculated: state.calculated as Record<string, unknown>,
          embedded: state.embedded as Record<string, unknown>,
          flags: state.flags,
          stepIndex: state.stepIndex,
        });
      }
      void persist(mode, session, state, false, telemetryRef.current?.data ?? null, build).then((o) => {
        if (o.ok) { if (session) clearPending(session.sessionId); return; }
        console.warn("[rescript:save] page save failed — kept locally and replayed on the next save", { session: session?.sessionId.slice(0, 8), error: o.error });
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
    if (out.ok && sessionBoot) {
      clearResume(sessionBoot.mode, sessionBoot.surveyDbId);
      if (session) clearPending(session.sessionId);
    }
    force();
  };

  const handleBack = () => {
    telemetryRef.current?.leavePage();
    const nav = goBack(def, state, counts);
    notePage(nav.steps, nav.stepIndex, "back");
    setErrors([]);
    // conversational: arriving on the previous page from the right means its LAST question
    const prev = nav.steps[nav.stepIndex];
    if (conversational && prev?.kind === "page") setConvo({ pageId: prev.pageId, index: 9999 });
    force();
    window.scrollTo({ top: 0 });
  };

  /** Conversational Next: validate just the question on screen, then the next one, or the page's own Next. */
  const convoNext = async () => {
    if (!pageStep) return;
    const q = questions[convoIndex];
    if (q) {
      const errs = validatePage(def, [q], ctx);
      if (blockingErrors(errs).length > 0) { setErrors(errs); return; }
    }
    if (convoIndex < questions.length - 1) {
      setErrors([]);
      setConvo({ pageId: pageStep.pageId, index: convoIndex + 1 });
      force();
      return;
    }
    await handleNext();
  };
  const convoBack = () => {
    if (!pageStep) return;
    if (convoIndex > 0) { setErrors([]); setConvo({ pageId: pageStep.pageId, index: convoIndex - 1 }); force(); return; }
    handleBack();
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
  ) : probe ? (
    /*
     * A FOLLOW-UP PROBE — one question on its own, rendered by the ordinary
     * QuestionRenderer, stored under the probed question's side key. The
     * step index has not moved: Back returns to the page, Next asks the next
     * probe or leaves the page exactly as the page's own Next would have.
     */
    <>
      {errors.length > 0 && (
        <div className="rs-error-banner" role="status" aria-live="polite">Please review the highlighted question below.</div>
      )}
      <div id="rs-questions" tabIndex={-1} data-testid="rs-probe" data-probe-of={probe.q.id} data-probe-n={probe.n}>
        {voice.readAloud && <VoiceLayer text={spokenText(probe.pq, resolvePiping(probe.pq.text, ctx))} lang={speechLangFor(def, probe.pq)} />}
        <QuestionRenderer
          key={probe.pq.id}
          def={def}
          q={withVoice(probe.pq)}
          state={state}
          loop={null}
          value={state.answers[probe.pq.id]}
          otherValue=""
          errors={errors.filter((e) => e.questionId === probe.pq.id).map((e) => e.message)}
          onChange={(v) => { state.answers[probe.pq.id] = v as never; telemetryRef.current?.answerChanged(probe.q.id); force(); }}
          onOtherChange={() => {}}
        />
      </div>
      <div className="rs-nav">
        {b.buttons.showBack ? (
          <button type="button" data-testid="rs-back" className={`rs-btn secondary ${b.buttons.style}`} onClick={handleProbeBack}>
            {b.buttons.backLabel}
          </button>
        ) : <span />}
        <button type="button" data-testid="rs-next" className={`rs-btn ${b.buttons.style}`} onClick={handleProbeNext}>
          {pageIndexAmongPages >= totalPages ? b.buttons.submitLabel : b.buttons.nextLabel}
        </button>
      </div>
    </>
  ) : (
    <>
      {pageStep.title && pageStep.showTitle && (
        <h1 data-testid="rs-block-title" style={{ fontWeight: "var(--rs-heading-weight)" as any, fontSize: "1.3em" }}>
          {resolvePiping(pageStep.title, ctx)}
        </h1>
      )}
      {pageStep.mediaUrl && (
        <div className="rs-block-media" data-testid="rs-block-media">
          <MediaEmbed url={pageStep.mediaUrl} title={pageStep.title} alt={pageStep.title ?? "Block media"} />
        </div>
      )}
      {errors.length > 0 && (
        <div className="rs-error-banner" role="status" aria-live="polite">
          {blockingErrors(errors).length > 0
            ? "Please review the highlighted questions below."
            : "Please check the highlighted answers — you can continue if they are right."}
        </div>
      )}
      {startNote && (
        <div className="rs-error-banner" data-testid="rs-start-note" style={{ background: "#fff7e6", color: "#7a4b00", borderColor: "#f0c36d" }}>{startNote}</div>
      )}
      {voice.readAloud && !ended && (
        <VoiceLayer
          text={shownQuestions.map((q) => spokenText(q, resolvePiping(q.text, ctx))).join(". ")}
          lang={speechLangFor(def, shownQuestions[0] ?? null)} />
      )}
      {conversational && transcript.length > 0 && (
        <div className="rs-convo-transcript" data-testid="rs-convo-transcript" aria-label="Earlier questions and your answers">
          {transcript.map(({ q, loop, answer }) => (
            <div key={answerKey(q.id, loop)} className="rs-convo-turn" data-testid="rs-convo-turn" data-qid={q.id}>
              <div className="rs-bubble rs-bubble-q" dangerouslySetInnerHTML={{ __html: resolvePiping(q.text, { ...ctx, loop }) }} />
              <div className={`rs-bubble rs-bubble-a${answer ? "" : " empty"}`}>{answer || "(no answer)"}</div>
            </div>
          ))}
        </div>
      )}
      <div id="rs-questions" tabIndex={-1} className={conversational ? "rs-convo-current" : undefined} data-convo-index={conversational ? convoIndex : undefined}>
      {shownQuestions.map((rawQ) => {
        const q = withVoice(rawQ);
        // the full iteration path, so nested loops key separately (see loopKeySuffix)
        const key = answerKey(q.id, pageStep.loop ?? null);
        return (
          <QuestionRenderer
            key={key}
            def={def}
            q={q}
            state={state}
            loop={pageStep.loop ?? null}
            value={state.answers[key]}
            /*
             * "Other, specify" text is PER ITERATION, like the answer it belongs
             * to. This read `${q.id}__other` for every iteration while validation
             * read the loop-scoped key — so the text a respondent typed for Apple
             * showed up again under Google, and the validator could not see it.
             */
            otherValue={(state.answers[`${key}__other`] as string) ?? ""}
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
              state.answers[`${key}__other`] = t;
              force();
            }}
          />
        );
      })}
      </div>
      <div className="rs-nav">
        {b.buttons.showBack && (state.stepIndex > 0 || (conversational && convoIndex > 0)) ? (
          <button type="button" data-testid="rs-back" className={`rs-btn secondary ${b.buttons.style}`} onClick={conversational ? convoBack : handleBack}>
            {b.buttons.backLabel}
          </button>
        ) : <span />}
        <button type="button" data-testid="rs-next" className={`rs-btn ${b.buttons.style}`} onClick={conversational ? convoNext : handleNext}>
          {pageIndexAmongPages >= totalPages && (!conversational || convoIndex >= questions.length - 1) ? b.buttons.submitLabel : b.buttons.nextLabel}
        </button>
      </div>
    </>
  );

  const shell = (
    <div className={`rs-shell rs-${b.layout.cardStyle}`} style={brandingVars(b)}>
      {/*
        * The first tab stop on any page. Without it, a keyboard respondent
        * on page 7 of a grid tabs through the whole toolbar and progress
        * chrome before reaching a question — every time.
        */}
      <a className="rs-skip" href="#rs-questions" data-testid="rs-skip">Skip to the questions</a>
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
    <div className="rs-toolbar" data-testid="runtime-toolbar" ref={toolbarRef}>
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

/**
 * READ-ALOUD BAR — speaks `text` whenever it changes (renderer ReadAloud),
 * with mute and replay. A component rather than a hook in the Runner so the
 * Runner's early returns never change hook order.
 */
function VoiceLayer({ text, lang }: { text: string; lang: string }) {
  const [muted, setMuted] = React.useState(false);
  const ra = useReadAloud(text, lang, !muted);
  const available = readAloudAvailable();
  return (
    <div className="rs-voice-bar" data-testid="rs-voice-bar" data-speaking={ra.speaking ? "1" : "0"} data-muted={muted ? "1" : "0"}>
      <span className="rs-voice-label">{available ? (muted ? "Read-aloud is off" : ra.speaking ? "Reading aloud…" : "Read aloud") : "Read-aloud is not available in this browser"}</span>
      {available && (
        <>
          <button type="button" className="rs-btn-mini" data-testid="rs-voice-replay" onClick={ra.replay} disabled={muted} aria-label="Read the question again">🔊 Replay</button>
          <button type="button" className="rs-btn-mini" data-testid="rs-voice-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>{muted ? "Unmute" : "Mute"}</button>
        </>
      )}
    </div>
  );
}
