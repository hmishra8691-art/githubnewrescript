---
summary: Translation and localization — languages over one survey, AI or manual translation, review and approval, glossary, voice and audio, QA checks, language routing and import / export
related: localization-and-quotas, piping, buttons-and-navigation
status: available
---
# Translation and localization

A translated survey is **one survey**: one set of questions, codes and logic, one dataset. Every language is text (and optional audio) over the same structure, and the `SURVEY_LANGUAGE` variable records which language each respondent answered in.

**Research Tools → Translation** has: **Languages** (add, remove, status), **Translate** (each element's source beside its translation, with **Translate all**, **Translate selected** and **Re-translate outdated**), **Glossary** (preferred terms, and brand names never translated), **Voice / Audio**, **QA**, **Routing** (which language a respondent gets: the link, an embedded field, the country, rules; whether they may switch), **Import / Export** and **Settings**. The **translation mode** is hybrid (AI first, then review — recommended), AI or manual.

Each translation has a **status** — machine translated (AI), edited, reviewed, approved — and becomes **outdated** when its source text changes. **QA** checks for missing translations, piping or placeholders that differ from the source, wrong script, broken HTML, options that would share one translation, and text much longer than its source.

## When to use it

- Multi-country studies, with one dataset across languages.
- Bilingual markets, letting respondents switch language.
- Voice surveys in several languages (audio per language).

## Set it up in the builder

::: steps Add a French version
1. **Open Research Tools → Translation → Languages** — **Add languages**: French.
2. **Translate → Translate all** — or type translations yourself.
3. **Review** — edit where needed, then mark **reviewed** or **approve**.
4. **QA** — fix anything blocking.
5. **Routing** — decide how respondents get French; **Preview in** French.
:::

::: example translation

## How it is stored

```json
{ "localization": { "languages": [{ "code": "fr", "locale": "fr-FR", "status": "draft", "enabled": true }],
  "translations": { "fr": { "q:q_1:text": { "text": "Laquelle de ces propositions vous décrit le mieux ?", "status": "ai" } } } } }
```

In Intelligent Mode the same work is the localization actions — `add_language`, `set_translations`, `approve_translations`, `set_glossary`, `set_language_routing`.

## Common mistakes

- **Translating the codes** — codes and variable names are shared by every language; only the texts are translated.
- **Editing the source after translating** — the translations become outdated; re-translate or confirm them.

## Troubleshooting

- *A translation is refused* — its piping (`{{BRAND}}`) or HTML differs from the source, or it is written in the wrong script.
- *Respondents still see the source language* — check the language's status and the Routing rules.
