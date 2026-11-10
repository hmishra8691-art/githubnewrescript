---
summary: Header and footer HTML on every page, the survey-wide custom CSS, and where scoped styles, animations and scripts live
related: custom-css, custom-javascript, custom-html-components, page-layout-and-logo
status: available
---
# Header and footer

Under **Branding → Code & custom**:

- **Header HTML** — shown above the survey on every page, **instead of the logo** when both are set.
- **Footer HTML** — shown below the survey on every page: a privacy notice, contact details, a support link.
- **Custom CSS** — survey-wide CSS for what the settings cannot do (see [Custom CSS](custom-css)).
- The survey's **styles, animations and scripts** — scoped to questions, options, pages or the survey (see [Custom JavaScript](custom-javascript)).

Header and footer HTML may contain ordinary markup, inline styles and links, and [piped text](piping). They **may not** contain scripts, frames, `<style>` or `<link>` tags, event handlers (`onclick=`) or `javascript:` links — those are refused. Behaviour belongs in scripts, where it is checked and contained.

## When to use it

- A privacy notice or support contact on every page.
- A study name, a wave or a client name beside the brand.
- A header more complex than a logo.

## Set it up in the builder

::: steps Add a header and a footer
1. **Open Branding → Code & custom**.
2. **Header HTML** — e.g. the study name.
3. **Footer HTML** — e.g. a privacy line with a link (`target="_blank"`).
4. **Check the preview** — both appear on every page.
:::

::: example theme-header-footer

## How it is stored

```json
{ "branding": {
    "headerHtml": "<div style=\"display:flex;justify-content:space-between\"><b>Lumen Research</b><span>Customer study 2026</span></div>",
    "footerHtml": "<p>Your answers are confidential… <a href=\"https://example.com/privacy\" target=\"_blank\" rel=\"noopener\">Privacy notice</a></p>" } }
```

## Common mistakes

- **Putting a script in the footer** — refused; use a survey script.
- **Header and logo together** — the header replaces the logo; put the logo image inside the header HTML if you need both.

## Troubleshooting

- *“may not contain scripts, frames, styles…”* — remove the `<script>`, `<style>`, `on…=` attribute or `javascript:` link.
