# BYOK 5 — Settings guide (for researchers)

**Where:** Account → **AI & Integrations** (`/settings/ai`, titled *AI Provider Configuration*), also in the account menu.

## What you can choose

Four features, each independently provided by the **Platform AI** (default, billed to your wallet as usual) or **My own provider** (you pay that provider directly; the Studio charges nothing for it):

- **Intelligent Mode** — the editing copilot, research plans, document summaries.
- **Other AI features** — rephrase, logic, import, analytics interpretation and Ask, report and story wording, speech synthesis.
- **Speech-to-text** — voice instructions and recordings in the media pipeline.
- **Translation** — the Translation Manager.

Respondent-facing and interview AI **always** runs on the platform's AI and never uses your keys. Nothing switches silently.

## The seven sections

1. **Overview** — one row per feature: who provides it, the configuration in words, the last test, *Configure*; why own-provider is unavailable if it is.
2–5. **Intelligent Mode · Other AI features · Speech-to-text · Translation** — one editor each (below).
6. **Saved API keys** — every key as a mask, which features use it, last test, added/replaced; **Add / Replace / Remove**.
7. **Usage & cost** — own-provider volumes (no money), platform charges (your wallet), never added together.

## Setting up your own provider

1. Open the feature's section, choose **My own provider**.
2. Choose the **provider**. Switching provider clears the previous one's address, model, identifiers and key.
3. Fill any **identifiers** asked for (organization, project, workspace, Azure region).
4. Paste the **API key** (the field is never prefilled; saved keys appear as masks, and only keys of the same vendor are offered).
5. Choose a **model** — **Find models** lists what *your key* can use; ★ marks models suited to Intelligent Mode. (Translation services have no model.)
6. Optionally add up to three **fallbacks** (each with its own key) and decide on the **platform last resort** — off by default; if ticked, a rescued call is billed to your wallet as platform usage.
7. **Test connection** — the answer is in words ("Connection works (84 ms)", "key rejected", "no credit", "model not found"…) and never shows the provider's text or your key. For a chat model it also says whether JSON mode works.
8. **Save**. Unsaved work is marked on the field, the section, the page banner and the navigation dot, and the browser asks before you leave.

## Keys

- **Replace** swaps the secret behind the same entry; features keep working; its test is cleared.
- **Remove** lists the features that will return to the platform's AI and the fallbacks that will be dropped, and asks you to confirm.
- Returning a feature to the platform asks twice and says what is cleared; keys are kept.

## When something is wrong

Failures on your own provider are yours to fix and say so: "Your AI provider rejected your key", "usage limit reached", "model not found". A card "Your AI provider is not ready" gives the reason and where to fix it. If your workspace administrator turned user-managed AI off, you cannot save a user-managed setting and a saved one is refused with that sentence — nothing is deleted.

## Projects

A project owner can choose whose AI the project uses: **Platform** (everyone uses the platform's), **Each person's own** (everyone's calls go to *their own* provider; a member with none is told so), or follow each person's setting. See 7.
