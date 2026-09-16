"use client";
import React from "react";

/**
 * The runtime's last resort.
 *
 * `RunnerBoundary` catches everything inside the interview, which is where
 * almost all of it happens. This catches what is left: a server component on
 * `/t`, `/s` or `/preview` throwing before the Runner is ever mounted — a
 * definition row that will not parse, a version id that resolves to nothing.
 *
 * Without it Next renders its own blank page, which is the same indefinite
 * nothing the boot card used to show. A respondent is told plainly, in a
 * sentence that does not blame them; the detail goes to the console and to
 * Next's own error reporting, not to the screen, because this file cannot
 * know whether it is live or a test link.
 */
export default function RuntimeError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error("[rescript:runtime] page error", error);
  }, [error]);

  return (
    <div className="rs-shell">
      <div className="rs-card rs-end" data-testid="rs-page-error">
        <h2>This survey could not be opened</h2>
        <p style={{ marginTop: 10 }}>
          Please try again. If it keeps happening, the link may be out of date — the person who
          sent it to you can check.
        </p>
        {error.digest && (
          <p style={{ marginTop: 10, fontSize: 12, opacity: .6 }}>Reference: {error.digest}</p>
        )}
        <button type="button" className="rs-btn" style={{ marginTop: 18 }}
          data-testid="rs-page-error-retry" onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
