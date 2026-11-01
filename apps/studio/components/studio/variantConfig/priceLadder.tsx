"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { lintPriceLadder, ladderPrices } from "@rescript/engine";
import { registerVariantSettings } from "./registry";

/**
 * S5c (SM-07): the Price Ladder's editor — the ladder's prices (comma-separated, sorted on save), where it starts
 * (middle / lowest / highest / random — random is seeded per respondent), the question shown at each step
 * ({price} is replaced), the two answer labels and the currency. The maximum follows the top price so the
 * numeric bounds always hold the answer (0 = none accepted).
 */
type PL = NonNullable<Question["settings"]["priceLadder"]>;

registerVariantSettings("priceladder", ({ q, patchSettings }) => {
  const pl: PL = q.settings.priceLadder ?? { prices: [] };
  const [text, setText] = React.useState(() => (pl.prices ?? []).join(", "));
  const set = (p: Partial<PL>) => patchSettings({ priceLadder: { ...pl, ...p } });
  const commitPrices = (raw: string) => {
    const prices = [...new Set(raw.split(/[,;\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
    patchSettings({ priceLadder: { ...pl, prices }, minValue: 0, maxValue: prices.length ? prices[prices.length - 1] : undefined });
    setText(prices.join(", "));
  };
  const problems = lintPriceLadder(q).map((m) => m.replace(/^[^:]+:\s*/, ""));
  return (
    <div className="card" style={{ padding: 10 }} data-testid="ladder-editor">
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center" }}>
        <span className="flabel">Prices</span>
        <input className="input" data-testid="ladder-prices" value={text} placeholder="5, 10, 15, 20, 25" onChange={(e) => setText(e.target.value)} onBlur={(e) => commitPrices(e.target.value)} />
        <span className="flabel">Start at</span>
        <select className="input" data-testid="ladder-start" value={pl.start ?? "middle"} onChange={(e) => set({ start: e.target.value as PL["start"] })}>
          <option value="middle">the middle price</option>
          <option value="lowest">the lowest price</option>
          <option value="highest">the highest price</option>
          <option value="random">a random price (seeded per respondent)</option>
        </select>
        <span className="flabel">Question at each step</span>
        <input className="input" data-testid="ladder-prompt" value={pl.prompt ?? ""} placeholder="Would you buy it at {price}?" onChange={(e) => set({ prompt: e.target.value || undefined })} />
        <span className="flabel">Answers</span>
        <span className="row" style={{ gap: 6 }}>
          <input className="input" placeholder="Yes, I would buy it" value={pl.yesLabel ?? ""} onChange={(e) => set({ yesLabel: e.target.value || undefined })} />
          <input className="input" placeholder="No" value={pl.noLabel ?? ""} onChange={(e) => set({ noLabel: e.target.value || undefined })} />
        </span>
        <span className="flabel">Currency</span>
        <input className="input" style={{ width: 70 }} value={pl.currency ?? ""} placeholder="$" onChange={(e) => set({ currency: e.target.value || undefined })} />
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
        Yes moves one price up, No one price down; the ladder stops at the first boundary. The answer is the highest price accepted ({ladderPrices(q).length} prices; 0 = none), the path is GG_{q.code}_PATH. Analyse it with Pricing → Gabor–Granger, ladder.
      </p>
      {problems.length > 0 && <ul className="muted" data-testid="ladder-problems" style={{ fontSize: 12.5, color: "var(--warn, #b45309)", margin: "6px 0 0 16px" }}>{problems.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
});
