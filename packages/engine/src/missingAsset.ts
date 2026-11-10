/**
 * A PICTURE THE QUESTIONNAIRE REFERS TO BUT DID NOT INCLUDE (2026-11-10).
 *
 * A questionnaire often says "[SHOW IMAGE: pack_shot.png]" or "INSERT CONCEPT BOARD HERE" without the file. The
 * importer must not invent a picture and must not lose the instruction: it leaves this visible placeholder in the
 * question, reports it in the import review, and the survey's own checks keep warning until it is replaced — so a
 * survey cannot reach the field with a stimulus missing and nobody told.
 */
const KINDS = "Image|Picture|Photo|Video|Audio|Logo|Stimulus|Concept board|Concept|Pack shot";
export const MISSING_ASSET_RE = new RegExp(`\\[(${KINDS}) to add(?::\\s*([^\\]]*))?\\]`, "i");

export function missingAssetPlaceholder(kind: string, name?: string): string {
  const k = kind.trim().toLowerCase().replace(/\s+/g, " ");
  const word = k.charAt(0).toUpperCase() + k.slice(1);
  const n = (name ?? "").replace(/[\[\]<>]/g, "").trim();
  return `[${word} to add${n ? `: ${n}` : ""}]`;
}

/** the placeholders in a piece of survey text: what is missing and, when the document named it, its file name */
export function missingAssetsIn(text: unknown): { kind: string; name: string }[] {
  const out: { kind: string; name: string }[] = [];
  const re = new RegExp(MISSING_ASSET_RE.source, "gi");
  for (const m of String(text ?? "").matchAll(re)) out.push({ kind: m[1].toLowerCase(), name: (m[2] ?? "").trim() });
  return out;
}
