import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOf, formatMoney, formatCardField } from "./cards.js";

test("cardOf — the row's label is the title; image, subtitle, description, price and fields come from meta", () => {
  const c = cardOf({
    label: "Product A",
    meta: {
      image: "https://x/a.png", subtitle: "Premium wireless headphones", description: "Noise cancellation",
      price: { value: 99.99, currency: "USD" },
      fields: [{ type: "text", label: "Location", value: "Mumbai" }, { type: "bogus", value: 1 }, null],
    },
  });
  assert.equal(c.title, "Product A");
  assert.equal(c.image, "https://x/a.png");
  assert.equal(c.subtitle, "Premium wireless headphones");
  assert.deepEqual(c.price, { value: 99.99, currency: "USD" });
  assert.deepEqual(c.fields, [{ type: "text", label: "Location", value: "Mumbai" }], "unknown field types and junk are dropped");
  assert.deepEqual(cardOf({ label: "Card 1" }), { title: "Card 1", image: undefined, subtitle: undefined, description: undefined, price: undefined, fields: [] },
    "a plain card is just its label — every deck authored before draws as it did");
  assert.deepEqual(cardOf({ label: "Old", meta: { price: "$9.99" } }).price, { value: "$9.99" }, "an older bare price string is kept");
  assert.equal(cardOf({ label: "x", meta: { price: { value: "" } } }).price, undefined);
});

test("formatMoney and formatCardField — the review's $99.00 and ₹999.00, a rating as stars, a percentage", () => {
  assert.equal(formatMoney(99, "USD"), "$99.00");
  assert.equal(formatMoney("999", "INR"), "₹999.00");
  assert.equal(formatMoney(1234.5, "USD"), "$1,234.50");
  assert.equal(formatMoney("from $49", "USD"), "from $49", "typed text is shown as typed");
  assert.equal(formatMoney(5), "5.00");
  assert.equal(formatCardField({ type: "rating", value: 4 }), "★★★★☆");
  assert.equal(formatCardField({ type: "percentage", value: 30 }), "30%");
  assert.equal(formatCardField({ type: "currency", value: 10, currency: "EUR" }), "€10.00");
  assert.equal(formatCardField({ type: "image", value: "u.png" }), "");
  assert.equal(formatCardField({ type: "text", value: "" }), "");
});
