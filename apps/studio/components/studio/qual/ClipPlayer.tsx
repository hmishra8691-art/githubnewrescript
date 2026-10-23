"use client";
import React from "react";
import { formatTimestamp } from "@rescript/analytics";

/**
 * PLAY ONE EXCERPT'S CLIP (2026-10-22, engine item #17) — Coding, Highlights. Seeks to the clip's start once
 * the media knows its length, plays, and pauses at its end (a timer backs `timeupdate`, which fires only every
 * ~250 ms). With word timings the range is exactly the excerpt's words; otherwise the turn — said under it.
 */
export function ClipPlayer({ clip, testId = "clip-player", onClose }: {
  clip: { url: string; start: number; end: number; id: string; byWords?: boolean; approximate?: boolean };
  testId?: string;
  onClose?: () => void;
}) {
  const ref = React.useRef<HTMLVideoElement | null>(null);
  const [state, setState] = React.useState<"loading" | "playing" | "ended">("loading");
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stopAtEnd = () => { if (el.currentTime >= clip.end - 0.02) { el.pause(); setState("ended"); if (timer) { clearInterval(timer); timer = null; } } };
    const begin = () => {
      el.currentTime = clip.start;
      void el.play().then(() => setState("playing")).catch(() => setState("ended"));
      timer = setInterval(stopAtEnd, 40);
    };
    /* the recording itself ended first (a clip timed at its very end) */
    const ended = () => { setState("ended"); if (timer) { clearInterval(timer); timer = null; } };
    el.addEventListener("timeupdate", stopAtEnd);
    el.addEventListener("ended", ended);
    if (el.readyState >= 1) begin(); else el.addEventListener("loadedmetadata", begin, { once: true });
    return () => { el.removeEventListener("timeupdate", stopAtEnd); el.removeEventListener("ended", ended); el.removeEventListener("loadedmetadata", begin); if (timer) clearInterval(timer); };
  }, [clip]);
  return (
    <div className="card ql-section" data-testid={testId} data-clip-start={clip.start} data-clip-end={clip.end} data-by-words={clip.byWords ? "1" : "0"} data-state={state}>
      <video ref={ref} src={clip.url} controls style={{ width: "100%", maxHeight: 240 }} data-testid={`${testId}-media`} />
      <p className="ql-muted">
        Clip {formatTimestamp(clip.start)}–{formatTimestamp(clip.end)} of {clip.id}:{" "}
        {clip.byWords ? `exactly the quote's words${clip.approximate ? " (some timings re-aligned after a correction — approximate)" : ""}` : "the whole turn the quote is in (this transcript has no word timings)"}.
        {onClose && <> <button type="button" className="btn small" onClick={onClose}>Close</button></>}
      </p>
    </div>
  );
}
