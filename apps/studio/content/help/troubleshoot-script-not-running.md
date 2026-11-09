---
id: troubleshoot-script-not-running
title: JavaScript is not executing
category: troubleshooting
keywords: javascript not working, script not running, script not executing, js not working, custom code not working, jquery not working, script error
related: custom-scripts, script-status
---
## Likely causes
- **It is switched off** — imported scripts arrive off until reviewed.
- **Refused by the safety check** — it uses something unavailable (`window`, `document`, network, storage, `constructor`).
- **Its event or scope never happens** — a page-scoped script on another page, an on_change for a question it is not attached to.
- **Its “Run only when” condition is false.**
- **It throws** — an error stops it part-way.
- **on_complete** runs only at the end of a live or test interview, not in Preview.

## What to check
1. **Research Tools** → **Scripts** → **Check scripts**: the stage on the card says whether it was refused, never ran, failed (with the message) or ran.
2. Read the script's event, scope and **Run only when**.
3. **Programming** → **Logic** → **Logic trace** and the preview inspector show script logs and errors.

## How to fix
Rewrite browser-specific code with the script API (`get`, `set`, `setCalc`, `flag`, `error`…); attach the script to the right page or question; switch it on; and add a test case that checks its result.
