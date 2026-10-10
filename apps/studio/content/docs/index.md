# ReScript Studio — developer documentation

ReScript Studio is a survey programming platform: a visual editor, a JSON survey definition, a logic language, a scripting surface and an Intelligent mode in which a researcher programs the survey in plain language and approves every change. These pages describe how to program it — the way you would program Qualtrics, Decipher or Confirmit, but with the definition, the logic and the actions all open and documented.

Everything here is grounded in the platform's own code. The three reference pages (question types, logic reference, actions reference) are generated from it on every build, so they cannot drift.

## Start here

- **[Getting started](getting-started)** — the three ways to program a survey (the editor, the definition, Intelligent mode), a complete minimal definition, test and live links.
- **[The survey definition](survey-definition)** — the JSON model: meta, questions, options, flow (blocks, pages, branches, randomizers, loops, ends), calculations, embedded data, quotas, localization, research design.
- **[Question types](question-types)** — all 40 base types and 170 variants with their response models, capabilities and validations. *Generated.*

## Programming

- **[Logic and expressions](logic)** — conditions in text and in JSON, display and skip logic, validation rules, calculations and their functions, named expressions, set expressions and option masks, auto-punch (`IF … THEN SET …`), count conditions.
- **[Logic reference](logic-reference)** — every operator spelling, every calculation function, every piping property and format, the UX script API, the analysis vocabulary. *Generated.*
- **[Piping, lists and loops](piping-and-lists)** — `{{tokens}}`, carry-forward, option logic and list operations, randomization, List Fill, loops.
- **[Custom code](custom-code)** — HTML blocks, per-question HTML/CSS/JS, survey scripts and their API, the UX layer (styles, animations, behaviours) and its sandboxed `rs` API, branding code, what is sanitised.

## Intelligent mode and the Research Engine

- **[Intelligent mode](intelligent-mode)** — programming in sentences: what the engine reads by itself, what a language model is asked, the actions vocabulary, approval, history and rollback, the research workflow, internal and cloud execution, model tiers and the cost preview.
- **[Actions reference](actions-reference)** — the closed vocabulary of operations every change goes through, with their fields. *Generated.*
- **[The Research Engine](research-engine)** — the research design (objective, hypotheses, constructs, KPIs, audience), the analysis plan, coverage, enforcement, analysis runs and findings, the proposal, the findings report and the deck.

## Data and integration

- **[Data and exports](data-and-exports)** — what each question type stores, the export columns, datasets (clean, all, custom), CSV, Excel, SPSS, SAS, Stata and JSON, the variable dictionary.
- **[Localization and quotas](localization-and-quotas)** — languages, translation keys, routing, the glossary; quotas, cells, quota checks and quota variables in logic.
- **[HTTP API](api)** — authentication, the Studio routes by area with the capability each needs, the respondent runtime endpoints.

## For AI assistants

If you are an AI assistant helping someone program ReScript Studio: the survey is a JSON `SurveyDefinition` (see *The survey definition*); logic is written in the text language on *Logic and expressions* and compiles to the JSON `Condition`; every edit in Intelligent mode is one of the actions on the *Actions reference*, named by question code (`Q7`) or variable name (`AGE`); and sentences on *Intelligent mode* are read by the engine without a model. `llms.txt` at the site root lists these pages; `llms-full.txt` holds them all in one file.
