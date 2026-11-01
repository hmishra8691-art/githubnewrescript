"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { rng, seedFor } from "./shared";
import { ladderInit, ladderParadataKeys, ladderPathText, ladderPrices, ladderStep, type LadderStart, type LadderState } from "@rescript/engine";

/**
 * S5c item 2 — ADAPTIVE GABOR–GRANGER PRICE LADDER (audit SM-07), renderer key `priceladder`.
 *
 * One price at a time: "Would you buy it at $15?" Yes / No. The step rule is the engine's (`ladderStep`): up after
 * yes, down after no, stop at the first boundary or either end. When the ladder stops, the answer is the highest
 * accepted price (0 = none) and GG_<CODE>_START / GG_<CODE>_PATH go out as paradata. The random start is seeded by
 * the respondent and question, so a redraw never moves it. Coming back to an answered ladder shows the result
 * with "Start again".
 */
export function PriceLadder(p: QRProps) {
  const prices = ladderPrices(p.q);
  const cfg = (p.q.settings as { priceLadder?: { start?: LadderStart; prompt?: string; yesLabel?: string; noLabel?: string; currency?: string } }).priceLadder ?? {};
  const cur = cfg.currency ?? (p.q.settings as { currencySymbol?: string }).currencySymbol ?? "$";
  const code = p.q.code || p.q.id;
  const fresh = React.useCallback(() => ladderInit(prices, cfg.start ?? "middle", rng(seedFor(p, "ladder"))()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prices.join(","), cfg.start, p.state.seed, p.q.id]);
  const answered = typeof p.value === "number";
  const [s, setS] = React.useState<LadderState | null>(() => (answered ? null : fresh()));
  const ro = !!p.q.settings.readOnly;

  if (prices.length < 2) return <div className="rs-empty-hint" data-testid="ladder-empty">This price ladder needs at least two prices.</div>;

  const answer = (yes: boolean) => {
    if (!s || s.done || ro) return;
    const next = ladderStep(s, yes);
    setS(next);
    if (next.done) {
      const k = ladderParadataKeys(code);
      p.onParadata?.(k.start, next.answers[0]?.price ?? 0);
      p.onParadata?.(k.path, ladderPathText(next.answers));
      p.onChange(next.highest);
    }
  };
  const fmt = (n: number) => `${cur}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  if (!s || s.done) {
    const highest = s ? s.highest : Number(p.value);
    return (
      <div className="rs-ladder" data-testid="ladder-done" data-highest={String(highest)}>
        <p className="rs-ladder-result">{highest > 0 ? <>Thank you — highest price you would pay: <strong>{fmt(highest)}</strong></> : "Thank you — none of the prices shown."}</p>
        {!ro && <button type="button" className="rs-btn rs-btn-secondary" data-testid="ladder-restart" onClick={() => { setS(fresh()); p.onChange(null); }}>Start again</button>}
      </div>
    );
  }
  const price = s.prices[s.index];
  return (
    <div className="rs-ladder" data-testid="ladder" data-price={String(price)} data-step={String(s.answers.length + 1)}>
      <p className="rs-ladder-q" aria-live="polite">{(cfg.prompt ?? "Would you buy it at {price}?").replace("{price}", fmt(price))}</p>
      <div className="rs-ladder-actions" role="group" aria-label={`Price ${fmt(price)}`}>
        <button type="button" className="rs-btn" data-testid="ladder-yes" disabled={ro} onClick={() => answer(true)}>{cfg.yesLabel ?? "Yes, I would buy it"}</button>
        <button type="button" className="rs-btn rs-btn-secondary" data-testid="ladder-no" disabled={ro} onClick={() => answer(false)}>{cfg.noLabel ?? "No"}</button>
      </div>
    </div>
  );
}

registerVariantRenderer("priceladder", PriceLadder);
