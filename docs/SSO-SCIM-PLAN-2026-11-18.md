# Single sign-on and SCIM: plan and decisions needed (audit P1-07)

Two-step sign-in (TOTP) is built: patch 0187 and migration 0099, which is written but not applied. SSO and SCIM are
not built yet. Both depend on one decision from the owner: **where identities come from**.

## How sign-in works today

- The Studio verifies the password through Supabase Auth (`verifyPassword` in `lib/authServer.ts`).
- It then creates its OWN session row (`user_sessions`, via `rescript_login`). That row carries the single-session
  rule, idle and absolute timeouts, and revocation.
- `requireUser` reads that row on every request. Supabase's own session is not used after sign-in.

This means SSO can be added at one point: anything that proves who the person is can end in `rescript_login`, and
every later check stays the same.

## Options for SSO

| Option | What it needs | Effort | Notes |
| --- | --- | --- | --- |
| A. Supabase Auth SAML SSO | Supabase Pro plan or higher; each customer's IdP metadata registered with the Supabase CLI (`supabase sso add`) | about 5 days | Same provider as passwords today. Supports Okta, Entra ID, Google Workspace and OneLogin through SAML 2.0. |
| B. Supabase Auth OIDC providers | Enable Azure / Google / Keycloak providers in the dashboard; client ids and secrets | about 3 days | Simplest, but one tenant per provider configuration. Fine for "sign in with Microsoft" across all customers; weaker for per-customer IdPs. |
| C. An identity broker (WorkOS, Auth0, Clerk) | A contract and keys | about 7 days | Per-customer SAML/OIDC and SCIM in one service, plus an admin portal for the customer's IT team. |

**Recommendation:** use C if enterprise customers will each bring their own IdP and want SCIM. Use A if there are
only a few such customers and staying on one provider matters more.

## What gets built once the choice is made

1. `/api/auth/sso/start?workspace=…` redirects to the IdP. `/api/auth/sso/callback` verifies the assertion
   (provider SDK), maps the email to a profile (or creates one), checks the workspace's verified domain, and calls
   `rescript_login`. It is audited as `user.logged_in` with `method: "sso"`.
2. A per-workspace setting "SSO required": password sign-in is refused for that workspace's members, except
   platform administrators, who keep break-glass access with TOTP.
3. SCIM 2.0 (`/scim/v2/Users`, `/Groups`) with a per-workspace bearer token. The token is hashed at rest, using the
   same key machinery as the public API keys (P2-13). Provisioning creates profiles. Deprovisioning sets status
   to disabled and ends sessions, which the account route already does for "disable".

## Acceptance (from the audit)

"SSO login works with two IdPs; MFA enforced." MFA enforcement is done. The two-IdP test needs the provider choice
and test tenants (for example an Okta developer org and an Entra ID test tenant).
