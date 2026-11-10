---
summary: Projects, collaborators and roles — who may open, edit, deploy, see data and manage a project, the edit lock, and custom per-module access
related: versions-and-deploy, data-and-downloads, distribution-and-fieldwork
status: available
example: none
---
# Projects, collaborators and roles

A **project** is the study around the questionnaire: who it is for, who runs it, when it is in field and when it is due (**Management → Project**). The questionnaire itself is under Survey Settings and the other Programming tools.

People join a project as **collaborators** (**Management → Collaborators**), each with a **role**. A role is a set of **capabilities** — open the project, edit the survey, save a version, deploy, see responses, download data, comment, manage collaborators. The same rules decide what the Studio shows and what every API route allows, so a control hidden from a role is also refused on the server.

Editing needs one more thing: the **edit lock**. One person edits at a time; others can ask for it, and roles with the right capability can take it over. Reading, reviewing, watching fieldwork and downloading data never need the lock.

## Every role

::: catalog roles

The **owner** is not granted — exactly one person owns a project; ownership is **transferred**. Only the owner can transfer or delete the project and set its budget. **Custom access** is chosen module by module (none, view, edit or manage per module).

## When to use it

- Giving an analyst the data without the right to edit (**Viewer with data**), or a deployment manager the right to publish without changing the programming.
- Letting a client review (comment, test) without changing anything.
- Letting a sample vendor follow fieldwork progress without seeing responses.

## Set it up in the builder

::: steps Share a project
1. **Open Management → Collaborators**.
2. **Invite** the person by email.
3. **Choose the role** — or **Custom access** and set each module.
4. **Optionally set an expiry** — access ends on that date.
5. **Change or remove** the role later from the same list.
:::

## Common mistakes

- **Making everyone an editor** — reviewers and test users can comment and test without being able to change the survey.
- **Expecting “viewer” to download data** — downloading is **Viewer with data** (or a role with data export).

## Troubleshooting

- *A button is missing* — your role lacks that capability; the project's owner or a project admin can change it.
- *“Someone else is editing”* — ask for the edit lock, or wait until they leave edit mode.
