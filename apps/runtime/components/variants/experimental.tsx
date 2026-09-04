"use client";
import React from "react";
import { pickArm, sanitizeHtml } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { SingleSelect } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { SafeImage, MediaEmbed } from "../Media";
import { getSide, rng, seedFor, setSide, useOptions, useRows } from "./shared";

/**
 * Experimental / Behavioral family.
 *
 *   attention    single_select → code, + __passed 1|0
 *   iat          matrix_single → {stimulus: category}, + __rt {stimulus: ms}
 *   experiment   experiment    → the assigned arm's code (A/B, random stimulus)
 *
 * The attention check deliberately has NO special presentation — a trap
 * question a respondent can recognise is not a trap. It renders the ordinary
 * single select and only records whether the answer was one of
 * `settings.expectedCodes`. Terminating on failure is not done here either:
 * Studio writes an ordinary `skipLogic` rule (`notIn` expected →
 * end/terminated) so the flow engine, the logic map and the lint see it like
 * any other termination rather than as a renderer secret.
 */

function useNonLive(): boolean {
  const [v, setV] = React.useState(false);
  React.useEffect(() => {
    setV(typeof window !== "undefined" && !!(window as unknown as { __rescriptState?: unknown }).__rescriptState);
  }, []);
  return v;
}

/* -------------------------------------------------------- attention check */
export function AttentionCheck(p: QRProps) {
  const expected = (p.q.settings.expectedCodes ?? []).map(String);
  const inner: QRProps = {
    ...p,
    onChange: (v: unknown) => {
      setSide(p, "passed", v != null && v !== "" && expected.includes(String(v)) ? 1 : 0);
      p.onChange(v);
    },
  };
  return (
    <div className="rs-attention" data-testid="attention" data-expected={expected.join(",")}>
      <SingleSelect {...inner} />
    </div>
  );
}

/* ------------------------------------------------------------------- IAT */
const FIXATION_MS = 500;
const GAP_MS = 300;

/** "E" / "I" for two categories, number keys beyond that. */
function keyHints(n: number): string[] {
  if (n === 2) return ["E", "I"];
  return Array.from({ length: n }, (_, i) => String(i + 1));
}

export function ReactionTime(p: QRProps) {
  const rows = useRows(p);
  const options = useOptions(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const hints = keyHints(options.length);
  const nonLive = useNonLive();

  const order = React.useMemo(() => {
    const arr = [...rows];
    const r = rng(seedFor(p, "iat"));
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => String(r.code)).join("|"), p.state.seed, p.q.id]);

  const firstUnanswered = order.findIndex((r) => vals[String(r.code)] == null);
  const [idx, setIdx] = React.useState(firstUnanswered < 0 ? order.length : firstUnanswered);
  const [phase, setPhase] = React.useState<"fixation" | "stimulus" | "gap">("fixation");
  const shownAt = React.useRef(0);

  const current = idx < order.length ? order[idx] : null;

  // fixation cross → stimulus. The cross is what makes a reaction time mean
  // anything: without it the respondent's eye is already where the word lands.
  React.useEffect(() => {
    if (!current) return;
    setPhase("fixation");
    const t = setTimeout(() => {
      shownAt.current = Date.now();
      setPhase("stimulus");
    }, FIXATION_MS);
    return () => clearTimeout(t);
  }, [idx, current?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const respond = React.useCallback((code: string | number) => {
    if (!current || phase !== "stimulus") return;
    const ms = Math.max(1, Date.now() - shownAt.current);
    const rc = String(current.code);
    const rts = { ...(getSide<Record<string, number>>(p, "rt") ?? {}), [rc]: ms };
    setSide(p, "rt", rts);
    p.onChange({ ...vals, [rc]: code });
    setPhase("gap");
    setTimeout(() => setIdx((i) => i + 1), GAP_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, phase, vals, p.value]);

  // keyboard is the primary input for a millisecond-timed task; the buttons
  // exist so a touch respondent (and a test) can do the same thing
  React.useEffect(() => {
    if (phase !== "stimulus" || !current) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      const i = hints.indexOf(k);
      if (i < 0 || !options[i]) return;
      e.preventDefault();
      respond(options[i].code);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, current, respond, hints.join(""), options.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows.length === 0 || options.length < 2) {
    return (
      <div className="rs-empty-hint" data-testid="iat-empty">
        A reaction-time block needs <strong>rows</strong> (the stimuli) and at least
        two <strong>options</strong> (the response categories).
      </div>
    );
  }

  const done = order.filter((r) => vals[String(r.code)] != null).length;
  const rts = getSide<Record<string, number>>(p, "rt") ?? {};

  return (
    <div className="rs-iat" data-testid="iat" data-phase={phase}>
      <div className="rs-iat-cats">
        {options.map((o, i) => (
          <button key={String(o.code)} type="button" className="rs-iat-cat" data-code={String(o.code)}
            disabled={!current || phase !== "stimulus"}
            onClick={() => respond(o.code)}>
            <span className="rs-iat-key" aria-hidden>{hints[i]}</span>
            <span dangerouslySetInnerHTML={{ __html: o.label }} />
          </button>
        ))}
      </div>

      <div className="rs-iat-stage" aria-live="polite">
        {!current ? (
          <div className="rs-iat-done" data-testid="iat-done">
            <strong>Block complete ✓</strong>
            <div className="rs-iat-summary">
              {order.map((r) => {
                const rc = String(r.code);
                const o = options.find((x) => String(x.code) === String(vals[rc]));
                return (
                  <span key={rc} className="rs-iat-chip" data-row={rc}>
                    {r.label.replace(/<[^>]*>/g, "")} → {o?.label.replace(/<[^>]*>/g, "") ?? "?"}
                    {nonLive && rts[rc] != null && <em> {rts[rc]}ms</em>}
                  </span>
                );
              })}
            </div>
          </div>
        ) : phase === "fixation" ? (
          <div className="rs-iat-fixation" data-testid="iat-fixation" aria-hidden>+</div>
        ) : (
          <div className="rs-iat-stim" data-testid="iat-stimulus" data-row={String(current.code)}>
            {current.meta?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <SafeImage src={String(current.meta.image)} alt={current.label.replace(/<[^>]*>/g, "")} />
            ) : (
              <span dangerouslySetInnerHTML={{ __html: current.label }} />
            )}
          </div>
        )}
      </div>

      <div className="rs-iat-foot">
        <span data-testid="iat-progress">{done} of {order.length}</span>
        <span className="rs-iat-hint">
          {options.length === 2
            ? "Press E for the left category, I for the right — as fast as you can."
            : `Press ${hints.join(" / ")} for the categories above — as fast as you can.`}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- A/B experiment */


export function ExperimentArm(p: QRProps) {
  const arms = p.q.settings.arms ?? [];
  const assigned = p.value == null || p.value === "" ? null : String(p.value);
  const nonLive = useNonLive();
  const done = React.useRef(false);

  /**
   * Assignment happens ONCE per respondent and is never revisited: the draw
   * is `rng(seedFor(...))`, so the same respondent (same seed, same question)
   * always lands on the same arm, and re-rendering — a validation error, a
   * page redraw, coming Back — cannot silently re-randomise a treatment
   * they have already seen.
   */
  React.useEffect(() => {
    if (done.current) return;
    if (assigned) { done.current = true; return; }
    const arm = pickArm(arms, rng(seedFor(p, "arm"))());
    if (!arm) return;
    done.current = true;
    p.onChange(arm.code);
  });

  const arm = arms.find((a) => String(a.code) === assigned);

  if (arms.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="experiment-empty">
        This experiment has no arms yet — add them (code, label, weight and the
        content each arm shows) in the question editor.
      </div>
    );
  }
  if (!arm) return <div className="rs-experiment" data-testid="experiment">Assigning…</div>;

  const media = arm.mediaUrl?.trim();
  return (
    <div className="rs-experiment" data-testid="experiment" data-arm={String(arm.code)}>
      {nonLive && (
        <div className="rs-experiment-tag" data-testid="experiment-tag">
          Arm: {String(arm.code)} ({arm.label})
        </div>
      )}
      {media && (
        // image, direct video, YouTube or Drive — one resolver decides
        <MediaEmbed className="rs-experiment-media" url={media} title={arm.label} />
      )}
      {arm.html && (
        <div className="rs-experiment-html" data-testid="experiment-html"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(arm.html) }} />
      )}
      {!media && !arm.html && (
        <div className="rs-experiment-bare">{arm.label}</div>
      )}
    </div>
  );
}

registerVariantRenderer("attention", AttentionCheck);
registerVariantRenderer("iat", ReactionTime);
registerVariantRenderer("experiment", ExperimentArm);
// a bare `experiment` question (created from JSON, or with its variant dropped)
// still needs to assign and show an arm
registerVariantRenderer("base:experiment", ExperimentArm);
