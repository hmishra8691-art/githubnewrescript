"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { publishGate } from "@/lib/publishGate";
import type { LaunchResult } from "./CommandContext";

/**
 * PUBLISH (2026-11-15) — one visible button, one dialog, one answer.
 *
 * Publishing existed, but only as a strip that appeared AFTER a survey had gone live and fallen behind, and as
 * "Deploy" inside Versions & Deploy; a survey that had never been published showed no Publish control at all.
 *
 * The two copies of a survey, which this dialog states in words:
 *
 *   DRAFT / TEST   what the editor holds. Every edit is in Preview and in Test Survey at once.
 *   LIVE           the version respondents open. It changes ONLY when Publish is pressed: a version is cut from the
 *                  draft, checked, and the live link is pointed at it. If the check or the deploy fails, the link
 *                  keeps serving the version it had.
 *
 * The dialog checks the survey before anything is saved, publishes through the Studio's own `launch` (the same two
 * steps Intelligent Mode's Launch uses), and on success shows the live link with a Copy button.
 */
export interface PublishDialogProps {
  def: SurveyDefinition;
  /** what the live link serves now, if anything */
  live: { version: string; url: string } | null;
  publish(): Promise<LaunchResult>;
  onClose(): void;
  onOpenChecks(): void;
  /** read-only editor: publishing is a change */
  disabledReason?: string | null;
}

type Stage = { kind: "review" } | { kind: "busy" } | { kind: "done"; url: string; version: string } | { kind: "failed"; error: string; problems: { area: string; message: string }[] };

export function PublishDialog({ def, live, publish, onClose, onOpenChecks, disabledReason }: PublishDialogProps) {
  const [stage, setStage] = React.useState<Stage>({ kind: "review" });
  const [copied, setCopied] = React.useState(false);
  const urlRef = React.useRef<HTMLInputElement>(null);
  const gate = React.useMemo(() => publishGate(def), [def]);
  const busy = stage.kind === "busy";

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const go = async () => {
    setStage({ kind: "busy" });
    try {
      const r = await publish();
      if (r.ok && r.url) setStage({ kind: "done", url: r.url, version: r.version ?? def.meta.version });
      else setStage({ kind: "failed", error: r.error ?? "The survey was not published.", problems: r.problems ?? [] });
    } catch (e) {
      setStage({ kind: "failed", error: e instanceof Error ? e.message : String(e), problems: [] });
    }
  };
  const copy = async () => {
    if (stage.kind !== "done") return;
    let ok = false;
    try { await navigator.clipboard.writeText(stage.url); ok = true; } catch {
      /* no clipboard permission: select the link so Ctrl/⌘ C copies it */
      urlRef.current?.focus(); urlRef.current?.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
    }
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="modal-back" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal pub" role="dialog" aria-modal="true" aria-label="Publish survey" data-testid="publish-dialog" data-stage={stage.kind} onClick={(e) => e.stopPropagation()}>
        {stage.kind === "done" ? (
          <>
            <div className="pub-ok" data-testid="publish-done">
              <span className="pub-ok-mark" aria-hidden="true">✓</span>
              <div>
                <h3>Your survey is live</h3>
                <p className="muted">Version {stage.version} is now what respondents see at this link.</p>
              </div>
            </div>
            <label className="pub-url">
              <span>Live survey link</span>
              <div className="row" style={{ gap: 8 }}>
                <input ref={urlRef} className="input mono grow" readOnly value={stage.url} data-testid="publish-url" onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn primary" data-testid="publish-copy" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
              </div>
            </label>
            <span className="pub-sr" role="status" aria-live="polite">{copied ? "Link copied" : ""}</span>
            <p className="pub-note" data-testid="publish-separation">
              From here on, your edits appear in <strong>Preview</strong> and <strong>Test Survey</strong> only. The live link keeps
              serving version {stage.version} until you press <strong>Publish</strong> again.
            </p>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <a className="btn" href={stage.url} target="_blank" rel="noreferrer" data-testid="publish-open-live">Open live link</a>
              <button type="button" className="btn primary" data-testid="publish-close" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <h3>Publish survey</h3>
            <p className="muted" style={{ marginTop: 2 }}>
              Publishing saves the survey as it is now as a new version and points the live link at it.
            </p>
            <dl className="pub-facts">
              <div><dt>Live now</dt><dd data-testid="publish-live-now">{live ? <>version {live.version} · <a href={live.url} target="_blank" rel="noreferrer">{live.url}</a></> : "Not published yet — respondents cannot open this survey."}</dd></div>
              <div><dt>You are publishing</dt><dd>the draft you are editing ({def.questions.length} question{def.questions.length === 1 ? "" : "s"}){live ? `, replacing version ${live.version} on the same link` : ""}</dd></div>
              <div><dt>Until you publish</dt><dd>edits stay in Preview and Test Survey; {live ? "the live survey does not change" : "nothing is live"}.</dd></div>
            </dl>
            {!gate.ok && stage.kind === "review" && (
              <div className="pub-problems" data-testid="publish-problems" role="alert">
                <strong>This survey cannot go live yet.</strong> {gate.summary}
                <ul>{gate.problems.slice(0, 8).map((p, i) => <li key={i}><span className="save-blocker-area">{p.area}</span> {p.message}</li>)}</ul>
                {gate.problems.length > 8 && <div className="muted">and {gate.problems.length - 8} more</div>}
                <button type="button" className="btn small" data-testid="publish-open-checks" onClick={onOpenChecks}>Open the logic checks</button>
              </div>
            )}
            {stage.kind === "failed" && (
              <div className="pub-problems" data-testid="publish-failed" role="alert">
                <strong>Not published.</strong> {stage.error}
                {stage.problems.length > 0 && <ul>{stage.problems.slice(0, 8).map((p, i) => <li key={i}><span className="save-blocker-area">{p.area}</span> {p.message}</li>)}</ul>}
                <div className="muted">{live ? `The live link is unchanged: it still serves version ${live.version}.` : "Nothing was made live."}</div>
              </div>
            )}
            {disabledReason && <div className="pub-problems" data-testid="publish-readonly">{disabledReason}</div>}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button type="button" className="btn" data-testid="publish-cancel" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" data-testid="publish-confirm" disabled={busy || !gate.ok || !!disabledReason} onClick={go}>
                {busy ? "Publishing…" : stage.kind === "failed" ? "Try again" : live ? "Publish this version" : "Publish survey"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
