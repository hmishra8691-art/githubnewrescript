import { uploadAsset } from "@/lib/assets";
import { dominantColorsFromImage, generatePalette, rgbToHex, type RGB } from "@/lib/paletteFromImage";

/**
 * AN IMAGE TO BUILD A THEME FROM — "build the survey theme based on this
 * image", "use this as the background". Read in the browser: its dominant
 * colours, a contrast-checked palette derived from them (the Branding
 * panel's own generator), whether it is dark or light, and a URL the survey
 * can load it from — the asset library when it is set up, otherwise a
 * downscaled inline image. The model is told the colours and a placeholder
 * for the URL, never the image bytes.
 */
export interface ThemeImage { url: string; name: string; dominant: string[]; palette: Record<string, string>; dark: boolean; uploaded: boolean }
export { THEME_IMAGE_TOKEN, describeThemeImage, withThemeImage } from "./themeImageText";

async function downscale(file: File, max = 1600): Promise<string> {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error("could not read the image")); img.src = src; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  } finally { URL.revokeObjectURL(src); }
}
const lightness = ({ r, g, b }: RGB) => (Math.max(r, g, b) + Math.min(r, g, b)) / 510;

export async function prepareThemeImage(file: File, surveyDbId: string): Promise<ThemeImage> {
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
  const inline = await downscale(file);
  const seeds = await dominantColorsFromImage(inline, 5);
  if (!seeds.length) throw new Error("No colours could be read from that image.");
  const palette = generatePalette(seeds) as unknown as Record<string, string>;
  const dark = seeds.slice(0, 3).reduce((a, c) => a + lightness(c), 0) / Math.min(3, seeds.length) < 0.42;
  let url = inline, uploaded = false;
  const up = await uploadAsset(surveyDbId, file).catch(() => null);
  if (up && up.ok && /^https:\/\/|^\//.test(up.asset.url)) { url = up.asset.url; uploaded = true; }
  return { url, name: file.name, dominant: seeds.map(rgbToHex), palette, dark, uploaded };
}

