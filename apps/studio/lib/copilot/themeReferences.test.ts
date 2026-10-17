import test from "node:test";
import assert from "node:assert/strict";
import { refuseThemeReference, themeReferenceType, THEME_REFERENCE_MAX, THEME_REFERENCE_MAX_BYTES } from "./themeReferences.ts";
import { describeThemeImage, describeThemeImages, withThemeImage, themeImageToken, THEME_IMAGE_TOKEN } from "./themeImageText.ts";

/** Branding → Design with AI: which files may be references, and how several reach the model. */

test("PNG, JPG/JPEG and WebP are accepted, by type or — when the browser gives none — by name", () => {
  for (const f of [{ name: "a.png", type: "image/png" }, { name: "b.jpg", type: "image/jpeg" }, { name: "c.JPEG", type: "" }, { name: "d.webp", type: "image/webp" }, { name: "e.jpg", type: "image/jpg" }]) {
    assert.equal(refuseThemeReference({ ...f, size: 2048 }, 0), null, f.name);
  }
  assert.equal(themeReferenceType({ name: "x.jpeg" }), "image/jpeg");
});

test("unsupported types are refused in words that name the file and the formats", () => {
  for (const f of [{ name: "logo.gif", type: "image/gif" }, { name: "logo.svg", type: "image/svg+xml" }, { name: "notes.txt", type: "text/plain" }, { name: "noext", type: "" }]) {
    assert.match(refuseThemeReference({ ...f, size: 10 }, 0) ?? "", new RegExp(`“${f.name}” is not a supported reference — attach a PNG, JPG/JPEG or WebP image`), f.name);
  }
});

test("a PDF is refused with the reason and what to do instead", () => {
  for (const f of [{ name: "brand.pdf", type: "application/pdf" }, { name: "brand.pdf", type: "" }]) {
    assert.match(refuseThemeReference({ ...f, size: 1000 }, 0) ?? "", /“brand\.pdf” is a PDF\. PDF references are not supported yet.*Export the page as PNG or JPG/);
  }
});

test("size: empty and oversized files are refused with their size and the limit", () => {
  assert.match(refuseThemeReference({ name: "a.png", type: "image/png", size: 0 }, 0) ?? "", /is empty/);
  assert.equal(refuseThemeReference({ name: "a.png", type: "image/png", size: THEME_REFERENCE_MAX_BYTES }, 0), null, "exactly the limit is fine");
  assert.match(refuseThemeReference({ name: "big.jpg", type: "image/jpeg", size: 12 * 1024 * 1024 }, 0) ?? "", /“big\.jpg” is 12 MB — a reference can be up to 10 MB/);
});

test("at most four references", () => {
  assert.equal(refuseThemeReference({ name: "a.png", type: "image/png", size: 10 }, THEME_REFERENCE_MAX - 1), null);
  assert.match(refuseThemeReference({ name: "e.png", type: "image/png", size: 10 }, THEME_REFERENCE_MAX) ?? "", /Up to 4 references — remove one before adding “e\.png”/);
});

test("one reference reads to the model exactly as a single theme image always did", () => {
  const t = { name: "mood.jpg", dominant: ["#1d1f20"], palette: { primary: "#dc3214" }, dark: true };
  assert.equal(describeThemeImages([t]), describeThemeImage(t));
  assert.equal(describeThemeImages([]), "");
});

test("several references: numbered, each with its own placeholder, each replaced by its own address", () => {
  const text = describeThemeImages([
    { name: "a.png", dominant: ["#111111"], palette: { primary: "#dc3214" }, dark: true },
    { name: "b.webp", dominant: ["#fafafa"], palette: { primary: "#2244aa" }, dark: false },
  ]);
  assert.match(text, /THEME REFERENCES uploaded — 2 images/);
  assert.match(text, /REFERENCE 1 \(a\.png\): a dark image; dominant colours #111111; palette primary #dc3214\. Placeholder "\{\{THEME_IMAGE\}\}"/);
  assert.match(text, /REFERENCE 2 \(b\.webp\): a light image; .*Placeholder "\{\{THEME_IMAGE_2\}\}"/);
  assert.equal(themeImageToken(1), THEME_IMAGE_TOKEN);
  const acts = withThemeImage([{ op: "set_theme", background: { image: "{{THEME_IMAGE_2}}" }, logo: THEME_IMAGE_TOKEN }], ["https://cdn/a.png", "https://cdn/b.webp"]);
  assert.deepEqual(acts, [{ op: "set_theme", background: { image: "https://cdn/b.webp" }, logo: "https://cdn/a.png" }]);
  // the single-address form is unchanged
  assert.deepEqual(withThemeImage({ x: THEME_IMAGE_TOKEN, y: "{{THEME_IMAGE_2}}" }, "u"), { x: "u", y: "{{THEME_IMAGE_2}}" });
});
