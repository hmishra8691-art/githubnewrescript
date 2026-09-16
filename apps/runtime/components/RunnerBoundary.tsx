"use client";
import React from "react";

/**
 * THE RESPONDENT RUNTIME NEVER SHOWS A BLANK SCREEN.
 *
 * Before this existed, `apps/runtime` had no error boundary of any kind. A
 * throw anywhere inside the Runner — a malformed flow node, a definition the
 * schema let through, the flow guard in `moveForward` deciding the graph does
 * not terminate — unmounted the tree and left the respondent on the boot
 * card's "Loading survey…" for ever. The error was in the console, which no
 * respondent reads and no fieldwork team ever sees.
 *
 * That was a masked exception dressed as a loading state, and it is exactly
 * what a runtime must not do. A survey that cannot run has to SAY it cannot
 * run — loudly to whoever is testing it, honestly to whoever is answering it.
 *
 * Two audiences, one boundary:
 *
 *   · test / preview — the programmer. They get the message, the component
 *     stack and a Copy button, because the whole value of a test link is
 *     finding this before fieldwork does.
 *   · live — the respondent. They get a sentence that does not blame them and
 *     a Reload, and nothing about our internals. The diagnostic still reaches
 *     `console.error` and `onFatal`, so the row and the logs keep it.
 *
 * It deliberately does NOT try to recover by re-rendering the same tree with
 * the same inputs: the inputs are what threw. `reset` remounts with a new key
 * only when the caller asks for it.
 */

export type FatalDetail = {
  /** Short, human sentence. Shown to everyone. */
  message: string;
  /** Where it came from — "boot", "render", "navigation". */
  phase: string;
  /** Stack / component stack. Test and preview only. */
  detail?: string;
};

export function fatalOf(e: unknown, phase: string): FatalDetail {
  const err = e instanceof Error ? e : new Error(String(e));
  return { message: err.message || "The survey could not be started.", phase, detail: err.stack };
}

/** The card itself, so the boundary and the Runner's own catch look identical. */
export function FatalCard({
  fatal, diagnostic, onRetry, retryLabel = "Try again",
}: {
  fatal: FatalDetail;
  /** true in test and preview: show the programmer what actually happened */
  diagnostic: boolean;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const text = `${fatal.phase}: ${fatal.message}\n\n${fatal.detail ?? ""}`.trim();

  return (
    <div className="rs-shell">
      <div className="rs-card rs-end" data-testid="rs-fatal" data-phase={fatal.phase}>
        <h2>{diagnostic ? "This survey could not run" : "Something went wrong"}</h2>
        {diagnostic ? (
          <>
            <p data-testid="rs-fatal-message" style={{ marginTop: 10 }}>{fatal.message}</p>
            <p style={{ fontSize: 13, marginTop: 10, opacity: .72 }}>
              The respondent runtime stopped while {phaseWords(fatal.phase)}. Fix the survey
              configuration and open the link again — a live respondent would see a neutral
              message here, not this one.
            </p>
            {fatal.detail && (
              <pre
                data-testid="rs-fatal-detail"
                style={{
                  marginTop: 14, maxHeight: 220, overflow: "auto", textAlign: "left",
                  fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  background: "rgba(0,0,0,.05)", padding: 12, borderRadius: 8,
                }}
              >{fatal.detail}</pre>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "center", flexWrap: "wrap" }}>
              {onRetry && (
                <button type="button" className="rs-btn" data-testid="rs-fatal-retry" onClick={onRetry}>
                  {retryLabel}
                </button>
              )}
              <button
                type="button"
                className="rs-btn secondary"
                data-testid="rs-fatal-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(text).then(
                    () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
                    () => {},
                  );
                }}
              >{copied ? "Copied" : "Copy diagnostic"}</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ marginTop: 10 }}>
              We are sorry — this survey could not be displayed. Nothing you have already answered
              has been lost.
            </p>
            {onRetry && (
              <button type="button" className="rs-btn" style={{ marginTop: 18 }}
                data-testid="rs-fatal-retry" onClick={onRetry}>{retryLabel}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function phaseWords(phase: string): string {
  switch (phase) {
    case "boot": return "starting the interview";
    case "render": return "drawing the page";
    case "navigation": return "moving to the next page";
    case "definition": return "reading the survey definition";
    default: return `in ${phase}`;
  }
}

type Props = {
  children: React.ReactNode;
  /** true in test and preview */
  diagnostic: boolean;
  onFatal?(f: FatalDetail): void;
};

export class RunnerBoundary extends React.Component<Props, { fatal: FatalDetail | null }> {
  constructor(props: Props) {
    super(props);
    this.state = { fatal: null };
  }

  static getDerivedStateFromError(e: unknown) {
    return { fatal: fatalOf(e, "render") };
  }

  componentDidCatch(e: unknown, info: React.ErrorInfo) {
    const fatal = fatalOf(e, "render");
    if (info?.componentStack) fatal.detail = `${fatal.detail ?? ""}\n\nComponent stack:${info.componentStack}`;
    // never swallowed: the console keeps it in every mode, including live
    console.error("[rescript:runtime] fatal", e, info?.componentStack);
    this.setState({ fatal });
    this.props.onFatal?.(fatal);
  }

  render() {
    if (this.state.fatal) {
      return (
        <FatalCard
          fatal={this.state.fatal}
          diagnostic={this.props.diagnostic}
          onRetry={() => window.location.reload()}
          retryLabel="Reload"
        />
      );
    }
    return this.props.children;
  }
}
