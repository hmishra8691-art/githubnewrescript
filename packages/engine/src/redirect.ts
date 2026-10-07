import type { SurveyDefinition } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { resolvePiping } from "./piping.js";
import { embeddedCatalog, embeddedTypeOf } from "./embedded.js";

/**
 * Redirect URLs (reqs §17–18).
 *
 * A redirect URL is a template: `https://panel.com/done?id={{ed.PANEL_ID}}`.
 * The tokens are the same ones the rest of the platform pipes, so anything
 * pipeable into question text can travel back to the panel — but a URL is not
 * HTML, so the values are percent-encoded rather than HTML-escaped. Sending
 * `Ben & Jerry` as a query parameter without that produces a truncated value
 * on the receiving end, and `&amp;` is worse than useless there.
 */

const TOKEN_RE = /\{\{\s*[^}]+?\s*\}\}/g;

/**
 * THE ADDRESS ITSELF, OR A VALUE IN IT (October 2026 review).
 *
 * A value pasted into a template is a parameter, and is percent-encoded so
 * `Ben & Jerry` arrives whole. An embedded field declared as a URL that
 * STARTS the template is different: it is the address — `{{ed.redirect_url}}`
 * holding `https://example.com/survey?id=123` must send the respondent to
 * exactly that, not to `https%3A%2F%2Fexample.com…`, which a browser reads as
 * a relative path on the survey's own site. The declared type decides,
 * never the value's appearance; a URL field placed later in a template
 * (`…?return={{ed.redirect_url}}`) is a parameter, and is encoded, which is
 * what keeps its own `?`, `&` and `=` intact on the other side.
 */
export function leadingUrlField(def: Pick<SurveyDefinition, "embeddedData" | "flow">, url: string): string | null {
  const m = /^\s*\{\{\s*ed\.([^}\s]+)\s*\}\}/.exec(url ?? "");
  if (!m) return null;
  return embeddedTypeOf(def as SurveyDefinition, m[1]) === "url" ? m[1] : null;
}

/** Resolve piping tokens in a URL and percent-encode each resolved value. */
export function resolveUrlTemplate(url: string, ctx: EvalContext): string {
  if (!url || !url.includes("{{")) return url;
  const base = ctx.def ? leadingUrlField(ctx.def, url) : null;
  let first = true;
  return url.trim().replace(TOKEN_RE, (token) => {
    const leading = first && base !== null;
    first = false;
    const resolved = resolvePiping(token, ctx);
    if (!resolved) return "";
    // resolvePiping HTML-escapes respondent-derived values; a URL needs the
    // raw text, encoded for a query string instead
    const plain = decodeEntities(resolved);
    return leading ? plain : encodeURIComponent(plain);
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface UrlCheck {
  ok: boolean;
  error?: string;
  warning?: string;
  /** Tokens found in the URL, for the editor to highlight. */
  tokens: string[];
}

/**
 * Validate a redirect URL as the programmer types it (req §17).
 *
 * Tokens are replaced with a placeholder before parsing: `{{ed.ID}}` is not
 * valid URL syntax, and refusing a template because of the very feature it is
 * using would be absurd.
 */
export function validateRedirectUrl(url: string, def?: Pick<SurveyDefinition, "embeddedData" | "flow">): UrlCheck {
  const tokens = [...(url ?? "").matchAll(TOKEN_RE)].map((m) => m[0]);
  const raw = (url ?? "").trim();
  if (!raw) return { ok: false, error: "Enter a URL", tokens };
  if (raw === "https://" || raw === "http://") return { ok: false, error: "Enter a URL", tokens };

  /* the address comes from a URL-typed field: what follows it is checked against a stand-in address */
  const base = def ? leadingUrlField(def, raw) : null;
  const probe = (base ? raw.replace(/^\s*\{\{[^}]+\}\}/, "https://example.com") : raw).replace(TOKEN_RE, "TOKEN");
  if (!/^https?:\/\//i.test(probe)) {
    return { ok: false, error: "URL must start with https:// (or http://)", tokens };
  }
  let parsed: URL;
  try {
    parsed = new URL(probe);
  } catch {
    return { ok: false, error: "That is not a valid URL", tokens };
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    return { ok: false, error: "That URL has no domain name", tokens };
  }
  if (base) {
    return { ok: true, warning: `The address comes from {{ed.${base}}} (a URL field) — it is used exactly as captured`, tokens };
  }
  if (parsed.protocol === "http:") {
    return {
      ok: true,
      warning: "http:// is not encrypted — most panels require https://",
      tokens,
    };
  }
  return { ok: true, tokens };
}

export interface PipeVariable {
  /** The token to insert, e.g. "{{ed.PANEL_ID}}" */
  token: string;
  label: string;
  group: string;
}

/**
 * Everything a programmer can put into a URL or piped text, grouped for the
 * picker so nobody has to remember variable names (req §18).
 */
export function urlVariableCatalog(def: SurveyDefinition): PipeVariable[] {
  const out: PipeVariable[] = [];
  for (const e of embeddedCatalog(def)) {
    out.push({
      token: `{{ed.${e.name}}}`,
      label: `${e.name}${e.dataType && e.dataType !== "string" ? ` (${e.dataType})` : ""}`,
      group: "Embedded data",
    });
  }
  for (const q of def.questions) {
    out.push({ token: `{{${q.code}.value}}`, label: `${q.code} — answer code`, group: "Question answers" });
    out.push({ token: `{{${q.code}.label}}`, label: `${q.code} — answer label`, group: "Question answers" });
  }
  for (const c of def.calculations) {
    out.push({ token: `{{calc.${c.targetVariable}}}`, label: c.targetVariable, group: "Calculations" });
  }
  out.push(
    { token: "{{ed.RESPONSE_ID}}", label: "Response id", group: "System" },
    { token: "{{ed.SURVEY_CODE}}", label: "Survey code", group: "System" },
  );
  return out;
}
