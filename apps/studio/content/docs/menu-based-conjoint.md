---
summary: Menu-based conjoint — respondents tick the items they would buy from a priced menu; prices vary by task; take rates, bundles and revenue
related: choice-based-conjoint, adaptive-cbc, gabor-granger
status: available
---
# Menu-based conjoint (MBC)

**What it is.** Each task shows a **menu** of optional items with prices — add-ons, options, à-la-carte extras — and the respondent ticks what they would buy. Prices change from task to task, so the analysis can estimate each item's **take rate at each price** and simulate bundles and revenue.

## When and why to use it

- Add-ons and options priced separately (data packs, insurance, extras).
- Configurators where customers build their own bundle.
- Needs a larger sample (about 300+).

## Configure the design

::: steps Create a menu-based conjoint
1. **Design Generators → Menu-based conjoint (MBC)**, or "create a menu-based conjoint for these add-ons" in Intelligent Mode.
2. **Items and price points** — each item with 2–4 prices.
3. **Required items** — a base that is always included (shown locked, counted in the total).
4. **Exclusive sections (optional)** — one-of groups ("choose one storage size").
5. **Tasks and versions** — e.g. 6–8 tasks, 10 versions; a None option.
6. **Pricing configurator (optional)** — the question shows a live total.
:::

::: example menu-conjoint

## The generated design

One row per item per task: `version, task, item, item_label, price, price_index, price_value, required`. Its summary shows how often each price of each item is used (balanced: 20 times each here).

## What the respondent does

Ticks the items they would buy at the prices shown (with a running total in configurator mode), then the next task with new prices.

## Output and analysis

Exported per task and item. The conjoint analysis estimates item logits — the take rate for each item by price — and the menu simulator answers "what share takes insurance at $9?", "what is the bundle's take rate?", and revenue per scenario.

## Common mistakes

- **Too many items** — a long menu turns into a checklist; keep to the items that matter.

## Troubleshooting

- *A required item cannot be unticked* — that is by design: it is the base of the menu.
