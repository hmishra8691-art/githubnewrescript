---
id: embedded-data
title: Variables, embedded data and URL parameters
category: advanced
keywords: embedded data, variables, url parameter, hidden field, panel id, respondent id, query string, metadata, variable name, rename variable, export name, value labels
related: calculations, piping, termination, data-exports
---
## What it does
Embedded data holds values that are not answers: URL parameters from a panel (respondent id, source), values you set in the flow, or values a script writes. **Variables** lists every column your data will have — answers, calculations and embedded data — with names, labels and value labels.

## How to set it up
Capture a URL parameter:
1. In **Programming** → **Survey Flow**, click **+ Add element** at the top and choose **Embedded data**.
2. Add a field (**+ add field**), give it a **Variable name** and set **Value from** to **URL parameter** (or a **Fixed value**, an **Expression**…).
3. Respondents' links can now carry the value (for example `?pid=123`) and it is stored with their response.

Review and rename variables:
1. Open **Programming** → **Variables**.
2. Use **Rename** to rename a variable — every rule, pipe and expression that uses it is updated — and edit labels and value labels for exports.

## Common mistakes
- Adding the embedded data field after the point where it is used.
- Renaming a variable in an export tool instead of here, so the survey and the data disagree.
