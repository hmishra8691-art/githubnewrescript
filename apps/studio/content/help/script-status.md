---
id: script-status
title: Script status — generated, executed, validated
category: advanced
keywords: script status, did my script run, script validated, script executed, ai script, check scripts, script never ran, script failing
related: custom-scripts, simulated-respondents, troubleshoot-script-not-running
---
## What it does
Each logic script shows a stage, with the evidence for it:
- **Generated** — the code exists and passes the safety check (with who last wrote it: AI, person or import).
- **Executed** — it ran for simulated respondents through the real survey; failures are counted. “Never ran” means its event, scope or condition is never met.
- **Validated** — a passing test case checks the variable the script writes.

## How to set it up
1. Open **Research Tools** → **Scripts** and click **Check scripts**.
2. Read the stage on each script card. A stage is marked stale as soon as the survey changes; check again.
3. To validate a script, add a test case in **Research Tools** → **Tests** whose expected variables include what the script writes.

## Common mistakes
Treating “written by the AI” as “working” — only Validated means a test confirmed the result.
