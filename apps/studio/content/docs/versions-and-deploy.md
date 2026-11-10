---
summary: Versions and deployment — immutable versions on every save, comparing versions, deploying a version to a test or live link, and the script history
related: distribution-and-fieldwork, testing-and-simulation, projects-and-roles
status: available
example: none
---
# Versions and deployment

**Save version** (top right in the Studio) creates an **immutable snapshot** of the survey. A deployed link is **pinned to one version**: editing later never touches a live survey until you deploy again.

**Management → Versions & Deploy** shows:

- **Version history** — every version, its label, when it was saved and where it is deployed.
- **Script history** — every save that adds, edits, removes or switches a script, component code, custom CSS or header / footer HTML, with who did it and what the code check said — never the code itself.
- **Compare versions** — any two versions side by side.
- **Deploy** — pick a version, a client and study name for the link, and **test** or **live**. Test links are `/t/<client>/<study>`, live links `/s/<client>/<study>`.
- **Active deployments** — what is running where.

## When to use it

- Before fieldwork: deploy to **test**, share the test link with reviewers, then deploy the same version **live**.
- After a change in field: save a new version, compare it with the live one, then redeploy.
- Audits: the script history records every code change and its check.

## Set it up in the builder

::: steps Deploy a version
1. **Save version** — give it a label ("Soft launch").
2. **Open Management → Versions & Deploy**.
3. **Deploy → pick the version**, set the client and study names.
4. **Choose test**, deploy, and test the link.
5. **Deploy the same version live** when it is approved.
:::

::: screen versions

## Common mistakes

- **Editing and expecting the live link to change** — it is pinned; deploy the new version.
- **Testing on the live link** — test responses belong on the test link; they are stored apart and never count toward quotas.

## Troubleshooting

- *Deploy is not available* — deploying needs the **deploy** capability (Editor, Deployment manager, Project admin or Owner).
- *The live link still shows the old survey* — the new version was saved but not deployed.
