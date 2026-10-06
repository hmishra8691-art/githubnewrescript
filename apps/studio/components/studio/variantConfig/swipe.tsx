"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { CARD_FIELD_TYPES, CURRENCIES, type CardField } from "@rescript/engine";
import { registerVariantSettings, type VariantSettingsProps } from "./registry";
import { MediaUrlInput } from "../MediaUrlInput";
import { randomAxes, toggleRandomAxis } from "@/lib/builder/randomAxes";
import { moveItem, optionsForResponse, rankOptions, ranksInStep } from "@/lib/builder/cards";

/**
 * Studio authoring for the swipe family.
 *
 * A four-direction deck is only as clear as its mapping: "up" has to mean
 * something the respondent would guess. Left/right/up/down each pick an
 * option here, and the default follows the option order (first → left,
 * second → right, third → up, fourth → down) so a freshly created deck is
 * already coherent.
 */
const DIRS = [
  { key: "left", label: "Swipe left ←" },
  { key: "right", label: "Swipe right →" },
  { key: "up", label: "Swipe up ↑" },
  { key: "down", label: "Swipe down ↓" },
] as const;

function Directions({ q, patch, patchSettings }: VariantSettingsProps) {
  const map = q.settings.swipeDirections ?? {};
  const plain = (s: string) => s.replace(/<[^>]*>/g, "");
  /* the label a direction shows IS its option's label — edit it here, in place */
  const target = (key: string, i: number) => {
    const code = map[key as keyof typeof map];
    return code != null ? q.options.findIndex((o) => String(o.code) === String(code)) : i < q.options.length ? i : -1;
  };
  return (
    <div data-testid="swipe4-directions">
      <h3 className="sec">Directions</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {DIRS.map((d, i) => {
          const fallback = q.options[i];
          const current = map[d.key];
          return (
            <label key={d.key} className="f" style={{ marginBottom: 0, width: 165 }}>
              <span>{d.label}</span>
              <select className="select"
                data-testid={`swipe4-dir-${d.key}`}
                value={current == null ? "" : String(current)}
                onChange={(e) =>
                  patchSettings({
                    swipeDirections: {
                      ...map,
                      [d.key]: e.target.value === "" ? undefined : e.target.value,
                    },
                  })
                }>
                <option value="">
                  {fallback ? `default — ${plain(fallback.label)}` : "— none —"}
                </option>
                {q.options.map((o) => (
                  <option key={String(o.code)} value={String(o.code)}>{plain(o.label)}</option>
                ))}
              </select>
              {target(d.key, i) >= 0 && (
                <input className="input" style={{ marginTop: 4 }} data-testid={`swipe4-label-${d.key}`}
                  aria-label={`${d.label} label`} value={plain(q.options[target(d.key, i)].label)}
                  onChange={(e) => {
                    const at = target(d.key, i);
                    patch({ options: q.options.map((o, k) => (k === at ? { ...o, label: e.target.value } : o)) });
                  }} />
              )}
            </label>
          );
        })}
      </div>
      {q.options.length > 4 && (
        <div className="chip warn" data-testid="swipe4-too-many">
          A card has four directions — this question has {q.options.length} options, so the
          ones not mapped above can never be chosen.
        </div>
      )}
    </div>
  );
}

/**
 * SWIPE CARDS — the October 2026 review: "The current cards primarily display
 * normal text … each card could contain an image and additional supporting
 * information" — Image, Title, Subtitle, Additional information, Price/Value
 * with a currency, and "+ Add Field" (type, label, value). A card is a row
 * (the answer is unchanged); its title is the label, the rest is `row.meta`,
 * read by the engine's `cardOf` for all three decks.
 */
function CardsEditor({ q, patch }: VariantSettingsProps) {
  const rows = q.rows;
  const rank = q.settings.swipeResponse === "rank";
  /*
   * A ranked deck's options are Rank 1…N, one per card; cards are added and
   * removed in the Cards section above, so the ranks are kept in step here.
   */
  React.useEffect(() => {
    if (rank && !ranksInStep(q.options, rows.length)) patch({ options: rankOptions(rows.length) });
  }, [rank, rows.length, q.options, patch]);
  const setMeta = (i: number, key: string, value: unknown) => {
    const meta = { ...(rows[i].meta ?? {}) } as Record<string, unknown>;
    if (value === undefined || value === "") delete meta[key]; else meta[key] = value;
    patch({ rows: rows.map((r, k) => (k === i ? { ...r, meta } : r)) });
  };
  const plain = (s: string) => s.replace(/<[^>]*>/g, "");
  return (
    <div data-testid="cards-editor">
      <h3 className="sec">Card content</h3>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>
        Each card shows its image first, then the title, subtitle, information, fields and price.
      </p>
      {rows.map((r, i) => {
        const m = (r.meta ?? {}) as Record<string, unknown>;
        const price = (m.price && typeof m.price === "object" ? m.price : m.price != null ? { value: m.price } : {}) as { value?: string | number; currency?: string };
        const fields = (Array.isArray(m.fields) ? m.fields : []) as CardField[];
        const setFields = (next: CardField[]) => setMeta(i, "fields", next.length ? next : undefined);
        const tid = `card-${i}`;
        return (
          <details key={`${i}-${String(r.code)}`} className="card" style={{ padding: 10, marginBottom: 8 }} data-testid={tid} open={rows.length <= 4}>
            <summary style={{ cursor: "pointer", fontSize: 13 }}>
              <strong data-testid={`${tid}-title`}>{plain(r.label) || `Card ${i + 1}`}</strong>
              <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>code {String(r.code)}</span>
            </summary>
            <MediaUrlInput compact accept={["image"]} testId={`${tid}-image`} questionId={q.id} label="Image"
              value={typeof m.image === "string" ? m.image : undefined} onChange={(v) => setMeta(i, "image", v)} />
            <label className="f" style={{ marginBottom: 0 }}><span>Subtitle</span>
              <input className="input" data-testid={`${tid}-subtitle`} value={String(m.subtitle ?? "")}
                onChange={(e) => setMeta(i, "subtitle", e.target.value)} /></label>
            <label className="f" style={{ marginBottom: 0 }}><span>Additional information</span>
              <textarea className="input" rows={2} data-testid={`${tid}-description`} value={String(m.description ?? "")}
                onChange={(e) => setMeta(i, "description", e.target.value)} /></label>
            <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
              <label className="f" style={{ width: 140, marginBottom: 0 }}><span>Price / value</span>
                <input className="input" inputMode="decimal" data-testid={`${tid}-price`} value={price.value == null ? "" : String(price.value)}
                  onChange={(e) => setMeta(i, "price", e.target.value === "" ? undefined : { ...price, value: e.target.value })} /></label>
              <label className="f" style={{ width: 150, marginBottom: 0 }}><span>Currency</span>
                <select className="select" data-testid={`${tid}-currency`} value={price.currency ?? ""}
                  onChange={(e) => setMeta(i, "price", { ...price, currency: e.target.value || undefined })}>
                  <option value="">none</option>
                  {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.symbol} {c.code}</option>)}
                </select></label>
            </div>
            {fields.map((f, k) => (
              <div key={k} className="row" style={{ gap: 6, alignItems: "center", marginTop: 6 }} data-testid={`${tid}-field-${k}`}>
                <select className="select" style={{ width: 150 }} data-testid={`${tid}-field-${k}-type`} value={f.type}
                  onChange={(e) => setFields(fields.map((x, j) => (j === k ? { ...x, type: e.target.value as CardField["type"] } : x)))}>
                  {CARD_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input className="input" style={{ width: 140 }} placeholder="Label (e.g. Location)" data-testid={`${tid}-field-${k}-label`}
                  value={f.label ?? ""} onChange={(e) => setFields(fields.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)))} />
                {f.type === "image" ? (
                  <MediaUrlInput compact accept={["image"]} testId={`${tid}-field-${k}-value`} questionId={q.id}
                    value={typeof f.value === "string" ? f.value : undefined}
                    onChange={(v) => setFields(fields.map((x, j) => (j === k ? { ...x, value: v } : x)))} />
                ) : (
                  <input className="input" style={{ width: 160 }} placeholder="Value" data-testid={`${tid}-field-${k}-value`}
                    inputMode={["number", "currency", "rating", "percentage"].includes(f.type) ? "decimal" : undefined}
                    value={f.value == null ? "" : String(f.value)}
                    onChange={(e) => setFields(fields.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)))} />
                )}
                {f.type === "currency" && (
                  <select className="select" style={{ width: 110 }} data-testid={`${tid}-field-${k}-currency`} value={f.currency ?? ""}
                    onChange={(e) => setFields(fields.map((x, j) => (j === k ? { ...x, currency: e.target.value || undefined } : x)))}>
                    <option value="">none</option>
                    {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.symbol} {c.code}</option>)}
                  </select>
                )}
                <button type="button" className="btn ghost sm" data-testid={`${tid}-field-${k}-up`} disabled={k === 0}
                  aria-label="Move field up" onClick={() => setFields(moveItem(fields, k, -1))}>↑</button>
                <button type="button" className="btn ghost sm" data-testid={`${tid}-field-${k}-remove`}
                  aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== k))}>×</button>
              </div>
            ))}
            <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} data-testid={`${tid}-add-field`}
              onClick={() => setFields([...fields, { type: "text", label: "", value: "" }])}>+ Add field</button>
          </details>
        );
      })}
    </div>
  );
}

const PARTS = [
  { key: "image", label: "image" },
  { key: "subtitle", label: "subtitle" },
  { key: "description", label: "information" },
  { key: "price", label: "price" },
  { key: "fields", label: "fields" },
] as const;

function CardDisplay({ q, patchSettings }: VariantSettingsProps) {
  const s = q.settings;
  const hidden = new Set(s.cardHidden ?? []);
  return (
    <div data-testid="card-display">
      <h3 className="sec">Card display</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
        <label className="f" style={{ width: 190, marginBottom: 0 }}><span>Image position</span>
          <select className="select" data-testid="card-image-position" value={s.cardImagePosition ?? "top"}
            onChange={(e) => patchSettings({ cardImagePosition: e.target.value === "full" ? "full" : undefined })}>
            <option value="top">on top, text below</option>
            <option value="full">fills the card, text over it</option>
          </select></label>
        <label className="f" style={{ width: 140, marginBottom: 0 }}><span>Proportions</span>
          <select className="select" data-testid="card-aspect" value={s.cardAspect ?? ""}
            onChange={(e) => patchSettings({ cardAspect: (e.target.value || undefined) as Question["settings"]["cardAspect"] })}>
            <option value="">automatic</option>
            {(["1:1", "4:5", "3:4", "4:3", "16:9"] as const).map((a) => <option key={a} value={a}>{a}</option>)}
          </select></label>
        <label className="f" style={{ width: 130, marginBottom: 0 }}><span>Size</span>
          <select className="select" data-testid="card-size" value={s.cardSize ?? "medium"}
            onChange={(e) => patchSettings({ cardSize: e.target.value === "medium" ? undefined : (e.target.value as "small" | "large") })}>
            <option value="small">small</option><option value="medium">medium</option><option value="large">large</option>
          </select></label>
        <label className="f" style={{ width: 130, marginBottom: 0 }}><span>Text alignment</span>
          <select className="select" data-testid="card-align" value={s.cardAlign ?? "center"}
            onChange={(e) => patchSettings({ cardAlign: e.target.value === "left" ? "left" : undefined })}>
            <option value="center">centered</option><option value="left">left</option>
          </select></label>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 14, marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Show:</span>
        {PARTS.map((p) => (
          <label key={p.key} className="row" style={{ gap: 5, fontSize: 13 }}>
            <input type="checkbox" data-testid={`card-show-${p.key}`} checked={!hidden.has(p.key)}
              onChange={(e) => {
                const next = new Set(hidden);
                if (e.target.checked) next.delete(p.key); else next.add(p.key);
                patchSettings({ cardHidden: next.size ? [...next] : undefined });
              }} />
            {p.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function SwipeSettings({ q, patch, patchSettings, buttons, response }: VariantSettingsProps & { buttons?: boolean; response?: boolean }) {
  const axes = randomAxes(q.randomization);
  const mode = q.settings.swipeResponse ?? "rate";
  return (
    <div data-testid="swipe-settings">
      <h3 className="sec">Swipe settings</h3>
      {response && (
        <label className="f" style={{ width: 260 }}><span>Response type</span>
          <select className="select" data-testid="swipe-response" value={mode}
            onChange={(e) => {
              const next = e.target.value as "rate" | "rank" | "categorize";
              patch({
                options: optionsForResponse(next, q),
                settings: { ...q.settings, swipeResponse: next === "rate" ? undefined : next },
              });
            }}>
            <option value="rate">Rate — a point on a scale</option>
            <option value="rank">Rank — each card's position, 1 to {q.rows.length}</option>
            <option value="categorize">Categorize — file each card</option>
          </select></label>
      )}
      {response && mode === "rank" && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: -4 }} data-testid="swipe-rank-note">
          Swipe right gives the card the next rank; swipe left puts it back for later. The ranks (1–{q.rows.length}) follow the cards.
        </p>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
        {buttons && (
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" data-testid="swipe-buttons" checked={q.settings.swipeButtons !== false}
              onChange={(e) => patchSettings({ swipeButtons: e.target.checked ? undefined : false })} />
            show Like / Dislike buttons under the card
          </label>
        )}
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" data-testid="swipe-randomize" checked={axes.includes("rows")}
            onChange={(e) => patch({ randomization: toggleRandomAxis(q.randomization, "rows", e.target.checked) })} />
          randomize cards
        </label>
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" data-testid="swipe-required" checked={!!q.required}
            onChange={(e) => patch({ required: e.target.checked })} />
          require a response for every card
        </label>
      </div>
    </div>
  );
}

registerVariantSettings("swipe", (p) => (
  <><CardsEditor {...p} /><CardDisplay {...p} /><SwipeSettings {...p} buttons /></>
));
registerVariantSettings("swiperate", (p) => (
  <><CardsEditor {...p} /><CardDisplay {...p} /><SwipeSettings {...p} response /></>
));
registerVariantSettings("swipe4", (p) => (
  <><CardsEditor {...p} /><CardDisplay {...p} /><Directions {...p} /><SwipeSettings {...p} /></>
));
