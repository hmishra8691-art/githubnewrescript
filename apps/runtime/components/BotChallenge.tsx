"use client";
import * as React from "react";

/**
 * The bot challenge before the first page (audit P1-08, lib/botChallenge.ts). Cloudflare Turnstile, loaded only
 * when the start route asks for it: a study without the switch, or a runtime without keys, never loads the script.
 */
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = { render(el: HTMLElement, opts: Record<string, unknown>): string; remove?(id: string): void };

function loadScript(): Promise<Turnstile> {
  const w = window as unknown as { turnstile?: Turnstile; __rsTurnstile?: Promise<Turnstile> };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  if (w.__rsTurnstile) return w.__rsTurnstile;
  w.__rsTurnstile = new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT; s.async = true; s.defer = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("the check did not load")));
    s.onerror = () => { w.__rsTurnstile = undefined; reject(new Error("the check could not be loaded")); };
    document.head.appendChild(s);
  });
  return w.__rsTurnstile;
}

export function BotChallenge({ siteKey, message, onToken }: { siteKey: string; message: string; onToken: (token: string) => void }) {
  const box = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let id: string | null = null, gone = false;
    setError(null);
    loadScript().then((t) => {
      if (gone || !box.current) return;
      id = t.render(box.current, {
        sitekey: siteKey,
        callback: (tok: string) => onToken(tok),
        "error-callback": () => setError("The check could not be completed."),
        "expired-callback": () => setError("The check expired."),
      });
    }).catch((e: Error) => setError(`${e.message[0].toUpperCase()}${e.message.slice(1)}.`));
    return () => { gone = true; if (id) (window as unknown as { turnstile?: Turnstile }).turnstile?.remove?.(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, attempt]);
  return (
    <div className="rs-shell"><div className="rs-card rs-end" data-testid="rs-challenge">
      <h2>{message}</h2>
      <div ref={box} style={{ marginTop: 16, minHeight: 70 }} />
      {error && <>
        <p role="alert" className="rs-error-msg">{error}</p>
        <button type="button" className="rs-btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </>}
    </div></div>
  );
}
