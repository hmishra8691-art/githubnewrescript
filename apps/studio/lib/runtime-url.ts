/**
 * Resolve the respondent runtime's base URL.
 *
 * NEXT_PUBLIC_RUNTIME_URL is typed by hand into Vercel, so tolerate the two
 * common mistakes: a missing scheme ("survey.example.com", which the browser
 * would otherwise resolve as a *relative* path) and a trailing slash (which
 * would produce "//preview").
 */
export function runtimeBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_RUNTIME_URL ?? "").trim();
  if (!raw) return "http://localhost:3001";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The base URL a RESPONDENT link should use for one survey.
 *
 * `deployment.customDomain` has been in the schema since the first release
 * and was read by nothing: every link the Studio built came from one
 * environment variable, so a white-labelled study was white-labelled right up
 * to the domain in the address bar. Set it and the respondent-facing links —
 * live link, test link, the deploy response — use it.
 *
 * This is the SURVEY-facing half of a custom domain. Pointing the domain at
 * the runtime (DNS and a certificate) is still an operator step; what changes
 * here is that the platform stops contradicting the setting, and the panel
 * can say plainly what is left to do.
 */
export function surveyBaseUrl(customDomain?: string | null): string {
  const raw = (customDomain ?? "").trim();
  if (!raw) return runtimeBaseUrl();
  // a domain is typed by a human: tolerate a scheme, a trailing slash, and a
  // pasted path ("survey.acme.com/s/..." — keep the host, drop the rest)
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes(".")) return runtimeBaseUrl();
    return `${u.protocol}//${u.host}`;
  } catch {
    return runtimeBaseUrl();
  }
}
