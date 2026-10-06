"use client";
import React from "react";
import type { Question, QuestionRow } from "@rescript/schema";
import { cardOf, formatMoney, formatCardField } from "@rescript/engine";
import { SafeImage } from "./Media";

/**
 * WHAT A SWIPE CARD SHOWS — the same face on the Tinder deck, Swipe to Rate /
 * Rank / Categorize and Four-Direction Swipe (October 2026 review): "Image →
 * Title → Subtitle → Additional Information → Price/Value → Custom Fields",
 * with "the image visually prominent, while the title and supporting
 * information appear below it".
 *
 * Settings decide the rest: where the image sits (`cardImagePosition` — on
 * top, or filling the card behind the text), the card's proportions and size
 * (`cardAspect`, `cardSize`), the text alignment, and which parts are shown
 * (`cardHidden`). A card with only a label draws exactly as cards always did.
 */
export function CardFace({ row, settings, testid }: {
  row: Pick<QuestionRow, "label" | "meta" | "code">;
  settings: Question["settings"];
  testid?: string;
}) {
  const c = cardOf(row);
  const hidden = new Set(settings.cardHidden ?? []);
  const full = settings.cardImagePosition === "full" && !!c.image && !hidden.has("image");
  const rich = !!(c.image || c.subtitle || c.description || c.price || c.fields.length);
  return (
    <div className={`rs-cardface ${full ? "full" : ""} ${rich ? "rich" : "plain"} align-${settings.cardAlign ?? "center"}`}
      data-testid={testid ?? "card-face"} data-card={String(row.code)}>
      {c.image && !hidden.has("image") && (
        <div className="rs-cardface-img">
          <SafeImage src={c.image} alt="" draggable={false} />
        </div>
      )}
      <div className="rs-cardface-body">
        <div className="rs-cardface-title" data-testid="card-title" dangerouslySetInnerHTML={{ __html: c.title }} />
        {c.subtitle && !hidden.has("subtitle") && <div className="rs-cardface-sub" data-testid="card-subtitle">{c.subtitle}</div>}
        {c.description && !hidden.has("description") && <div className="rs-cardface-desc" data-testid="card-description">{c.description}</div>}
        {c.fields.length > 0 && !hidden.has("fields") && (
          <dl className="rs-cardface-fields" data-testid="card-fields">
            {c.fields.map((f, i) => (
              f.type === "image" ? (
                f.value ? <div key={i} className="rs-cardface-fimg"><SafeImage src={String(f.value)} alt={f.label ?? ""} /></div> : null
              ) : (
                <div key={i} className="rs-cardface-field" data-field-type={f.type}>
                  {f.label && <dt>{f.label}</dt>}
                  <dd>{formatCardField(f)}</dd>
                </div>
              )
            ))}
          </dl>
        )}
        {c.price && !hidden.has("price") && (
          <div className="rs-cardface-price" data-testid="card-price">{formatMoney(c.price.value, c.price.currency)}</div>
        )}
      </div>
    </div>
  );
}

/** The card container's class: size and proportions (portrait 4:5 by default for the four-direction deck). */
export function cardFrameClass(settings: Question["settings"], fallbackAspect: string): string {
  const aspect = (settings.cardAspect ?? fallbackAspect).replace(":", "-");
  return `rs-cardframe size-${settings.cardSize ?? "medium"} aspect-${aspect}`;
}
