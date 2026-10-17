/**
 * REFERENCES FOR "DESIGN WITH AI" — the files the Branding theme assistant
 * accepts beside the prompt: up to four images to build the theme from.
 * Pure (no DOM), so the browser and the tests ask the same question.
 *
 * Images only: PNG, JPG / JPEG, WebP. Each is read IN THE BROWSER (dominant
 * colours, a contrast-checked palette, dark or light) and the model is told
 * those colours — never the bytes — so a reference must be something the
 * browser can draw. A PDF is refused with a reason: the repository has no PDF
 * renderer to turn its first page into an image, and the theme turn sends
 * the model text only, so there is nothing that could read it.
 */
export const THEME_REFERENCE_MAX = 4;
export const THEME_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const THEME_REFERENCE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const THEME_REFERENCE_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

const BY_EXTENSION: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf" };

/** the file's type, from the browser's or, when it gave none, from the name */
export function themeReferenceType(file: { name: string; type?: string }): string {
  const t = (file.type ?? "").toLowerCase();
  if (t) return t === "image/jpg" ? "image/jpeg" : t;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? "";
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** why this file cannot be a reference, in words — or null when it can */
export function refuseThemeReference(file: { name: string; type?: string; size: number }, alreadyAttached: number): string | null {
  const name = file.name || "That file";
  if (alreadyAttached >= THEME_REFERENCE_MAX) return `Up to ${THEME_REFERENCE_MAX} references — remove one before adding “${name}”.`;
  const type = themeReferenceType(file);
  if (type === "application/pdf") return `“${name}” is a PDF. PDF references are not supported yet — the Studio cannot turn a PDF page into an image here. Export the page as PNG or JPG and attach that.`;
  if (!THEME_REFERENCE_TYPES.includes(type)) return `“${name}” is not a supported reference — attach a PNG, JPG/JPEG or WebP image.`;
  if (file.size <= 0) return `“${name}” is empty.`;
  if (file.size > THEME_REFERENCE_MAX_BYTES) return `“${name}” is ${mb(file.size)} — a reference can be up to ${mb(THEME_REFERENCE_MAX_BYTES)}.`;
  return null;
}
