"use client";
import * as React from "react";
import {
  ANALYSIS_CAVEAT, ROLE_SAY, SIGNALS_CAVEAT, VERDICT_SAY,
  attributeSegment, attributionProgress, describeParticipants, sortParticipants,
  unmappedSpeakers,
  type Participant, type TranscriptSegment,
} from "@rescript/interviews";

/**
 * WHAT A RESEARCHER SEES.
 *
 * Until this existed the product recorded, stored, transcribed and analysed
 * into tables nobody could read. Playback had an API and no caller; transcripts
 * had speaker labels and nowhere to map them; the analysis wrote evidence rows
 * that were never displayed.
 *
 * Three rules shape it.
 *
 * **A signed URL is fetched when somebody presses play, not on render.** It is
 * good for fifteen minutes; minting one per recording on page load would put a
 * dozen live credentials in a page that might sit open on a shared screen.
 *
 * **An unattributed voice is shown as the label.** "Speaker 2" is honest.
 * Putting a name there because there are only two participants would be the
 * product guessing, which §12 forbids and which a reader cannot audit.
 *
 * **Caveats are attached to the thing they qualify**, not to a footer. The
 * analysis caveat sits above the analysis; the telemetry caveat sits above the
 * signals. A caveat somewhere else on the page is a caveat nobody reads.
 */

export interface RecordingView {
  id: string;
  kind: string;
  durationSeconds: number | null;
  createdAt: string;
  questionCode: string | null;
  questionPrompt: string | null;
  participants: Participant[];
  transcript: {
    status: string;
    text: string | null;
    segments: TranscriptSegment[] | null;
    diarized: boolean;
    speakerCount: number | null;
  } | null;
}

export interface EvidenceView {
  requirementCode: string;
  requirementTitle: string;
  verdict: "evidence" | "partial" | "insufficient";
  explanation: string;
  quote: string | null;
  startSeconds: number | null;
  downgraded?: string | null;
}

export function InterviewReview({
  interviewId, recordings: initial, evidence, narrative, signals, canMap,
}: {
  interviewId: string;
  recordings: RecordingView[];
  evidence: EvidenceView[];
  narrative: string | null;
  signals: { kind: string; say: string; count: number }[];
  canMap: boolean;
}) {
  const [recordings, setRecordings] = React.useState(initial);

  return (
    <div>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Recordings</h2>
        {recordings.length === 0 ? (
          <p className="muted">Nothing has been recorded for this interview yet.</p>
        ) : (
          recordings.map((r) => (
            <Recording
              key={r.id} rec={r} canMap={canMap}
              onParticipants={(participants) =>
                setRecordings((prev) => prev.map((x) => (x.id === r.id ? { ...x, participants } : x)))}
            />
          ))
        )}
      </section>

      {(evidence.length > 0 || narrative) && (
        <section className="card" style={{ marginTop: 16 }} data-testid="analysis">
          <h2 style={{ marginTop: 0 }}>What the transcripts cover</h2>
          {/* the caveat, above the thing it qualifies */}
          <p className="note warn" style={{ marginTop: 0 }}>{ANALYSIS_CAVEAT}</p>
          {narrative && <p>{narrative}</p>}
          {evidence.map((e, i) => (
            <div key={i} style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
              <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                <strong>{e.requirementCode}</strong>
                <span>{e.requirementTitle}</span>
                <span className={`pill ${e.verdict === "insufficient" ? "warn" : ""}`}>
                  {VERDICT_SAY[e.verdict]}
                </span>
              </div>
              {e.quote && (
                <blockquote style={{ margin: "8px 0", paddingLeft: 12, borderLeft: "3px solid var(--line)" }}>
                  “{e.quote}”
                  {e.startSeconds != null && (
                    <span className="muted small"> — at {clock(e.startSeconds)}</span>
                  )}
                </blockquote>
              )}
              {e.explanation && <p className="muted small" style={{ margin: 0 }}>{e.explanation}</p>}
              {e.downgraded && (
                /*
                 * The most useful line on the page. A reviewer can tell "the
                 * candidate did not say this" from "the model made something
                 * up", which is the difference between a thin interview and a
                 * provider that needs replacing.
                 */
                <p className="muted small" style={{ margin: "6px 0 0" }}>
                  Downgraded: {e.downgraded}
                </p>
              )}
            </div>
          ))}
        </section>
      )}

      {signals.length > 0 && (
        <section className="card" style={{ marginTop: 16 }} data-testid="signals">
          <h2 style={{ marginTop: 0 }}>Technical signals</h2>
          <p className="note warn" style={{ marginTop: 0 }}>{SIGNALS_CAVEAT}</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {signals.map((s) => (
              <li key={s.kind}>{s.say} — {s.count} time{s.count === 1 ? "" : "s"}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* --------------------------------------------------------- one recording */

function Recording({
  rec, canMap, onParticipants,
}: {
  rec: RecordingView;
  canMap: boolean;
  onParticipants: (p: Participant[]) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  const segments = rec.transcript?.segments ?? [];
  const unmapped = unmappedSpeakers(segments, rec.participants);
  const progress = attributionProgress(segments, rec.participants);

  /*
   * Minted on demand, never on render. Fifteen minutes is generous for one
   * viewing and short enough that the URL is dead before anybody pastes it
   * anywhere — but a page that mints one per recording as it loads leaves a
   * dozen live credentials sitting on whatever screen it is open on.
   */
  const play = async () => {
    if (url) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/media/${rec.id}/url`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) setError(data.error ?? "That recording could not be opened.");
      else setUrl(data.url);
    } finally {
      setLoading(false);
    }
  };

  const map = async (personId: string, speakerLabel: string | null) => {
    const res = await fetch(`/api/media/${rec.id}/speakers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personId, speakerLabel }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { setError(data.error ?? "That mapping could not be saved."); return; }
    onParticipants(data.participants as Participant[]);
  };

  const audioOnly = rec.kind.includes("audio");

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 14 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <strong>{rec.questionCode ?? "Session"}</strong>{" "}
          <span className="muted small">
            {rec.durationSeconds ? clock(rec.durationSeconds) : "—"} ·{" "}
            {describeParticipants(rec.participants)}
          </span>
        </div>
        {!url && (
          <button type="button" className="btn secondary" onClick={play} disabled={loading}
            data-testid={`play-${rec.id}`}>
            {loading ? "Opening…" : audioOnly ? "Listen" : "Watch"}
          </button>
        )}
      </div>

      {rec.questionPrompt && <p className="muted small" style={{ margin: "4px 0" }}>{rec.questionPrompt}</p>}

      {url && (audioOnly
        ? <audio src={url} controls style={{ width: "100%", marginTop: 8 }} />
        : <video src={url} controls style={{ width: "100%", maxWidth: 560, marginTop: 8, borderRadius: 10 }} />)}

      {rec.participants.length > 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {sortParticipants(rec.participants).map((p) => (
            <span key={p.id} style={{ marginRight: 12 }}>
              {p.displayName} · {ROLE_SAY[p.role]}
              {p.speakerLabel ? ` · ${p.speakerLabel}` : ""}
            </span>
          ))}
        </div>
      )}

      {/* ---- transcript ---- */}
      {rec.transcript && (
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide transcript" : "Show transcript"}
          </button>
          {rec.transcript.status !== "completed" && (
            <span className="muted small" style={{ marginLeft: 10 }}>
              {rec.transcript.status === "failed"
                ? "Transcription failed — it will not be retried automatically."
                : "Transcribing…"}
            </span>
          )}
          {progress.total > 0 && (
            <span className="muted small" style={{ marginLeft: 10 }} data-testid="attribution-progress">
              {progress.mapped} of {progress.total} voices named
            </span>
          )}

          {open && (
            <div style={{ marginTop: 10 }}>
              {canMap && unmapped.length > 0 && (
                <div className="note warn" style={{ marginBottom: 10 }}>
                  <strong>Who is who?</strong>
                  {unmapped.map((label) => (
                    <div key={label} className="row" style={{ gap: 8, marginTop: 6, alignItems: "center" }}>
                      <span style={{ minWidth: 90 }}>{label}</span>
                      <select defaultValue="" onChange={(e) => e.target.value && map(e.target.value, label)}>
                        <option value="">— nobody yet —</option>
                        {sortParticipants(rec.participants).map((p) => (
                          <option key={p.id} value={p.id}>{p.displayName}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}

              {segments.length > 0 ? (
                segments.map((s, i) => {
                  const who = attributeSegment(s, rec.participants);
                  return (
                    <p key={i} style={{ margin: "0 0 8px" }}>
                      <span
                        className="muted small"
                        style={{ fontWeight: who.certain ? 600 : 400, fontStyle: who.certain ? "normal" : "italic" }}
                      >
                        {who.label}
                      </span>{" "}
                      <span className="muted small">{clock(s.start)}</span>
                      <br />
                      {s.text}
                    </p>
                  );
                })
              ) : (
                <p style={{ whiteSpace: "pre-wrap" }}>{rec.transcript.text ?? "No transcript yet."}</p>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="note warn" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
