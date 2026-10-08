/**
 * HTML TYPED AS TEXT (07-10-2026 review, Oweas #2).
 *
 * A Text / HTML block's content is written in the one text editor (06-10 R2).
 * Its Visual tab is a word processor, so `<b>Welcome</b>` typed into it is
 * text about a tag — stored as `&lt;b&gt;Welcome&lt;/b&gt;` and shown to the
 * respondent as code. On an HTML block that is never what the author meant.
 *
 * `typedMarkup` finds content that holds escaped tags; `decodeTypedMarkup`
 * turns them back into markup (the caller sanitises the result exactly as any
 * HTML written in the HTML tab is sanitised). Escaped text that is not a tag —
 * "5 &lt; 7" — is left alone.
 */
const ESCAPED_TAG = /&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*?)?)(\/?)&gt;/g;

export function typedMarkup(html: string | null | undefined): boolean {
  if (!html) return false;
  ESCAPED_TAG.lastIndex = 0;
  return ESCAPED_TAG.test(html);
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

export function decodeTypedMarkup(html: string): string {
  return html.replace(ESCAPED_TAG, (_m, close: string, name: string, attrs: string, self: string) =>
    `<${close}${name}${decodeEntities(attrs ?? "")}${self}>`);
}
