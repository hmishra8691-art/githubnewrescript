/** the server-safe half of themeImage.ts: what the model is told, and the placeholder it writes */
export const THEME_IMAGE_TOKEN = "{{THEME_IMAGE}}";

/** a theme image as the model sees it: colours and a placeholder, not the bytes */
export function describeThemeImage(t: { name?: string; dominant?: string[]; palette?: Record<string, string>; dark?: boolean }): string {
  const pal = Object.entries(t.palette ?? {}).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(", ");
  return `THEME IMAGE uploaded${t.name ? ` (${t.name})` : ""}: a ${t.dark ? "dark" : "light"} image; dominant colours ${(t.dominant ?? []).join(", ")}; a contrast-checked palette derived from it: ${pal}. To use it as the background write background.image "${THEME_IMAGE_TOKEN}" — the Studio puts the image's address there.`;
}

/** the placeholder, wherever the model put it, replaced by the image's address */
export function withThemeImage<T>(actions: T, url: string): T {
  return JSON.parse(JSON.stringify(actions), (_k, v) => (v === THEME_IMAGE_TOKEN ? url : v)) as T;
}
