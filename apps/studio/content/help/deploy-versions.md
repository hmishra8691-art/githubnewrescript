---
id: deploy-versions
title: Save versions, deploy and publish to live
category: project
keywords: deploy, publish, go live, launch, live link, new version, version history, rollback, restore version, compare versions
related: test-and-preview, collaborators-permissions
---
## What it does
Every saved version is an immutable snapshot. Deploying puts a version on a link (test or live); publishing replaces what live respondents get with your latest version. Your draft autosaves, but respondents only ever see a deployed version.

## How to set it up
1. Click **Save version** in the top bar to save an immutable snapshot (the version number is assigned for you).
2. Open **Management** → **Versions & Deploy**. **Version history** lists every version with what it is deployed to; **Compare versions** shows what changed.
3. Under **Deploy**, choose the version and the link, then **Deploy**. **Active deployments** shows what each link runs.
4. When the live link runs an older version than the one you are editing, a bar at the top says so — use its **Publish** button to put your current version live.

## Common mistakes
- Editing and expecting live respondents to see it immediately — they see the deployed version until you publish.
- Restoring an old version replaces what is in the editor; save your current work as a version first.

## Alternatives
Use **Test Survey** to deploy to the test link automatically while you are still checking the survey.
