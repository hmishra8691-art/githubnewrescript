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
