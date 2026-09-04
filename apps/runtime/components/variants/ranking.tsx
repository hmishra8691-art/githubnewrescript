"use client";
import React from "react";
import type { Option } from "@rescript/schema";
import { tournamentStep, type TournamentCode, type TournamentDuel } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { SafeImage, MediaEmbed } from "../Media";
import { useOptions, activate, seedFor, setSide, getSide } from "./shared";
import { useTapOrDrag, DragGhost } from "./dragdrop";

/**
 * Ranking family — two ways to produce the same `rank_order` array of codes
 * that Click-to-Rank produces, so logic, piping, exports and the
 * "rank of <option>" variables are untouched:
 *
 *   tournament   repeated A-vs-B duels, ordered by binary insertion
 *   rankbuckets  numbered slots, filled by drag or tap-then-tap
 *
 * Both default to `settings.rankMode: "top_n"`. With no cap that is exactly
 * "rank everything"; with one it is "rank your top N" — so the completeness
 * rule the engine already has fits both without a new validator.
 */

const plain = (s: string) => s.replace(/<[^>]*>/g, "");
const sameCode = (a: unknown, b: unknown) => String(a) === String(b);

/* ------------------------------------------------ Pairwise / Tournament */
/**
 * Ten items are impossible to rank in one go and trivial to rank two at a
 * time. Each answered duel is one step of a binary insertion sort (the
 * algorithm lives in `@rescript/engine`'s `tournament.ts`, pure and unit
 * tested), which needs ~n·log₂n duels rather than the n²/2 a round robin
 * would ask for, and never shows the same pair twice.
 *
 * The duels are stored beside the answer under `<id>__duels`, exactly like
 * Other-specify text, so leaving the page and coming back resumes rather than
 * restarting. The answer itself is only written once the ranking is settled —
 * a half-sorted list is not a ranking, and `required` should still block.
 */
export function Tournament(p: QRProps) {
  const options = useOptions(p);
  const codes = options.map((o) => o.code);
  const seed = seedFor(p, "tournament");
  const topNSetting = p.q.settings.tournamentTopN;
  const topN = topNSetting != null && topNSetting > 0 ? topNSetting : null;

  const [results, setResults] = React.useState<TournamentDuel[]>(
    () => getSide<TournamentDuel[]>(p, "duels") ?? [],
  );
  const step = tournamentStep({ codes, seed, results, topN });
  const optOf = (c: TournamentCode): Option | undefined => options.find((o) => sameCode(o.code, c));

  // A finished set of duels restored from a previous visit should show up as
  // the answer again, even if the answer itself was cleared meanwhile.
  const rankKey = step.ranking.map(String).join("|");
  React.useEffect(() => {
    if (!step.done || results.length === 0) return;
    const cur = Array.isArray(p.value) ? (p.value as TournamentCode[]).map(String).join("|") : "";
    if (cur !== rankKey) p.onChange(step.ranking);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.done, rankKey]);

  if (codes.length < 2) {
    return (
      <div className="rs-empty-hint" data-testid="tournament-empty">
        A tournament needs at least two items to compare — add options to this question.
      </div>
    );
  }

  const record = (winner: TournamentCode) => {
    if (!step.duel) return;
    const next = [...results.slice(0, step.used), { a: step.duel.a, b: step.duel.b, winner }];
    setResults(next);
    setSide(p, "duels", next);
    const after = tournamentStep({ codes, seed, results: next, topN });
    if (after.done) p.onChange(after.ranking);
  };
  const restart = () => {
    setResults([]);
    setSide(p, "duels", []);
    p.onChange(null);
  };

  const restartBtn = (
    <button type="button" className="rs-tour-restart" data-testid="tournament-restart" onClick={restart}>
      ↺ Start over
    </button>
  );

  if (!step.duel) {
    const goal = topN ? `your top ${step.ranking.length}` : "your ranking";
    return (
      <div className="rs-tour">
        <div className="rs-tour-progress" data-testid="tournament-progress">
          Done — {goal} after {step.used} duel{step.used === 1 ? "" : "s"}
        </div>
        <ol className="rs-tour-final" data-testid="tournament-final">
          {step.ranking.map((c, i) => {
            const o = optOf(c);
            return (
              <li key={String(c)} className="rs-tour-rank" data-code={String(c)}>
                <span className="rs-tour-num">{i + 1}</span>
                <span dangerouslySetInnerHTML={{ __html: o?.label ?? String(c) }} />
              </li>
            );
          })}
        </ol>
        {restartBtn}
      </div>
    );
  }

  const side = (c: TournamentCode, which: "a" | "b") => {
    const o = optOf(c);
    return (
      <button type="button" className={`rs-tour-side ${which}`}
        data-code={String(c)} data-testid={`duel-${which}`}
        onClick={() => record(c)}>
        {o?.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <SafeImage src={o.imageUrl} alt="" draggable={false} />
        )}
        <span className="rs-tour-side-label" dangerouslySetInnerHTML={{ __html: o?.label ?? String(c) }} />
        <span className="rs-tour-pick">Prefer this</span>
      </button>
    );
  };

  const pct = Math.min(100, Math.round(((step.duelNumber - 1) / Math.max(1, step.estimatedDuels)) * 100));
  return (
    <div className="rs-tour">
      <div className="rs-tour-progress" data-testid="tournament-progress">
        Duel {step.duelNumber} of ~{step.estimatedDuels}
        {topN ? ` · finding your top ${Math.min(topN, codes.length)}` : ""}
      </div>
      <div className="rs-tour-bar"><span style={{ width: `${pct}%` }} /></div>
      <p className="rs-tour-ask">Which do you prefer?</p>
      <div className="rs-tour-duel">
        {side(step.duel.a, "a")}
        <span className="rs-tour-or" aria-hidden>vs</span>
        {side(step.duel.b, "b")}
      </div>
      {step.used > 0 && restartBtn}
    </div>
  );
}

/* ------------------------------------------------------------ Bucket Ranking */
/**
 * Numbered slots on the right, the items on the left. Drag an item into a
 * slot, or tap the item and then the slot — and an item already in a slot can
 * be moved, swapped with another slot's occupant, or sent back to the pool.
 *
 * Slots may be left empty mid-answer, so the local slot map is the working
 * state and the stored answer is the occupied slots in order (a partial
 * ranking, exactly like Rank-Top-N leaves). The slot map is derived from the
 * answer whenever the two disagree, which keeps an external change (a reset,
 * a carried-forward list) authoritative without an effect that could loop.
 */
export function RankBuckets(p: QRProps) {
  const options = useOptions(p);
  const answer: TournamentCode[] = Array.isArray(p.value) ? (p.value as TournamentCode[]) : [];
  const n = Math.max(1, Math.min(p.q.settings.maxSelections ?? options.length, Math.max(1, options.length)));

  const [stored, setStored] = React.useState<(TournamentCode | null)[]>([]);
  const [held, setHeld] = React.useState<string | null>(null);

  // drop anything that is no longer an option (list logic, a mask, an edit)
  const cleaned = stored.map((c) => (c != null && options.some((o) => sameCode(o.code, c)) ? c : null));
  const implied = cleaned.filter((c) => c != null).map(String).join(",");
  const slots: (TournamentCode | null)[] =
    cleaned.length === n && implied === answer.map(String).join(",")
      ? cleaned
      : Array.from({ length: n }, (_, i) => answer[i] ?? null);

  const commit = (next: (TournamentCode | null)[]) => {
    setStored(next);
    p.onChange(next.filter((c) => c != null));
  };
  const slotOf = (code: string) => slots.findIndex((c) => c != null && String(c) === code);

  /** Put `code` in slot `i`, swapping with whatever is there. */
  const drop = (code: string, i: number) => {
    const opt = options.find((o) => String(o.code) === code);
    if (!opt) return;
    const from = slotOf(code);
    const occupant = slots[i];
    const next = [...slots];
    if (from >= 0) next[from] = occupant; // swap, so nothing is silently evicted
    next[i] = opt.code;
    commit(next);
  };
  const toPool = (code: string) => {
    const from = slotOf(code);
    if (from < 0) return;
    const next = [...slots];
    next[from] = null;
    commit(next);
  };

  const { drag, dragProps } = useTapOrDrag<string>(
    (code, target) => {
      setHeld(null);
      if (!target) return;
      if (target === "pool") return toPool(code);
      const m = /^slot-(\d+)$/.exec(target);
      if (m) drop(code, Number(m[1]));
    },
    (code) => setHeld((h) => (h === code ? null : code)),
  );

  if (options.length === 0) {
    return <div className="rs-empty-hint" data-testid="rankbuckets-empty">Add options — each one is an item to rank.</div>;
  }

  const pool = options.filter((o) => slotOf(String(o.code)) < 0);
  const filled = slots.filter((c) => c != null).length;
  const heldOpt = options.find((o) => String(o.code) === held);
  const ord = (i: number) => {
    const k = i + 1;
    const suffix = k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] ?? "th";
    return `${k}${suffix}`;
  };

  const chip = (o: Option, inSlot: boolean) => {
    const code = String(o.code);
    return (
      <button type="button" key={code}
        className={`rs-dd-chip ${held === code ? "held" : ""} ${inSlot ? "placed" : ""}`}
        data-code={code} aria-pressed={held === code}
        {...dragProps(code)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={activate(() => setHeld((h) => (h === code ? null : code)))}>
        <span className="rs-dd-grip" aria-hidden>⠿</span>
        <span dangerouslySetInnerHTML={{ __html: o.label }} />
      </button>
    );
  };

  return (
    <div className="rs-dd rs-rb">
      <div className="rs-dd-status" data-testid="rankbuckets-progress">
        {filled} of {n} ranked
        {heldOpt && <span className="rs-dd-hint"> — now pick a slot for “{plain(heldOpt.label)}”</span>}
      </div>
      <div className="rs-rb-cols">
        <div className="rs-dd-pool rs-rb-pool" data-drop="pool" role="group" aria-label="Items to rank"
          onClick={() => { if (held) { toPool(held); setHeld(null); } }}>
          {pool.length === 0
            ? <span className="rs-dd-empty">All items ranked — drop one here to take it back.</span>
            : pool.map((o) => chip(o, false))}
        </div>
        <ol className="rs-rb-slots">
          {slots.map((c, i) => {
            const o = c == null ? undefined : options.find((x) => sameCode(x.code, c));
            return (
              <li key={i}>
                <div className={`rs-rb-slot ${o ? "full" : ""} ${held ? "armed" : ""}`}
                  data-drop={`slot-${i}`} data-slot={i}
                  role="button" tabIndex={0} aria-label={`${ord(i)} place${o ? `: ${plain(o.label)}` : ", empty"}`}
                  onClick={() => { if (held) { drop(held, i); setHeld(null); } }}
                  onKeyDown={activate(() => { if (held) { drop(held, i); setHeld(null); } })}>
                  <span className="rs-rb-num">{ord(i)}</span>
                  {o ? chip(o, true) : <span className="rs-dd-empty">drop an item here</span>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <DragGhost drag={drag}>
        {drag ? plain(options.find((o) => String(o.code) === drag.payload)?.label ?? "") : null}
      </DragGhost>
    </div>
  );
}

registerVariantRenderer("tournament", Tournament);
registerVariantRenderer("rankbuckets", RankBuckets);
