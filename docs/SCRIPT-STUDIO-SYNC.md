# Script Studio: one source of truth

Intelligent mode, Question Studio and Branding all edit **the same survey
definition**. None of them keeps its own copy of the logic, the custom code or
the theme. The model proposes actions, the engine applies them through the
same gates the hand-edit panels use, and the runtime renders whatever the
definition says.

```
Intelligent mode ─┐                         ┌─ Question Studio → Properties
 (copilot actions) ├─► engine gates ─► def ─┤   Research tools → Branding
Branding assistant ┘  (surveyActions,       └─ runtime / previews
                       uxActions, theme)
```

## 1. Conditions compare option codes

`Q3 = 1` is the canonical form everywhere: the builder, the parser, stored
JSON, the printed expression and runtime evaluation. The option's text is for
people to read; it is never what gets stored.

- **`packages/engine/src/optionCodes.ts`**
  - `resolveOptionValue(options, v)` resolves, in this order:
    1. the code itself;
    2. a quoted or emphasised code (`"1"`, `__1__`);
    3. a unique label, ignoring markup, entities, `__x__`/`**x**`, quotes and case;
    4. *Other* for an other-specify option;
    5. `Option N`, `O2` or `#2`, read as code N if there is one, else the Nth option.

    A label that two options share is refused, never guessed.
  - `canonicalizeCondition(def, cond)` rewrites every option value to its code.
    - A multi-select is a list answer: `=` becomes *selected*, `in` becomes *contains any*, and so on.
    - It reports anything it cannot resolve, naming the question's real codes.
  - `canonicalizeSurveyConditions(def)` is the stored-survey repair. It walks
    every condition in the definition (display, skip, branch, punch, quota,
    option/row visibility) but skips `ux`, `branding` and `meta`.
- **Where it runs:**
  - `parseLogicExpression`, after a successful parse. A change becomes a warning ("Read as the option code…"); an unresolved value becomes an error.
  - The Studio store's single write point (`update`/`replace`). Every writer (the JSON tab, imports, the copilot, older panels) stores codes, with a toast when something was rewritten.
  - A one-time repair when a writable survey loads.
- **The model is told the same thing:**
  - The prompts say "OPTION VALUES ARE OPTION CODES".
  - The survey context lists `1=Yes, 2=No` with markup stripped, and prints existing logic as `Q3 = 1`.
  - The grammar keeps "option 3" as `"option 3"` so the parser can resolve it against the question.

## 2. Punching

- `add_punch` and `remove_punches` are copilot actions over the existing
  `PunchRule`. The target is a question or variable, and codes resolve by label.
- `SET QH = value` in the expression form selects an option code on a choice target and sets a value otherwise.
- `punchDerivedQuestions` codes hidden or calculated questions on every
  navigation step, so a variable that is never on a page still gets its value.
- Embedded-data fields are **not** punch targets. Use a hidden variable.

## 3. Custom CSS / JS / HTML

- Everything lives in `def.ux` (styles, animations, behaviours, sandboxed scripts) and `question.customHtml`.
- `components/studio/UxItemsEditor.tsx` shows the items for a scope and edits them in place through `validateUxItem`. A bad edit is refused and its reason shown.
  - Scopes: survey, block, page, question, option.
  - Mounted in: Properties ("Styles, animations & scripts"), the option panel, the page and block editors in Survey Flow, and Branding (survey-wide).
- When the copilot changes an item it updates the same id, and Properties shows the new value.
- `set_custom_html` (a copilot action) writes `customHtml`. Scripts, frames, styles, `on*` handlers and `javascript:` are refused.

## 4. Theme

- **The theme is `def.branding`.** The schema gained, all optional:
  - `background`, `appearance` and `responsive.{tablet,mobile}`;
  - typography `headingFont`, `lineHeight`, `letterSpacing` and `questionSize`.
- `set_theme` (a copilot action, look-only) patches branding through
  `applyThemePatch`. Each field has its own gate. `null` resets a field. The
  result is checked against the Branding schema, and `diffTheme` lists the
  changes line by line.
- **Branding panel:**
  - **Design with AI:** a text or image request, a proposed theme in the live preview, nothing saved until *Apply*.
  - **Background.**
  - **Cards, options, radio buttons & inputs.**
  - **Tablet & phone.**
  - Desktop, tablet and phone buttons on the preview.
- **Theme image:**
  - An uploaded image is downscaled, and its dominant colours and a
    contrast-checked palette are derived from it.
  - The model sees only the colours and a `{{THEME_IMAGE}}` placeholder; the server
    substitutes the image's address.
  - The same attachment is available in Intelligent mode (Attach → Theme image).
- **Renderer:**
  - `brandingVars`, `brandingClasses`, `pageThemeVars` (the page background and font on `<html>`) and `brandingResponsiveCss`.
  - The same functions are used by the runtime, the Branding preview and the copilot's UX preview.
  - A question-scoped UX style is more specific than the theme and wins on that question.

## Regression

`scripts/codes-sync-test.mjs` covers the brief's 20 steps, from builder
→ stored code → runtime through Intelligent mode ⇄ Properties ⇄ Branding
on desktop, tablet and phone. The engine tests are `optionCodes.test.ts` and
`theme.test.ts`; the studio tests are `copilot.test.ts` and
`intelligent.test.ts`. Every new branch is mutation-checked.

## Known limits

- The Branding assistant's changes can be undone (⌘Z) but are not listed in the copilot History.
- A theme proposal in Branding is dropped if you leave the tab before applying it.
- Hand-written `customJs` (the older Custom code field) runs unsandboxed, as before.
