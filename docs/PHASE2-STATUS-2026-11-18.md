# Phase 2 (core engine improvements) — status, 2026-11-18

Patches 0167–0170. All five phase-2 items are closed: four in code, one by a recorded decision.

| ID | Patch | Outcome |
| --- | --- | --- |
| P1-03 Field actions for scripts | 0167 | `rs.lock` / `rs.unlock` (never a required unanswered question), the `lock` / `unlock` behaviour effects, and `rs.field(code)` as one handle per field. Browser-proven. |
| P1-10 Interviews app tests | 0168 | `pnpm test` exists for apps/interviews, with roles, tokens and input readers covered (4 tests). Route tests with a database double are the next step. |
| P1-05 Editor signals | 0161 + 0169 | Save banner fixed in phase 1. Entities decoded at 37 display sites through one engine helper. |
| P1-04 Browser matrix | 0170 | The respondent path on Chromium, Firefox and WebKit, each on desktop and two phones, in CI. Run here on Chromium only (3/3); the other two first run in CI. |
| P2-04 Risk-based replay | — | **Not needed.** Under the `log` posture every final save already replays the whole interview, so every completed response is checked; `enforce` and `RECOMPUTE=store` replay every save. Only abandoned partials go unreplayed, and they are not in a completed dataset. |

## Corrections to the audit

- **The script layer was under-described.** The audit said generated JavaScript had "no typed API" and reached
  into the DOM. In fact:
  - scripts already run in a sandboxed frame with the `rs` API (checked write requests, show / hide, messages,
    validate);
  - `document` there is a mirror;
  - a static gate refuses dangerous globals.

  The real gaps were the lock action and a per-field handle, both added in 0167.
- **ERR-14 (sampled replay) is not a live risk**, for the reason given in the P2-04 row above.

## Gate for phase 3

The audit's gate is "browser matrix green; top 20 script patterns on the field API".
- **Browser matrix:** green on Chromium, pending the first CI run on Firefox and WebKit.
- **Script patterns:** the existing patterns already use the sandboxed `rs` API (see Corrections), so there is
  nothing to migrate.

Known pre-existing failure: the Studio half of `ux-script-dom-test` times out waiting for an Intelligent Mode
turn. It fails at the same step with these changes removed, so it is not caused by them. It should be looked at in
phase 3, which works on Intelligent Mode.
