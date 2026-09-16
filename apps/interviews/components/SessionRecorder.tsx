"use client";
import * as React from "react";
import {
  ROLE_SAY, checkParticipants, describeParticipants, sortParticipants,
  type ParticipantRole,
} from "@rescript/interviews";
import { RecordingUploader, SESSION_ENDPOINTS, pickRecordingMime, pickAudioMime } from "@/lib/uploader";

/**
 * THE INTERVIEWER'S RECORDER.
 *
 * A moderated interview, from the researcher's side: the question on screen,
 * who is in the room, a camera preview, and a recording that uploads to R2
 * while it is still being made.
 *
 * ## Who is in this recording is asked FIRST
 *
 * §7, and the reason the whole participant model exists. The list is settled
 * before the camera starts, not afterwards — a recording that sits unattributed
 * is one somebody transcribes and then has to reconstruct the room from memory.
 * It is also per recording: the same study's next segment may have a different
 * interviewer, and the tick boxes start from this recording's own list rather
 * than from the project's.
 *
 * ## Parts leave while the interview is still happening
 *
 * `RecordingUploader` releases an 8 MiB part as soon as the recorder has
 * produced one. A ninety-minute session is not a file somebody uploads at the
 * end and hopes about; by the time the interviewer presses Stop, almost all of
 * it is already in the bucket, and what remains is one part and a completion.
 *
 * ## Preview and re-record are before the save, not after
 *
 * A take the interviewer is not happy with is discarded locally and never
 * uploaded, so a retake costs nothing and stores nothing. Once Save is pressed
 * the recording is verified against the store — the only thing that may call it
 * saved is a HEAD proving the object is there.
 */

export interface RecorderPerson {
  id: string;
  displayName: string;
  email?: string | null;
  userId?: string | null;
  kind: string;
  derived?: boolean;
}

type Phase = "idle" | "arming" | "ready" | "recording" | "reviewing" | "saving" | "saved" | "failed";

export function SessionRecorder({
  interviewId, projectId, questionId, questionText, people: initialPeople, me,
}: {
  interviewId: string;
  projectId: string;
  questionId: string | null;
  questionText: string;
  people: RecorderPerson[];
  /** the signed-in researcher, pre-ticked because they are the one pressing record */
  me: { userId: string; displayName: string } | null;
}) {
  const [people, setPeople] = React.useState(initialPeople);
  const [selected, setSelected] = React.useState<Record<string, ParticipantRole>>(() => {
    const out: Record<string, ParticipantRole> = {};
    /* the respondent of this interview, and whoever is operating the recorder */
    for (const p of initialPeople) {
      if (p.derived) out[p.id] = "respondent";
      else if (me && p.userId === me.userId) out[p.id] = "interviewer";
    }
    return out;
  });

  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [seconds, setSeconds] = React.useState(0);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [audioOnly, setAudioOnly] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const uploaderRef = React.useRef<RecordingUploader | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const startedAt = React.useRef(0);

  const list = React.useMemo(
    () => Object.entries(selected).map(([personId, role]) => ({ personId, role })),
    [selected],
  );
  const chosen = React.useMemo(
    () => sortParticipants(
      list.map((s) => {
        const p = people.find((x) => x.id === s.personId)!;
        return { id: p.id, displayName: p.displayName, role: s.role };
      }).filter(Boolean),
    ),
    [list, people],
  );
  const { warnings } = React.useMemo(() => checkParticipants(list), [list]);

  /* -------------------------------------------------- the camera */

  const arm = async () => {
    setError(null);
    setPhase("arming");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        audioOnly ? { audio: true } : { audio: true, video: { width: 1280, height: 720 } },
      );
      streamRef.current = stream;
      if (videoRef.current && !audioOnly) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setPhase("ready");
    } catch (e) {
      /*
       * A refused camera is the commonest failure here and it is never the
       * researcher's fault in a way they can act on without being told what to
       * do. So it says what to do.
       */
      setPhase("idle");
      setError(
        (e as Error).name === "NotAllowedError"
          ? "Your browser blocked the camera. Allow it in the address bar, then press Set up again."
          : `The camera could not be opened: ${(e as Error).message}`,
      );
    }
  };

  const release = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  React.useEffect(() => release, []);

  /* ------------------------------------------------- recording */

  const start = () => {
    const stream = streamRef.current;
    if (!stream) return;
    setError(null);
    chunksRef.current = [];
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }

    const mimeType = audioOnly ? pickAudioMime() : pickRecordingMime();
    const rec = new MediaRecorder(stream, { mimeType });
    recorderRef.current = rec;

    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      setPreviewUrl(URL.createObjectURL(blob));
      setPhase("reviewing");
    };

    /*
     * One second per chunk. Small enough that stopping loses almost nothing,
     * large enough that a long session is not thousands of blobs.
     */
    rec.start(1000);
    startedAt.current = Date.now();
    setSeconds(0);
    setPhase("recording");
  };

  React.useEffect(() => {
    if (phase !== "recording") return;
    const id = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const stop = () => recorderRef.current?.stop();

  const retake = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    chunksRef.current = [];
    setSeconds(0);
    setPhase("ready");
  };

  /* ---------------------------------------------------- saving */

  const save = async () => {
    const mimeType = audioOnly ? pickAudioMime() : pickRecordingMime();
    const blob = new Blob(chunksRef.current, { type: mimeType });
    if (!blob.size) { setError("There is nothing recorded to save."); return; }

    setPhase("saving");
    setError(null);

    const uploader = new RecordingUploader({
      endpoints: SESSION_ENDPOINTS,
      beginExtra: {
        interviewId,
        questionId,
        kind: audioOnly ? "session_audio" : "session_video",
        participants: list,
      },
      mimeType,
      estimatedBytes: blob.size,
      onState: (s) => {
        setProgress(s.partsTotal ? { done: s.partsDone ?? 0, total: s.partsTotal } : null);
        if (s.phase === "failed" && s.message) setError(s.message);
      },
    });
    uploaderRef.current = uploader;

    try {
      await uploader.begin();
      uploader.push(blob);
      const out = await uploader.finish(seconds);
      if (out.ok) {
        setPhase("saved");
        release();
      } else {
        setPhase("failed");
        setError(out.error);
      }
    } catch (e) {
      setPhase("failed");
      setError((e as Error).message);
    }
  };

  /* ------------------------------------------------- add a person */

  const addPerson = async (displayName: string, email: string) => {
    const res = await fetch(`/api/projects/${projectId}/people`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, email, kind: "interviewer" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { setError(data.error ?? "That person could not be added."); return; }

    setPeople((prev) => (prev.some((p) => p.id === data.person.id) ? prev : [...prev, data.person]));
    setSelected((prev) => ({ ...prev, [data.person.id]: "interviewer" }));
    setAdding(false);
  };

  const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const busy = phase === "saving";

  return (
    <div className="card" data-testid="session-recorder" data-phase={phase}>
      <h2 style={{ marginTop: 0 }}>Interview question</h2>
      <p style={{ fontSize: 18 }}>{questionText || "No question selected."}</p>

      {/* ---- who is in this recording ---- */}
      <section style={{ marginTop: 20 }}>
        <h3 style={{ marginBottom: 6 }}>People in this recording</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          Tick who is present. This list belongs to this recording — the next one can be different.
        </p>

        <div data-testid="participant-picker">
          {people.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0" }}>
              <input
                type="checkbox"
                data-testid={`pick-${p.id}`}
                disabled={phase === "recording" || busy}
                checked={p.id in selected}
                onChange={(e) => setSelected((prev) => {
                  const next = { ...prev };
                  if (e.target.checked) next[p.id] = p.derived ? "respondent" : "interviewer";
                  else delete next[p.id];
                  return next;
                })}
              />
              <span>{p.displayName}</span>
              {p.id in selected && !p.derived && (
                <select
                  value={selected[p.id]}
                  disabled={phase === "recording" || busy}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [p.id]: e.target.value as ParticipantRole }))}
                >
                  {(["interviewer", "observer", "interpreter", "note_taker"] as ParticipantRole[]).map((r) => (
                    <option key={r} value={r}>{ROLE_SAY[r]}</option>
                  ))}
                </select>
              )}
              {p.derived && <span className="muted small">Respondent</span>}
              {p.userId && <span className="muted small" title="Has a Rescript account">· account</span>}
            </label>
          ))}
        </div>

        {adding ? (
          <AddInterviewer onAdd={addPerson} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" className="btn secondary" disabled={phase === "recording" || busy}
            onClick={() => setAdding(true)} data-testid="add-interviewer">
            + Add interviewer
          </button>
        )}

        {chosen.length > 0 && (
          <p className="muted small" data-testid="participant-summary" style={{ marginTop: 10 }}>
            In this recording: {describeParticipants(chosen)}
          </p>
        )}
        {warnings.map((w) => (
          <p key={w.code} className="note warn" style={{ marginTop: 8 }}>{w.message}</p>
        ))}
      </section>

      {/* ---- the camera ---- */}
      <section style={{ marginTop: 24 }}>
        {!audioOnly && (
          <video
            ref={videoRef} muted playsInline
            style={{ width: "100%", maxWidth: 560, borderRadius: 10, background: "#000" }}
          />
        )}
        {previewUrl && phase === "reviewing" && (
          <div style={{ marginTop: 12 }}>
            <h3>Preview</h3>
            {audioOnly
              ? <audio src={previewUrl} controls data-testid="take-preview" />
              : <video src={previewUrl} controls data-testid="take-preview"
                  style={{ width: "100%", maxWidth: 560, borderRadius: 10 }} />}
          </div>
        )}
      </section>

      {/* ---- the controls ---- */}
      <section style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {phase === "idle" && (
          <>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />
              <span className="small">Audio only</span>
            </label>
            <button type="button" className="btn" onClick={arm} data-testid="arm">Set up camera</button>
          </>
        )}
        {phase === "arming" && <span className="muted">Opening the camera…</span>}
        {phase === "ready" && (
          <button type="button" className="btn" onClick={start} data-testid="start">Start recording</button>
        )}
        {phase === "recording" && (
          <>
            <span data-testid="clock" style={{ fontVariantNumeric: "tabular-nums", fontSize: 20 }}>
              ● {clock}
            </span>
            <button type="button" className="btn danger" onClick={stop} data-testid="stop">Stop recording</button>
          </>
        )}
        {phase === "reviewing" && (
          <>
            <button type="button" className="btn secondary" onClick={retake} data-testid="retake">Re-record</button>
            <button type="button" className="btn" onClick={save} data-testid="save">Save recording</button>
            <span className="muted small">{clock} recorded</span>
          </>
        )}
        {phase === "saving" && (
          <span data-testid="saving">
            Saving…{progress ? ` part ${progress.done} of ${progress.total}` : ""}
          </span>
        )}
        {phase === "saved" && (
          <>
            <strong data-testid="saved">Saved and verified.</strong>
            <button type="button" className="btn secondary" onClick={() => { setPhase("idle"); retake(); }}>
              Record another
            </button>
          </>
        )}
        {phase === "failed" && (
          <button type="button" className="btn" onClick={save} data-testid="retry-save">Try saving again</button>
        )}
      </section>

      {error && <p className="note warn" data-testid="recorder-error" style={{ marginTop: 14 }}>{error}</p>}
    </div>
  );
}

/**
 * Adding somebody who is not on the project yet.
 *
 * The email is optional but strongly wanted: it is what lets the server attach
 * a Rescript account, and what stops the same colleague arriving twice under
 * two spellings of their name. The server answers "already on this project"
 * with the existing person rather than an error, so pressing Add twice selects
 * rather than fails.
 */
function AddInterviewer({
  onAdd, onCancel,
}: { onAdd: (name: string, email: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <div style={{ marginTop: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>
      <label className="small">Interviewer name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} data-testid="new-person-name"
        style={{ display: "block", width: "100%", marginBottom: 8 }} />
      <label className="small">Email (optional — links their Rescript account)</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} data-testid="new-person-email"
        style={{ display: "block", width: "100%", marginBottom: 10 }} />
      <button type="button" className="btn" disabled={!name.trim() || busy} data-testid="new-person-save"
        onClick={async () => { setBusy(true); await onAdd(name.trim(), email.trim()); setBusy(false); }}>
        Add
      </button>
      <button type="button" className="btn secondary" onClick={onCancel} style={{ marginLeft: 8 }}>
        Cancel
      </button>
    </div>
  );
}
