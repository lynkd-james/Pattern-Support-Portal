# Stage 8a — Entra ID Authentication (design note)

Status: APPROVED & IMPLEMENTED (Stage 8a). Implements CLAUDE.md §10 Stage 8 auth
with the architecture-review amendments (2026-07-04). Principle: **Entra authenticates;
the portal DB authorises.** Unprovisioned identities are denied. The client never
sends an account id (invariant #3); `RequestScope` and `customer/queries.ts` are
unchanged.

## Topology & app registration

- **Multi-tenant** app registration (`organizations` authority), dedicated to
  portal sign-in (delegated `openid profile email`). The existing app-only Graph
  mail app is untouched.
- Authorization-code flow + PKCE via `@azure/msal-node` (confidential client).
  `response_mode=query` (top-level GET redirect → SameSite=Lax cookies are sent).
  Entra tokens are used at login only and **never stored**.

## Identity model (tenant pinning — Amendment 1)

`portal_users` gains two columns:

| Column            | Set when                | Meaning                                        |
| ----------------- | ----------------------- | ---------------------------------------------- |
| `entra_tenant_id` | **provisioning** (admin) | The client's Entra tenant. Required for login. |
| `entra_object_id` | first successful login   | Immutable identity binding within that tenant. |

**Shared tenants are supported.** Nothing assumes tenant-id uniqueness: an
umbrella group with one Entra tenant covering several client codes (e.g. one
SG tenant across multiple accounts) simply provisions the same
`entra_tenant_id` on users of different accounts. The only uniqueness is
`(tid, oid)` across all portal users — i.e. **one Entra identity maps to
exactly one portal user (one account)**. A group contact needing visibility
across several accounts is the future account-grouping requirement (CLAUDE.md
§10), not something to fake with duplicate identities.

**Per-user (not per-account) tenant id — justification:** the security property
is identical (a user can only ever match against the tenant explicitly
provisioned on their own row), while per-user keeps flexibility for legitimate
cross-org identities under one account (e.g. an external consultant or a Pattern
staff member given a client-scoped portal user). Uniformity within an account is
an onboarding convention, checked by eye at provisioning, not a schema constraint.

Onboarding a client user now requires capturing their **Entra tenant ID (GUID)**
alongside email + account + BU grants. **Provisioning workflow:** insert the user
row `is_active = FALSE` when the tenant GUID is not yet in hand (or directly
active when it is), and activate it once the tenant ID is captured. A row with
`entra_tenant_id` NULL can never log in (denied at step 5 below), and the
`db:verify` invariant is scoped accordingly: **every ACTIVE portal user must
have a non-NULL `entra_tenant_id`** — a pending/inactive row without one is a
legitimate onboarding state, not a failure.

## Token-validation flow (callback), in order

1. **CSRF/state**: `state` from the query must equal the value in our short-lived
   (10 min) httpOnly `pattern_auth_flow` cookie set at `/api/auth/login`
   (holds `state`, `nonce`, PKCE verifier; deleted after use). Mismatch → deny.
2. **Code exchange** via msal-node against `organizations`. The ID token's
   **trust anchor is the authenticated back-channel TLS exchange with the
   token endpoint** — the token is received from Microsoft directly and never
   transits the browser, so its integrity does not rest on local signature
   validation. Claim-level checks (below) are ours.
3. **Nonce**: ID token `nonce` must equal the value issued in step 1. Mismatch → deny.
4. **Required claims**: `tid` and `oid` must both be present and non-empty
   (Amendment 1) and `iss` must be `https://login.microsoftonline.com/{tid}/v2.0`
   (issuer/tid consistency). Missing/inconsistent → deny.
5. **Resolution — bound path first**: look up active `portal_users` by
   `(entra_tenant_id = tid AND entra_object_id = oid)`.
   Found → step 7. **Email is never consulted for a bound user.**
6. **Resolution — first-login path** (only when no oid binding exists):
   match active `portal_users` where `entra_object_id IS NULL`
   AND `email = token email claim` (citext; the `email` claim only —
   `preferred_username` is mutable/attacker-shapeable and is not used; no email
   claim → deny) AND **`entra_tenant_id = tid`** (tenant pinning — an email match
   from any other tenant is denied outright).
   **`xms_edov` gate**: the app registration requests `xms_edov` as an optional
   claim. If present and `false` → deny. If absent → proceed, logged. Rationale:
   tenant pinning is the primary control — the nOAuth-style takeover requires a
   *foreign* tenant asserting our customer's email, which pinning eliminates;
   within the pinned tenant, that tenant's admin is authoritative for its own
   users' emails. `xms_edov` is therefore defence-in-depth, not load-bearing,
   and its emission is not guaranteed on all tenant configurations.
7. **Active checks**: `portal_users.is_active` AND the owning `accounts.is_active`
   must be TRUE → else deny.
8. **Bind & admit**: on the first-login path, set `entra_object_id = oid`
   (unique `(tid, oid)` index makes double-binding impossible). Update
   `last_login_at`; audit success; create session (below); redirect.

**Every identity denial** (any failure after a successfully validated token)
returns the same information-free 403 page (no distinction between unknown
email, wrong tenant, inactive user — Amendment 4) and writes an `audit_events`
row (`change_source='PORTAL'`, `field='login_denied'`) recording `tid`, the
internal reason code, and a **truncated SHA-256 (12 hex chars) of the claimed
email** — repeated denials from an unknown `tid` are attack telemetry.

**Flow-level failures** (missing/expired flow cookie, `state` mismatch, an
Entra `error` parameter, failed code exchange) are a separate surface: they
carry no validated claims to audit, are usually benign/retryable (back button,
cookie timeout, cancelled consent), and redirect to `/login?error=auth`. They
are server-logged as `login_flow_failed` with the reason — **the frequency of
these log events is future alerting telemetry** (a spike suggests probing or a
broken flow), not audit data.

**Redirects**: the post-login target is **fixed to `/dashboard`**. No
return-URL parameter exists anywhere in the flow (no open-redirect surface).

## Sessions (Amendment 3)

DB-backed, in the existing `portal_sessions` table. Cookie
`pattern_portal_session`: random 256-bit token (base64url), **SHA-256 stored**,
httpOnly / Secure / SameSite=Lax / Path=/.

Validity is enforced **at session resolution, on every request** — the cookie's
`Max-Age` is a UX convenience only and is never the enforcement mechanism (a
replayed or client-manipulated cookie past its nominal age still fails the
server-side checks). A session is ACTIVE iff **all** hold at request time:

- `revoked_at IS NULL`
- `now < created_at + SESSION_MAX_HOURS` (absolute cap; default **720 h**;
  `expires_at` stores this deadline for indexing/cleanup)
- `now < last_seen_at + SESSION_IDLE_HOURS` (sliding idle; default **8 h**;
  `last_seen_at` refreshed on use, throttled to one write per 5 min)
- the joined `portal_users.is_active` AND `accounts.is_active` are TRUE —
  checked **on every request**, so deactivating a user kills live sessions
  immediately.

```
                 ┌──────────────────────────────────────────────┐
 login success → │                   ACTIVE                     │
                 └──┬───────────────┬───────────────┬───────────┘
        idle > IDLE_HOURS   age > MAX_HOURS   logout / user deactivated
                 ▼                 ▼                 ▼
           EXPIRED_IDLE     EXPIRED_ABSOLUTE     REVOKED / DEAD
                 └───────────────┴────────┬────────┘
                                          ▼
                     purged by cleanup job (Stage 8b pipeline)
```

Logout (`POST /api/auth/logout`) sets `revoked_at` and clears the cookie.
Cleanup (8b) deletes rows expired/revoked for > 7 days.

## Enforcement boundary (Amendment 2)

- **The session layer is the security boundary.** Every API route already calls
  `getSessionProvider().getScope()` before touching data; `EntraIDSessionProvider`
  makes that call fail with a typed `UnauthenticatedError` → mapped to
  `401 {code:"UNAUTHENTICATED"}`. No route returns data on middleware's word.
- Middleware does **cookie-presence redirects for pages only** (UX). It performs
  no DB work (edge runtime has no pg pool) and is never trusted.
- CVE-2025-29927: repo is on **Next.js 14.2.35**; the 14.x fix landed in
  14.2.25 → patched. (Verified from `web/package.json`.)

## Provider swap

`getSessionProvider()` switches on `AUTH_PROVIDER`:
`placeholder` (dev default) | `entra`. Fail-fast guard: in
`NODE_ENV=production`, `placeholder` refuses to start unless
`ALLOW_PLACEHOLDER_AUTH=true` is set explicitly.

New env (all server-only, grouped accessor `requirePortalAuth()`):
`AUTH_PROVIDER`, `AUTH_ENTRA_CLIENT_ID`, `AUTH_ENTRA_CLIENT_SECRET`,
`AUTH_ENTRA_AUTHORITY` (default `https://login.microsoftonline.com/organizations`),
`PORTAL_BASE_URL` (redirect URI base), `SESSION_IDLE_HOURS=8`,
`SESSION_MAX_HOURS=720`, `ALLOW_PLACEHOLDER_AUTH`.

## Migrations

`scripts/db/migrate.ts` is extended: the `schema_migrations` ledger stays;
`schema.sql` remains the authoritative DDL for **fresh** installs and is applied
once (baseline). After the baseline, every `scripts/db/migrations/*.sql` file is
applied in filename order, checksummed in the ledger (re-run = no-op; edited
applied file = hard error). Migration files are written **idempotently**
(`IF NOT EXISTS`) so they no-op on a fresh install whose `schema.sql` already
contains the change. A baseline `schema.sql` checksum drift is informational
(evolution happens via migrations), no longer a hard error.

`scripts/db/migrations/0001_entra_identity.sql` (also folded into `schema.sql`):

```sql
-- Stage 8a: Entra ID identity binding (tenant pinned at provisioning time).
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_tenant_id TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS entra_object_id TEXT;

COMMENT ON COLUMN portal_users.entra_tenant_id IS
  'Entra tenant GUID captured at PROVISIONING time. Login requires token tid = this value. NULL = cannot log in.';
COMMENT ON COLUMN portal_users.entra_object_id IS
  'Entra oid bound on first successful login; sole login key (with tid) thereafter.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_users_entra_identity
  ON portal_users (entra_tenant_id, entra_object_id)
  WHERE entra_object_id IS NOT NULL;

-- magic_link_tokens is RETIRED (kept for now; never read or written).
```

## db:verify additions (structural, count-agnostic)

- every **active** portal user has `entra_tenant_id` (Amendment 1)
- every active portal user belongs to an **active** account
- every active non-`account_wide` user has ≥ 1 BU grant
- no `portal_user_business_units` grant crosses the user's account
- (uniqueness of `(tid, oid)` is enforced by the partial unique index)

## Error envelope sanitisation (in scope for 8a)

API routes previously returned raw `err.message` to clients (verified in
production: Postgres relation errors reached the browser). All API routes —
including the new auth routes — now map unexpected errors to a **generic
client-facing message** (`{code:"INTERNAL", message:"An unexpected error
occurred."}`) while the detail is logged **server-side only** as structured
JSON. Auth failures especially never leak internals: the deny page and 401
envelope carry no reason detail.

## Scope of the 8a commit

Migration runner + migration; `env.ts` additions; `/login` page;
`/api/auth/login|callback|logout`; `EntraIDSessionProvider` + factory switch +
401 mapping; page-level middleware (UX only); client 401 → `/login` redirect;
**removal of legacy probe routes** `/api/clickup`, `/api/clickup/user`,
`/api/ping`; **error-envelope sanitisation across all API routes**;
provisioning documentation (incl. capturing tenant ID);
`db:verify` invariants; docs updates (CLAUDE.md §10, `.env.example`,
data-model-v2.md magic-link reconciliation note).

## Provisioning portal users (admin runbook)

Provisioning is an administrative `INSERT` (no UI yet). **Capture the client's
Entra tenant ID (GUID)** — Entra admin center → Overview → Tenant ID, or ask the
client's IT contact. If the GUID is not yet in hand, insert with
`is_active = FALSE` and activate once captured.

```sql
-- Account-wide user (sees every BU of the account):
INSERT INTO portal_users (account_id, email, display_name, account_wide, entra_tenant_id, is_active)
VALUES (
  (SELECT id FROM accounts WHERE slug = 'pnp'),
  'jane.doe@pnp.example',
  'Jane Doe',
  TRUE,
  '11111111-2222-3333-4444-555555555555',  -- client's Entra tenant GUID
  TRUE
);

-- BU-scoped user: account_wide = FALSE plus explicit grants:
INSERT INTO portal_user_business_units (user_id, business_unit_id)
SELECT u.id, b.id
  FROM portal_users u, business_units b
 WHERE u.email = 'jane.doe@pnp.example'
   AND b.account_id = u.account_id AND b.slug = 'PnP';
```

**Consent-screen note for client IT admins:** the Microsoft consent prompt
shows *"Maintain access to data you have given it access to"* — that is the
`offline_access` scope msal-node requests by default; the portal never
persists refresh tokens (Entra tokens are used at login only and discarded).

**Admin consent is required per client tenant.** The portal app registration
is multi-tenant with an **unverified publisher**, so end users in customer
tenants cannot self-consent — the first sign-in from a new client tenant will
show *"Need admin approval"* until that client's IT admin grants a **one-time
tenant-wide admin consent** (requested scopes: `openid`, `profile`, `email`,
plus the msal-default `offline_access` explained above). Fold this into client
onboarding alongside capturing the tenant GUID: send the admin the sign-in
link, have them consent on behalf of the organisation, then users sign in
normally. Publisher verification would lift this friction and is a candidate
onboarding improvement.

Never set `entra_object_id` by hand — it binds automatically on first login.
Deactivate a user with `is_active = FALSE` (kills live sessions on their next
request). `db:verify` enforces the structural invariants after any change.

**Rebind runbook (user re-created in Entra).** If a client re-creates a user's
Entra account (new `oid`, same email), their next login denies with
`EMAIL_ALREADY_BOUND` (visible in the audit trail). Recovery, admin-only,
after verifying the request **out-of-band** with the client's IT contact:

```sql
UPDATE portal_users SET entra_object_id = NULL, updated_at = now()
 WHERE email = 'jane.doe@pnp.example';
UPDATE portal_sessions SET revoked_at = now()
 WHERE user_id = (SELECT id FROM portal_users WHERE email = 'jane.doe@pnp.example')
   AND revoked_at IS NULL;
```

The user's next login re-binds the new `oid` (tenant pinning still applies).
Never rebind on the strength of the denial alone — it is exactly what an
account-takeover attempt looks like.

**Logout scope note:** portal logout revokes the portal session only — it does
not end the user's Microsoft (Entra) SSO session. On a shared machine,
clicking "Sign in" again may silently re-authenticate; users must also sign
out of Microsoft (or use a private window) for a full sign-out.

## Deferred (8b or later — recorded per review, no action in 8a)

- Revoke the user's prior session(s) when a new login creates one.
- The benign double-submit branch of the bind race skips the `last_login_at`
  stamp (cosmetic).
- `schema.sql`-vs-migrations parity is discipline-enforced; a future automated
  parity check (fresh-install schema diffed against baseline + migrations) is
  the durable fix.
- Entra **tenant allow-listing** (currently Preview) could later be layered on
  as defence-in-depth ahead of the DB checks, at the cost of maintaining the
  allowlist in two places (Entra + `portal_users.entra_tenant_id`).
- **Invitation-token first-login binding (future enhancement under
  consideration — NOT planned work).** Replace the first-login *email*
  correlation with a short-lived, admin-issued invitation/provisioning token
  that authorises the initial `(tid, oid)` binding after successful Entra
  authentication. This would eliminate the dependency on the `email` claim
  during first-time binding, keep `(tid, oid)` as the immutable anchor
  afterwards, still avoid trusting mutable identifiers (`preferred_username` /
  `upn`) for bootstrap, and improve onboarding for legitimate mailbox-less
  cloud users whose ID tokens carry no `email` claim. It proposes **no change
  to the current security model**: the approved Stage 8a design stands, and the
  implementation continues to require a verified `email` claim **only** on the
  unbound bootstrap path, after which `(tid, oid)` alone is authoritative.

## Manual walk-through (pre-commit)

Manual walk-through before commit: provisioned login; unprovisioned denial;
**unprovisioned-tenant denial**; **correct-email-wrong-tenant denial**;
deactivated-user session killed mid-session; logout; SameSite=Lax cookie
survives the Entra redirect round-trip; scope filtering (account-wide vs
BU-granted user); 401 envelope on API without cookie.

### Real-Entra validation results (Stage 8a sign-off)

Executed against a live multi-tenant Entra registration (client
`b8c25a4f-…`), a test identity provisioned into the `cjn` account, and a
throwaway foreign tenant (`e3381497-…`). All observed via server logs +
`audit_events` (`change_source='PORTAL'`):

- **Onboarding sequence** — inactive/no-GUID row → real login denied
  `TENANT_NOT_CAPTURED`; GUID set, still inactive → denied `USER_INACTIVE`;
  activated → **first login admitted, `bound:true`**, `entra_object_id` written,
  stored `tid` == token `tid`. Uniform 403 on both denials; genuine nonce +
  SameSite=Lax cookie survived the real cross-site redirect; `xms_edov` observed
  emitted as `true` on the real Lynkd token.
- **Second login** — admitted `bound:false` via the `(tid, oid)` path; email not
  consulted; `entra_object_id` unchanged. Bootstrap→bound lifecycle proven.

**Residual — `TENANT_MISMATCH` not exercised by a real token (accepted).** The
real foreign-tenant sign-in was **denied fail-closed with `NO_EMAIL_CLAIM`**
(audited with the real foreign `tid`), so a foreign identity was correctly
rejected — but at the email-guard gate, one step *before* the tenant
comparison. The `TENANT_MISMATCH` branch itself remains verified by the pure
`decideLogin` unit tests (correct-email-wrong-tenant → `TENANT_MISMATCH`) and
was not reached with a real token because the synthetic foreign user emitted no
`email` claim (the `email` claim sources from the `mail` attribute, which a
mailbox-less cloud user lacks; `otherMails` does not feed it). Its two halves —
real-token `tid` extraction and the provenance-independent comparison — are each
independently proven, so the composition is well-supported. Accepted as a
documented test limitation per reviewer authorisation; not a release blocker.
