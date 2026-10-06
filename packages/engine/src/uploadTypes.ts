/**
 * WHICH FILES AN UPLOAD QUESTION TAKES (October 2026 review).
 *
 * "The Accepted Files field currently allows the programmer to manually enter
 * a file type such as PDF. However, this value is not properly validated in
 * the Preview … the respondent can still upload an Excel (.xlsx) file and
 * continue." The free-text value was handed to the file dialog's `accept`
 * attribute and nowhere else — a hint the browser may show, never a rule —
 * and "pdf" without its dot was not even a valid hint. Photo / Camera Capture
 * offered the same field and accepted documents.
 *
 * So the kinds are a list the programmer ticks, each with the extensions and
 * MIME types it means, and the same function decides in the respondent's
 * picker and in validation: a file the picker refuses cannot arrive through a
 * resumed session or a posted answer either.
 */

export interface UploadKind {
  key: string;
  label: string;
  /** how the error names it: "a PDF file" */
  noun: string;
  exts: string[];
  mimes: string[];
}

export const UPLOAD_KINDS: readonly UploadKind[] = [
  { key: "pdf", label: "PDF (.pdf)", noun: "PDF", exts: [".pdf"], mimes: ["application/pdf"] },
  { key: "word", label: "Word (.doc, .docx)", noun: "Word", exts: [".doc", ".docx"], mimes: ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  { key: "excel", label: "Excel (.xls, .xlsx)", noun: "Excel", exts: [".xls", ".xlsx"], mimes: ["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] },
  { key: "powerpoint", label: "PowerPoint (.ppt, .pptx)", noun: "PowerPoint", exts: [".ppt", ".pptx"], mimes: ["application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"] },
  { key: "csv", label: "CSV (.csv)", noun: "CSV", exts: [".csv"], mimes: ["text/csv"] },
  { key: "text", label: "Text (.txt)", noun: "text", exts: [".txt"], mimes: ["text/plain"] },
  { key: "image", label: "Image (.jpg, .jpeg, .png, .gif, .webp)", noun: "image", exts: [".jpg", ".jpeg", ".png", ".gif", ".webp"], mimes: ["image/jpeg", "image/png", "image/gif", "image/webp"] },
  { key: "video", label: "Video (.mp4, .mov, .avi)", noun: "video", exts: [".mp4", ".mov", ".avi"], mimes: ["video/mp4", "video/quicktime", "video/x-msvideo"] },
  { key: "audio", label: "Audio (.mp3, .wav, .m4a)", noun: "audio", exts: [".mp3", ".wav", ".m4a"], mimes: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/x-m4a"] },
  { key: "zip", label: "ZIP (.zip)", noun: "ZIP", exts: [".zip"], mimes: ["application/zip", "application/x-zip-compressed"] },
];

/** Photo / Camera Capture takes these and nothing else ("JPG, JPEG, or PNG"). */
export const PHOTO_KIND: UploadKind = {
  key: "photo", label: "JPG, JPEG or PNG image", noun: "image", exts: [".jpg", ".jpeg", ".png"], mimes: ["image/jpeg", "image/png"],
};

export interface UploadAccept {
  exts: string[];
  mimes: string[];
  /** `image/*`-style wildcards from an older free-text setting */
  wildcards: string[];
  /** the file dialog's `accept` attribute */
  attr: string;
  /** for messages: "a PDF file", "a PDF or Word file", "an image file (JPG, JPEG, or PNG)" */
  wanted: string;
}

const ext = (name: string) => {
  const m = /\.[A-Za-z0-9]+$/.exec(name.trim());
  return m ? m[0].toLowerCase() : "";
};
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
function joinOr(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
}

/**
 * What a question accepts — or null for "any file".
 *
 *   Photo / Camera Capture   always JPG / JPEG / PNG, whatever its settings
 *   `acceptTypes`            the ticked kinds plus any ".ext" entries
 *   `accept` (older text)    read as a comma list of extensions, MIME types
 *                            and wildcards; a bare "pdf" is read as ".pdf"
 */
export function uploadAccept(q: { variant?: string | null; settings: { acceptTypes?: string[]; accept?: string } }): UploadAccept | null {
  if (q.variant === "upload.photo") {
    return {
      exts: PHOTO_KIND.exts, mimes: PHOTO_KIND.mimes, wildcards: [],
      attr: [...PHOTO_KIND.mimes, ...PHOTO_KIND.exts].join(","),
      wanted: "an image file (JPG, JPEG, or PNG)",
    };
  }
  const exts: string[] = [], mimes: string[] = [], wildcards: string[] = [], nouns: string[] = [];
  const list = q.settings.acceptTypes?.length
    ? q.settings.acceptTypes
    : (q.settings.accept ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return null;
  for (const raw of list) {
    const k = UPLOAD_KINDS.find((x) => x.key === raw.toLowerCase());
    if (k) { exts.push(...k.exts); mimes.push(...k.mimes); nouns.push(k.noun); continue; }
    if (/^[\w.+-]+\/\*$/.test(raw)) { wildcards.push(raw.toLowerCase()); nouns.push(raw.split("/")[0]); continue; }
    if (/^[\w.+-]+\/[\w.+-]+$/.test(raw)) { mimes.push(raw.toLowerCase()); nouns.push(raw); continue; }
    const e = raw.startsWith(".") ? raw.toLowerCase() : `.${raw.toLowerCase()}`;
    if (/^\.[a-z0-9]+$/.test(e)) {
      exts.push(e);
      /* a typed "pdf" reads as the PDF kind in messages too */
      const named = UPLOAD_KINDS.find((x) => x.exts.includes(e));
      nouns.push(named ? named.noun : e);
    }
  }
  if (!exts.length && !mimes.length && !wildcards.length) return null;
  const uniq = [...new Set(nouns)];
  const phrase = joinOr(uniq);
  return {
    exts: [...new Set(exts)], mimes: [...new Set(mimes)], wildcards,
    attr: [...new Set([...exts, ...mimes, ...wildcards])].join(","),
    wanted: `${article(phrase)} ${phrase} file`,
  };
}

/**
 * Does this file fit? By extension first (what the respondent sees), then by
 * MIME type — a file whose name has no extension, like a photo taken in the
 * page, is judged on its type.
 */
export function uploadTypeAllowed(acc: UploadAccept | null, file: { name?: string; type?: string }): boolean {
  if (!acc) return true;
  const e = ext(file.name ?? "");
  if (e && acc.exts.includes(e)) return true;
  const t = (file.type ?? "").toLowerCase();
  if (t && acc.mimes.includes(t)) return true;
  if (t && acc.wildcards.some((w) => t.startsWith(w.slice(0, -1)))) return true;
  /* a name with an extension the list does not have is refused even if the type looks right — the name is what was chosen */
  return false;
}
