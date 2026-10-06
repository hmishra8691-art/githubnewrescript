import type { QuestionRow } from "@rescript/schema";
import { CURRENCIES } from "./formats.js";

/**
 * A SWIPE CARD'S CONTENT (October 2026 review).
 *
 * "The current cards primarily display normal text. The card would be more
 * useful and visually meaningful if each card could contain an image and
 * additional supporting information" — image, title, subtitle, description,
 * price / value with a currency, and "+ Add Field" for anything else
 * (location, rating, category, brand, features …), for the Tinder deck, Swipe
 * to Rate / Rank / Categorize and Four-Direction Swipe alike.
 *
 * A card is a row, so the answer is unchanged (`{ cardCode: verdictCode }`).
 * Its title is the row's label; everything else lives in `row.meta`. This
 * reads that into one shape the three renderers draw the same way.
 */

export type CardFieldType = "text" | "longtext" | "number" | "currency" | "rating" | "percentage" | "image";
export const CARD_FIELD_TYPES: readonly { value: CardFieldType; label: string }[] = [
  { value: "text", label: "Short text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "rating", label: "Rating (★ out of 5)" },
  { value: "percentage", label: "Percentage" },
  { value: "image", label: "Image" },
];

export interface CardField { type: CardFieldType; label?: string; value?: string | number; currency?: string }
export interface CardPrice { value?: string | number; currency?: string }
export interface Card {
  title: string;
  image?: string;
  subtitle?: string;
  description?: string;
  price?: CardPrice;
  fields: CardField[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

export function cardOf(row: Pick<QuestionRow, "label" | "meta">): Card {
  const m = (row.meta ?? {}) as Record<string, unknown>;
  const rawPrice = m.price;
  /* an older card kept its price as a bare string ("$9.99") — read it as the value */
  const price: CardPrice | undefined = rawPrice && typeof rawPrice === "object"
    ? { value: (rawPrice as CardPrice).value, currency: (rawPrice as CardPrice).currency }
    : rawPrice != null && rawPrice !== "" ? { value: rawPrice as string | number } : undefined;
  const fields = Array.isArray(m.fields)
    ? (m.fields as CardField[]).filter((f) => f && typeof f === "object" && CARD_FIELD_TYPES.some((t) => t.value === f.type))
    : [];
  return {
    title: row.label,
    image: str(m.image),
    subtitle: str(m.subtitle),
    description: str(m.description),
    price: price && price.value != null && price.value !== "" ? price : undefined,
    fields,
  };
}

/**
 * Money as the respondent reads it: "$99.00", "₹999.00". A number is shown
 * with two decimals and its currency's symbol; text the programmer typed
 * ("from $49") is shown as typed.
 */
export function formatMoney(value: string | number | undefined, currency?: string): string {
  if (value == null || value === "") return "";
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  const sym = currency ? CURRENCIES.find((c) => c.code === currency)?.symbol ?? currency : "";
  if (!Number.isFinite(n)) return String(value);
  const fixed = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${fixed}`;
}

/** A field's value as text (an image field is drawn, not printed: ""). */
export function formatCardField(f: CardField): string {
  if (f.value == null || f.value === "") return "";
  switch (f.type) {
    case "currency": return formatMoney(f.value, f.currency);
    case "percentage": return `${f.value}%`;
    case "rating": {
      const n = Math.max(0, Math.min(5, Math.round(Number(f.value))));
      return Number.isFinite(n) ? `${"★".repeat(n)}${"☆".repeat(5 - n)}` : String(f.value);
    }
    case "image": return "";
    default: return String(f.value);
  }
}
