---
summary: Response quality and fraud detection — behavioural telemetry, a quality score and a separate fraud-risk score for every response, classification bands, strictness presets, every rule, custom rules, and the review in Data → Quality
related: data-and-downloads, testing-and-simulation, validation-rules
status: available
example: none
---
# Response quality and fraud detection

With **Response Quality Checks** on (**Survey Settings → Quality checks**), the runtime records behavioural metadata while a respondent answers — timing, focus, copy / paste counts, navigation, device class; never clipboard contents or a raw IP address — and every finished response is scored the moment it is submitted:

- a **quality score** (0–100, 100 = best) and, separately, a **fraud risk** (0–100, 100 = most suspicious);
- a **classification** from the risk bands — CLEAN, REVIEW, SUSPICIOUS, HIGHLY SUSPICIOUS, CRITICAL (by default from 20, 40, 60 and 80);
- an **explanation for every flag**: the observed value, the benchmark, the severity and what it contributed.

**Nothing is removed automatically** — decisions are yours, in **Results → Data → Quality**, and the downloads can use a clean dataset.

**Strictness** — relaxed, standard (recommended), strict, very strict, or custom — decides which rules run and their thresholds; open a category to tune any rule, or **reset** it to the preset. A rule can be **informational**: shown and costing quality points, but never moving the classification on its own (one shared IP address, a pasted answer). **Custom rules** are ordinary conditions over the quality metrics (for example `calc.SYSTEM_SPEEDER_SCORE > 60 AND calc.SYSTEM_ATTENTION_FAILED >= 1`) that add risk points, a quality penalty, or a minimum classification. Settings can be saved as a **quality profile** and applied to other surveys.

## Every rule

::: catalog quality-rules

## When to use it

- Online panels and open links, where speeders, straight-liners, bots and duplicates are expected.
- Incentivised studies, before paying out.
- Any study whose data will be cleaned: the flags explain every removal.

## Set it up in the builder

::: steps Switch on quality checks
1. **Open Survey Settings → Quality checks** and tick **Enable Response Quality Checks**.
2. **Quality strictness** — standard for most studies.
3. **Classification bands** — keep the defaults, or move them.
4. **Rules** — open a category to tune a rule; add a custom rule if needed.
5. **After fieldwork** — review flagged responses in **Data → Quality**.
:::

::: screen quality-settings

## Common mistakes

- **Treating a flag as a verdict** — a flag is evidence with its reason; review before removing.
- **Very strict on a small study** — timing benchmarks and share-of-completes rules need enough completes; below that they are judged against estimates.

## Troubleshooting

- *A rule never fires* — the telemetry it needs is switched off, or the strictness leaves it off (see “On in” above).
- *Everyone is flagged as fast* — the survey is shorter than its reading-time estimate assumes; tune the timing rule's threshold.
