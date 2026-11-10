---
summary: How ResLens.ai generates research designs — the method library, sample, guided set-up and Describe it, the design file, and how it reaches the survey and the analysis
related: study-methodologies, maxdiff, choice-based-conjoint, custom-experimental-designs
status: available
example: none
---
# Research design generators: an overview

A **design generator** builds the experimental plan behind a choice or experimental study — which items each MaxDiff set shows, which product profiles each conjoint task compares, in which order concepts are seen. ResLens.ai generates the design, measures its quality, attaches it to the survey as a **design file**, and the respondent's screens and the analysis read it.

## Two kinds of method

| | Design-file methods | Study methodologies |
|---|---|---|
| What you get | a generated design file (tasks, versions, quality figures) | a complete block of programmed questions and analysis-plan items |
| Methods | MaxDiff, choice-based conjoint (incl. partial profile), adaptive CBC, menu-based conjoint, rating-based conjoint, custom experimental designs | Van Westendorp, Gabor–Granger, concept tests, Kano, brand funnel and every method in the [catalogue](study-methodologies) |
| Where | **Research Tools → Design Generators** | **Research Tools → Study design** (also from Design Generators' library) |

## From a method to results

::: flow How a design reaches the data
1. **Choose a method** — the library in Design Generators
2. **Configure** — Sample, Guided set-up, or Describe it (words or voice)
3. **Generate** — the design file, with its quality figures
4. **Attach** — the design question renders it, version by version
5. **Field** — each respondent gets one version
6. **Analyse** — the analysis reads the design with the answers
:::

## Set it up in the builder

::: steps Generate a design
1. **Open Research Tools → Design Generators** and pick a method in the library.
2. **Start from the worked sample**, or open **Guided set-up** (the generator's own settings with a live recommendation and its reasons), or **Describe it** in words or by voice.
3. **Generate Design File** — the design is built, checked and attached; its preview shows the first tasks and the quality figures (balance, D-efficiency, pairs together…).
4. **Use it on a question** — a MaxDiff or conjoint question renders the attached design; Intelligent Mode does all of this from "create a MaxDiff of these 10 features".
5. **Export** — the design downloads as JSON (and CSV) with its seed, so it can be reproduced.
:::

## Common mistakes

- **Regenerating a design after fieldwork starts** — answers already collected belong to the previous design; the Studio warns on a live survey.
- **Too many attributes for full-profile CBC** — use partial profile or ACBC.

## Troubleshooting

- *"This design is not feasible"* — the generator's own reason (too few items for the set size, every combination prohibited…) is shown; adjust the configuration.
