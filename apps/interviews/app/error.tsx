"use client";

/**
 * THE LAST THING BETWEEN A RENDER THROW AND A WHITE PAGE.
 *
 * There was no error boundary in this application at all, which means every
 * unhandled exception during render — a null dereference on an empty question
 * sequence, a malformed row, a browser API missing on an old phone — showed
 * the respondent a blank screen. A blank screen in the middle of an interview
 * is indistinguishable from a broken link, so they close the tab, and the
 * recording they had already given is never finished.
 *
 * What this offers instead is the only two things that ever help: try again,
 * because most render throws are transient state; and a plain statement that
 * answers already confirmed are safe, because the thing a candidate actually
 * fears at this moment is having to do it all again. That is true — every
 * answer is verified into storage before it is called saved, and reopening
 * the link resumes at the first unanswered question.
 *
 * It deliberately does not show the error text. It is not the respondent's
 * problem, it cannot help them, and it can carry internals.
 */
export default function InterviewError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="wrap">
      <div className="card" data-testid="interview-error">
        <h1>Something went wrong on this page</h1>
        <p>
          Any answer already confirmed as saved is safe. Reopening your interview link takes you
          back to the first question you have not answered yet.
        </p>
        <p className="row" style={{ gap: 10, marginTop: 14 }}>
          <button className="btn" onClick={reset} data-testid="interview-error-retry">Try again</button>
          <a className="btn secondary" href="">Reload the page</a>
        </p>
        <p className="tiny muted" style={{ marginTop: 12 }}>
          If this keeps happening, tell whoever invited you — they can see what failed.
        </p>
      </div>
    </main>
  );
}
