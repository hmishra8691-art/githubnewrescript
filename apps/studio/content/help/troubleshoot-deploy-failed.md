---
id: troubleshoot-deploy-failed
title: Deployment failed or respondents see an old version
category: troubleshooting
keywords: deployment failed, deploy failed, cannot deploy, publish failed, respondents see old version, live link old, changes not live
related: deploy-versions, collaborators-permissions
---
## Likely causes
- **Not published** — your edits are in the draft or a saved version that is not on the live link (the bar at the top says the live link runs an older version).
- **The edit lock** is held by someone else, or you are in read-only mode.
- **The survey has errors** that block a version — open the logic checks.
- **The wallet is read-only** — a project at its read-only threshold may stop taking live interviews.
- **Permissions** — your role may not include deploying.

## What to check
1. **Management** → **Versions & Deploy**: **Active deployments** shows which version each link runs.
2. The message shown when it failed; **Programming** → **Logic** → **Logic check** for blocking errors.
3. **Management** → **Usage & Wallet** for the project's state.

## How to fix
**Save version**, then deploy or **Publish** it; ask the lock holder to release editing; fix blocking errors; top up or raise the spending limit. If it still fails with a server error, contact support with the survey code.
