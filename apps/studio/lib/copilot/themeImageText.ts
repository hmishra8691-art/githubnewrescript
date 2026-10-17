/** the server-safe half of themeImage.ts: what the model is told, and the placeholder it writes */
export const THEME_IMAGE_TOKEN = "{{THEME_IMAGE}}";

/** the placeholder for reference `n` (1-based): the first keeps the original token, so a one-image turn reads exactly as before */
export const themeImageToken = (n: number) => (n <= 1 ? THEME_IMAGE_TOKEN : `{{THEME_IMAGE_${n}}}`);

type ThemeImageFacts = { name?: string; dominant?: string[]; palette?: Record<string, string>; dark?: boolean };

/** a theme image as the model sees it: colours and a placeholder, not the bytes */
export function describeThemeImage(t: ThemeImageFacts): string {
  const pal = Object.entries(t.palette ?? {}).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(", ");
  return `THEME IMAGE uploaded${t.name ? ` (${t.name})` : ""}: a ${t.dark ? "dark" : "light"} image; dominant colours ${(t.dominant ?? []).join(", ")}; a contrast-checked palette derived from it: ${pal}. To use it as the background write background.image "${THEME_IMAGE_TOKEN}" — the Studio puts the image's address there.`;
}

/**
 * SEVERAL REFERENCES ("Design with AI" in Branding): each told the same way,
 * numbered, each with its own placeholder. One reference is described exactly
 * as a single theme image always was.
 */
export function describeThemeImages(list: readonly ThemeImageFacts[]): string {
  if (list.length <= 1) return list.length ? describeThemeImage(list[0]) : "";
  const one = (t: ThemeImageFacts, i: number) => {
    const pal = Object.entries(t.palette ?? {}).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(", ");
    return `REFERENCE ${i + 1}${t.name ? ` (${t.name})` : ""}: a ${t.dark ? "dark" : "light"} image; dominant colours ${(t.dominant ?? []).join(", ")}; palette ${pal}. Placeholder "${themeImageToken(i + 1)}".`;
  };
  return `THEME REFERENCES uploaded — ${list.length} images to build ONE coherent theme from (blend them; reference 1 leads unless the request says otherwise):\n${list.map(one).join("\n")}\nTo use one as the background write background.image with its placeholder — the Studio puts that image's address there.`;
}

/** the placeholders, wherever the model put them, replaced by the images' addresses (one address, or one per reference in order) */
export function withThemeImage<T>(actions: T, url: string | readonly string[]): T {
  const urls = typeof url === "string" ? [url] : url;
  const byToken = new Map(urls.map((u, i) => [themeImageToken(i + 1), u]));
  return JSON.parse(JSON.stringify(actions), (_k, v) => (typeof v === "string" && byToken.has(v) ? byToken.get(v) : v)) as T;
}
