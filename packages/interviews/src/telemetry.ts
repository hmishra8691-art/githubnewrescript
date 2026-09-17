/**
 * TECHNICAL SIGNALS — AND THE LANGUAGE THEY ARE ALLOWED TO BE DESCRIBED IN.
 *
 * §17 asks for tab visibility, focus, copy, paste, refresh, network drops,
 * permission states, recording and upload events. It also says, twice, that
 * none of it proves cheating and that a human decides what it means.
 *
 * That second half is not a disclaimer to put at the bottom of a screen — it
 * is a design constraint, and this file is where it is enforced. Every event
 * has a NEUTRAL name and a NEUTRAL sentence, written once, here, and every
 * surface renders that sentence. There is no `suspicious`, no `violation`, no
 * score, and no aggregate that adds unlike things together into a number that
 * looks like a verdict. A reviewer is told "the tab was not visible three
 * times, for 4, 2 and 40 seconds" — which is a fact — and not "integrity
 * risk: high", which is an opinion the data cannot support.
 *
 * The distinction matters commercially as well as ethically: a hiring product
 * that tells a company somebody cheated, on evidence that cannot support it,
 * is a product that gets its customers sued.
 */

export const TELEMETRY_KINDS = [
  /* the session */
  "interview_opened", "consent_given", "interview_started", "interview_completed",
  /* the devices */
  "camera_permission", "microphone_permission", "device_changed",
  "camera_lost", "microphone_lost",
  /* recording */
  "recording_started", "recording_paused", "recording_resumed",
  "recording_stopped", "recording_discarded", "recording_too_short",
  /* the upload */
  "upload_started", "upload_part_failed", "upload_retried",
  "upload_completed", "upload_verified", "upload_failed",
  /* the browser */
  "visibility_hidden", "visibility_visible", "window_blurred", "window_focused",
  "page_reloaded", "network_offline", "network_online",
  "copy", "paste", "fullscreen_exited",
  /* timing */
  "question_shown", "question_answered", "question_skipped",
  /*
   * The stimulus clip and the moment before answering. `answer_started` is the
   * one the brief calls "time before starting a response": the gap between a
   * question being shown (or its clip ending) and the candidate pressing
   * record or beginning to type. Stated as an event so the gap is a
   * subtraction a reviewer can see, not a number the product asserts.
   */
  "prompt_playback_started", "prompt_playback_completed", "prompt_playback_stalled",
  "answer_started", "transcript_unavailable", "live_transcript_unsupported",
] as const;

export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];

export function isTelemetryKind(v: unknown): v is TelemetryKind {
  return typeof v === "string" && (TELEMETRY_KINDS as readonly string[]).includes(v);
}

/**
 * The one sentence each event is described by.
 *
 * Every one of these is a statement about the BROWSER. None of them is a
 * statement about the person.
 */
export const TELEMETRY_SAY: Record<TelemetryKind, string> = {
  interview_opened: "Opened the interview link",
  consent_given: "Agreed to the consent statement",
  interview_started: "Started the interview",
  interview_completed: "Reached the end of the interview",

  camera_permission: "Camera permission",
  microphone_permission: "Microphone permission",
  device_changed: "Changed camera or microphone",
  camera_lost: "The camera stopped sending video",
  microphone_lost: "The microphone stopped sending audio",

  recording_started: "Started recording",
  recording_paused: "Paused recording",
  recording_resumed: "Resumed recording",
  recording_stopped: "Stopped recording",
  recording_discarded: "Discarded a take and recorded again",
  recording_too_short: "A take was shorter than the minimum and was not kept",

  upload_started: "Began uploading an answer",
  upload_part_failed: "Part of an upload did not arrive",
  upload_retried: "Retried an upload",
  upload_completed: "Finished sending an answer",
  upload_verified: "The recording was confirmed in storage",
  upload_failed: "An answer could not be saved",

  visibility_hidden: "The interview tab was not visible",
  visibility_visible: "The interview tab was visible again",
  window_blurred: "The browser window lost focus",
  window_focused: "The browser window regained focus",
  page_reloaded: "The page was reloaded",
  network_offline: "The browser reported no network",
  network_online: "The browser reported the network was back",
  copy: "Text was copied",
  paste: "Text was pasted",
  fullscreen_exited: "Left full screen",

  question_shown: "A question was displayed",
  question_answered: "A question was answered",
  question_skipped: "A question was skipped",
  prompt_playback_started: "The interviewer's question video began playing",
  prompt_playback_completed: "The interviewer's question video played to the end",
  prompt_playback_stalled: "The interviewer's question video paused to buffer",
  answer_started: "Began answering",
  transcript_unavailable: "The audio track for transcription could not be saved",
  live_transcript_unsupported: "This browser does not offer a live transcript",
};

/**
 * Which events a reviewer is shown under "technical signals", as opposed to
 * the ordinary progress record.
 *
 * Being on this list is NOT a claim that an event is suspicious. It is a claim
 * that it describes the environment rather than the interview, and that a
 * person interpreting a recording may want to know it. A candidate answering
 * on a train will produce most of this list.
 */
export const ENVIRONMENT_SIGNALS: readonly TelemetryKind[] = [
  "visibility_hidden", "window_blurred", "page_reloaded",
  "copy", "paste", "fullscreen_exited",
  "network_offline", "camera_lost", "microphone_lost",
];

export const DELIVERY_SIGNALS: readonly TelemetryKind[] = [
  "upload_part_failed", "upload_retried", "upload_failed",
];

export interface TelemetryEvent {
  kind: TelemetryKind;
  detail?: Record<string, unknown>;
  clientAt?: string | null;
  questionId?: string | null;
  responseId?: string | null;
}

export interface SignalCount {
  kind: TelemetryKind;
  label: string;
  count: number;
  /** Total seconds, where the event carries a duration. Null when it does not. */
  totalSeconds: number | null;
}

/**
 * Count the signals, and NOTHING else.
 *
 * There is deliberately no total, no score and no severity. Adding a copy
 * event to a network drop produces a number with no meaning, and the only
 * thing a number with no meaning is good for is being mistaken for a
 * judgement. A reviewer gets counts and durations per kind, in the product's
 * own neutral words, and draws their own conclusion.
 */
export function summariseSignals(
  events: readonly TelemetryEvent[],
  kinds: readonly TelemetryKind[] = ENVIRONMENT_SIGNALS,
): SignalCount[] {
  const wanted = new Set(kinds);
  const by = new Map<TelemetryKind, { count: number; seconds: number; hasSeconds: boolean }>();
  for (const e of events) {
    if (!wanted.has(e.kind)) continue;
    const cur = by.get(e.kind) ?? { count: 0, seconds: 0, hasSeconds: false };
    cur.count++;
    const s = Number((e.detail ?? {}).seconds);
    if (Number.isFinite(s) && s >= 0) { cur.seconds += s; cur.hasSeconds = true; }
    by.set(e.kind, cur);
  }
  return kinds
    .filter((k) => by.has(k))
    .map((k) => {
      const v = by.get(k)!;
      return {
        kind: k, label: TELEMETRY_SAY[k], count: v.count,
        totalSeconds: v.hasSeconds ? Math.round(v.seconds) : null,
      };
    });
}

/**
 * The sentence shown above a list of signals, wherever one is shown.
 *
 * Exported as a constant rather than written into a component, so it cannot
 * be softened in one place and not another, and so a reviewer sees the same
 * caveat in the dashboard, the export and the report.
 */
export const SIGNALS_CAVEAT =
  "These are technical events recorded by the candidate's browser. They are not "
  + "evidence of anything on their own — a notification, a second screen, a poor "
  + "connection and a phone call all produce them. Read them alongside the "
  + "recording, and decide for yourself what they mean.";

/**
 * Permission states, named as the browser names them.
 *
 * `prompt` is kept distinct from `denied` because they need different
 * sentences: one is "we have not asked yet", the other is "they said no", and
 * a candidate shown the wrong one is a candidate who cannot get started.
 */
export type PermissionState = "granted" | "denied" | "prompt" | "unavailable";

export const PERMISSION_SAY: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Blocked in the browser",
  prompt: "Not asked yet",
  unavailable: "No device found",
};

export function permissionAdvice(kind: "camera" | "microphone", state: PermissionState): string | null {
  const thing = kind === "camera" ? "camera" : "microphone";
  switch (state) {
    case "denied":
      return `Your ${thing} is blocked for this site. Open your browser's site settings — usually the icon at the left of the address bar — allow the ${thing}, then reload this page.`;
    case "unavailable":
      return `We could not find a ${thing}. Check that one is connected and not in use by another application, then reload this page.`;
    case "prompt":
      return `Your browser will ask for permission to use your ${thing}. Choose Allow.`;
    default:
      return null;
  }
}
