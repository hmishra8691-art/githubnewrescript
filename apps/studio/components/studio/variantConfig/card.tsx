"use client";
import { registerVariantSettings, registerOptionMetaFields, DESC, PRICE, BADGE } from "./registry";

/**
 * Studio authoring for the cards family.
 *
 * Flip cards draw a description, a price and a badge on the back, so those
 * per-option fields are exposed for the `flipcards` renderer (an icon stands
 * in when an option has no image).
 *
 * A card sort's piles ARE its options; the deck's cards are its rows. The
 * renderer swipes to the first two piles and shows at most five, so the
 * editor says so rather than letting a ten-pile sort silently lose piles.
 */

registerOptionMetaFields("flipcards", [
  DESC, PRICE, BADGE,
  { key: "icon", label: "icon", placeholder: "emoji (no image)", width: 90 },
]);

registerVariantSettings("cardsort", ({ q }) => {
  const piles = q.options.length;
  return (
    <>
      <div className={`chip ${piles < 2 || piles > 5 ? "warn" : ""}`} data-testid="cardsort-piles">
        {piles < 2
          ? `A card sort needs at least two piles — this one has ${piles}. Add them in Options.`
          : piles > 5
            ? `${piles} piles configured; only the first five are shown. Two to five works on a phone.`
            : `${piles} piles, ${q.rows.length} card${q.rows.length === 1 ? "" : "s"} in the deck.`}
      </div>
      <div className="chip" data-testid="cardsort-swipe-note" style={{ marginLeft: 6 }}>
        Swipe left → “{q.options[0]?.label.replace(/<[^>]*>/g, "") ?? "—"}”, right → “
        {q.options[1]?.label.replace(/<[^>]*>/g, "") ?? "—"}”. A card can also be dragged onto any
        pile, or the pile tapped.
      </div>
      {q.rows.length === 0 && (
        <div className="chip warn" data-testid="cardsort-no-rows" style={{ marginLeft: 6 }}>
          The deck is empty — add the cards in <strong>Rows</strong> above.
        </div>
      )}
    </>
  );
});
