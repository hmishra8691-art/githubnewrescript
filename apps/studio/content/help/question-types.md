---
id: question-types
title: Question types and their settings
category: studio
keywords: question type, single choice, multiple choice, multi select, grid, matrix, open end, text, numeric, slider, ranking, NPS, rating scale, change question type
related: create-survey, validation-rules, display-logic
---
## What it does
Each question has a type that decides how it is answered and what it stores: single and multiple choice, grids (matrix), open text, numeric, sliders, ranking, NPS, constant sum, media, maps and more. The full list with every variant, response model and validation is on the reference page **Question types**.

## How to set it up
1. In **Programming** → **Questions**, click **+ Add question** and choose its type.
2. Select the question. The properties panel on the right shows the settings for that type — answer options, **Required**, **Min selections** / **Max selections** for multiple choice, number format for numeric questions, and the logic sections (**Display logic**, **Skip logic**, **Validation rules**, **Randomization**, **1 · Copy the list from another question (carry-forward)**).
3. To change a question's type, use the type selector on the question; ResLens.ai shows what will change (options or rows a new type cannot use) before applying it.

## Common mistakes
- Using a multiple-choice question where only one answer makes sense — the data then needs recoding.
- Changing type after logic refers to the question: review rules that compared against the old options.

## In Intelligent Mode
Describe it: “Add a 0–10 likelihood-to-recommend question after Q4” — Intelligent Mode proposes the question and you approve it.
