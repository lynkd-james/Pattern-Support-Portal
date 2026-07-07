# Provider-Agnostic Identity Model + Google Workspace Authentication (design)

Status: DESIGN APPROVED (final refinement pass incorporated 2026-07-08).
**Stage 8b (provider-agnostic model) SHIPPED (`d99dce5`). Stage 8c (Google
Workspace) IMPLEMENTED and real-token validated** — pending review/commit.
Builds on the approved Stage 8a design (`docs/auth.md`); nothing here weakens a
Stage 8a security guarantee. Approved design decisions (2026-07-08):

1. **Approach B** — provider-agnostic identity model.
2. Migrate now; **remove the legacy `entra_*` columns** after backfill (no
   production identity data exists; do not carry legacy schema).
3. Initial UX: **two explicit sign-in buttons** (Microsoft / Google);
   email-based provider discovery deferred.
4. **Invitation-token bootstrap stays deferred** — no bootstrap-flow change in
   this stage.
5. **Preserve existing Entra routes**; add parallel Google routes.
6. Roadmap re-prioritised: **Google authentication precedes the scheduled
   pipeline work.**

Final refinement pass (2026-07-08, approved):

7. Adapters normalise into a provider-neutral **`AuthenticatedIdentity`**
   (+ typed `IdentityDeny`); provider claim vocabulary never escapes adapters.
8. Adapters expose **factual attributes only** (e.g. `emailVerified` as
   observed); provider-specific requirements live in a **centralised provider
   policy layer** beside the decision engine — adapters are pure claim
   normalizers, business rules stay centralised.
9. Configuration variable is **`AUTH_ENABLED_PROVIDERS`** (a set of enabled
   providers), `placeholder` exclusive, legacy alias sunset in Stage 8d.
10. `issuer_namespace` is defined as the **pinning namespace** (the
    provider-asserted organisational boundary), not the minimal uniqueness
    namespace; adapter admission rule guarantees triple uniqueness.

---

## 1. Conceptual identity model

Every portal identity is the triple:

```
identity_provider     — which trust system authenticated the user
issuer_namespace      — the provider-asserted ORGANISATIONAL namespace to which the
                        identity is PINNED at provisioning: the value the token's
                        org claim must equal before the identity is accepted (and,
                        on the bootstrap path, before email is ever compared)
subject_identifier    — the provider's immutable per-user id, bound at FIRST LOGIN
```

**`issuer_namespace` is deliberately the *pinning* namespace, not the minimal
uniqueness namespace.** Google's `sub` is globally unique ("never reused"), so
a "namespace within which the subject is unique" reading would degenerate
Google's value to a constant and lose org pinning — the model's central
security mechanism. Uniqueness of the triple holds *a fortiori* via the
admission rule below.

**Adapter admission rule.** Every supported provider must supply:
(a) a subject identifier that is **immutable and unique at least within its
issuer namespace** (Entra `oid`: unique exactly per tenant; Google `sub`:
globally unique, hence unique within any `hd`);
(b) a token claim asserting the **organisational namespace**;
(c) a usable **verified-email signal** for the bootstrap path.
A provider that cannot satisfy (a)–(c) fails admission — that is precisely the
use case for the deferred invitation-token bootstrap, not for weakening the
model.

### The provider is not the organisation

Microsoft Entra authenticates many thousands of unrelated organisations; so
does Google Workspace. **Enabling a provider grants access to no one**: the
provider is a trust fabric answering "who is this?", never "may they enter?".
The organisation boundary is `issuer_namespace` — pinned per user at
provisioning — combined with the portal DB's own authorisation (account, BU
grants, active flags). Consequences: two clients who both use Entra are exactly
as isolated from each other as a Microsoft client is from a Google client;
adding a provider changes only the authentication surface, never the tenancy
model; and the provider is **per-user provisioning data**, not a tenancy
attribute — an account may in principle contain users on different providers.

The names describe what the values *mean*, not where they came from:

| Provider | `identity_provider` | `issuer_namespace` | `subject_identifier` | Bootstrap email trust gate |
| --- | --- | --- | --- | --- |
| Microsoft Entra ID | `entra` | tenant GUID (`tid`) | directory object id (`oid`) | `xms_edov` (deny if `false`; absent tolerated — pinning is primary) |
| Google Workspace | `google` | hosted domain (`hd`) | `sub` (documented never-reused) | `email_verified` (**must be `true`**; absent ⇒ deny) |
| Future OIDC provider | new value | whatever uniquely identifies the org for that provider | the provider's stable subject | per-provider policy, decided at adapter design |

The Stage 8a mechanisms carry over unchanged in shape:

- **Org pinning**: `issuer_namespace` captured at provisioning (never at login);
  the token's namespace claim must equal it before email is ever compared.
- **Immutable binding**: `subject_identifier` written once on first login
  (guarded `WHERE subject_identifier IS NULL`); thereafter
  `(identity_provider, issuer_namespace, subject_identifier)` is the sole login
  key and email is never consulted.
- **Verified-email bootstrap**: unbound rows only, within the pinned namespace,
  gated by the provider's email-verification signal. Mutable identifiers
  (`preferred_username`, `upn`, display names) are never read.
- **New invariant (multi-provider)**: a row provisioned for provider P can only
  ever be satisfied by a token from P (`PROVIDER_MISMATCH` deny). This attack
  class does not exist today; it exists the day two providers coexist.

## 2. Schema changes

`portal_users` (final form, folded into `schema.sql` for fresh installs):

```sql
identity_provider   TEXT NOT NULL DEFAULT 'entra'
                    CONSTRAINT portal_users_provider_chk
                    CHECK (identity_provider IN ('entra','google')),
issuer_namespace    TEXT,   -- pinned at provisioning; NULL = cannot log in (pending onboarding)
subject_identifier  TEXT,   -- bound on first successful login

-- Bound implies pinned (generalises portal_users_entra_binding_chk):
CONSTRAINT portal_users_identity_binding_chk CHECK (
  subject_identifier IS NULL OR issuer_namespace IS NOT NULL
)
```

```sql
-- One portal user per authenticated identity (bound identities only):
CREATE UNIQUE INDEX idx_portal_users_identity
  ON portal_users (identity_provider, issuer_namespace, subject_identifier)
  WHERE subject_identifier IS NOT NULL;
```

Notes:

- **TEXT + CHECK, not a Postgres enum.** Our migrations run inside a
  transaction; `ALTER TYPE … ADD VALUE` cannot (pre-PG16 restrictions apply to
  the pooled target too). A CHECK constraint is dropped/re-added in one
  transactional migration when a provider is added.
- `DEFAULT 'entra'` exists for backfill ergonomics only; provisioning must set
  it explicitly (runbook + db:verify enforce intent).
- The legacy `entra_tenant_id`, `entra_object_id`, `idx_portal_users_entra_identity`
  and `portal_users_entra_binding_chk` are **removed** (decision 2).

## 3. Migration plan (`0002_provider_agnostic_identity.sql`)

Ordered steps, one transaction, written idempotently per the Stage 8a runner
contract (re-run = no-op; no-op on a fresh install whose `schema.sql` already
has the final form):

1. `ADD COLUMN IF NOT EXISTS` × 3 (`identity_provider` with default,
   `issuer_namespace`, `subject_identifier`).
2. **Backfill** (guarded by a `DO $$ … IF column exists … $$` block, because on
   a fresh install the `entra_*` source columns never existed and a bare
   `UPDATE` referencing them would fail):
   `identity_provider='entra'`, `issuer_namespace=entra_tenant_id`,
   `subject_identifier=entra_object_id` where the new columns are NULL.
3. Add `portal_users_identity_binding_chk` and `portal_users_provider_chk`
   (DROP IF EXISTS + ADD, per the 0001 idempotency pattern).
4. `CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_users_identity …`.
5. Drop legacy: `DROP INDEX IF EXISTS idx_portal_users_entra_identity;`
   `ALTER TABLE … DROP CONSTRAINT IF EXISTS portal_users_entra_binding_chk;`
   `ALTER TABLE … DROP COLUMN IF EXISTS entra_tenant_id, DROP COLUMN IF EXISTS entra_object_id;`
6. `COMMENT ON COLUMN` × 3 documenting the semantics above.

Migration-risk statement (verified 2026-07-08): production `portal_users` does
not exist (schema never applied); dev contains **one** row — the deactivated,
bound Stage 8a test identity, which the backfill converts and which then serves
as the migration's own regression fixture (its bound login must still work
post-migration). This is the lifetime minimum cost for this change.

`db:verify` invariants (generalised, still active-scoped):

- every active portal user has a non-NULL `issuer_namespace`;
- (existing) active user under active account; non-account-wide has ≥1 grant;
  no cross-account grant — all unchanged;
- bound-implies-pinned and provider-value validity are DB-enforced (CHECKs),
  not re-verified.

## 4. Provider interface & claim mappings

### `AuthenticatedIdentity` — the only shape the pipeline ever sees

Adapters are **pure claim normalizers**: they extract and validate provider
claims into a completely provider-neutral domain object carrying **factual
attributes only** — no policy decisions. Provider claim vocabulary (`tid`,
`oid`, `hd`, `sub`, `xms_edov`, `email_verified`) never appears outside the
adapters — not in the decision engine, routes, or audit call sites.

```ts
interface AuthenticatedIdentity {
  provider: "entra" | "google";
  issuerNamespace: string;            // fact: the token's org-namespace claim
  subjectIdentifier: string;          // fact: the token's immutable subject
  email: string | null;               // fact: lowercased email claim, or absent
  emailVerified: boolean | undefined; // fact: provider's verification signal,
                                      //   as observed (undefined = not emitted)
  displayName: string | null;         // informational ONLY — never persisted,
                                      //   never an authorization input
}

/** Typed failure — carries its own telemetry so raw claims never leak out
 *  of the adapter just to build an audit row. */
interface IdentityDeny {
  reason: ClaimDenyReason;            // NONCE_MISMATCH | MISSING_NAMESPACE |
                                      // MISSING_SUBJECT | ISSUER_MISMATCH
  issuerNamespace: string | null;     // best-effort, for denial audit rows
  email: string | null;               // best-effort, hashed downstream
}
```

`AuthenticatedIdentity` is a pure data object (no methods, no adapter
back-references) so the decision-layer test suite constructs it literally,
preserving the Stage 8a pure-testing pattern.

### Provider adapter contract (`src/server/auth/providers/`)

```ts
interface IdentityProviderAdapter {
  readonly provider: "entra" | "google";
  buildAuthUrl(flow: FlowSecrets & { codeChallenge: string }): Promise<string>;
  redeemCode(params: { code: string; codeVerifier: string }):
    Promise<Record<string, unknown> | null>;   // raw ID-token claims
  validateClaims(raw: Record<string, unknown>, expectedNonce: string):
    AuthenticatedIdentity | IdentityDeny;
}
```

### Provider policy layer (centralised — NOT in the adapters)

Provider-specific authentication *requirements* live beside the decision
engine as pure, declarative policy, so adapters stay claim normalizers and
business rules stay centralised and testable in one place:

```ts
const PROVIDER_POLICIES = {
  // xms_edov emission is tenant-config-dependent: deny only when the provider
  // positively asserts unverified; absence tolerated (pinning is primary).
  entra:  { emailBootstrapTrust: "deny-only-if-false" },
  // email_verified is a standard claim on every Google token: require true;
  // absence or false both deny.
  google: { emailBootstrapTrust: "require-true" },
} as const;
```

`decideLogin` consumes `AuthenticatedIdentity` + the policy for
`identity.provider` and applies exactly one bootstrap-trust rule; the
per-provider rationale is documented here, not encoded in adapter behaviour.

- `providers/entra.ts` — wraps the existing msal-node client and the existing
  `validateIdTokenClaims` logic verbatim (nonce → `tid` → `oid` → iss/tid
  consistency), renamed outputs only. **No behavioural change to Entra.**
- `providers/google.ts` — `openid-client` (certified OIDC: discovery, PKCE,
  nonce, JWKS). Validation order mirrors Entra's shape:
  nonce → `sub` present → `hd` present (**absent ⇒ deny — consumer accounts are
  out of scope**) → `iss ∈ {"https://accounts.google.com","accounts.google.com"}`
  (both documented forms) → `email`/`email_verified` extraction.
  Trust anchor identical to 8a: the token arrives from Google's token endpoint
  over authenticated back-channel TLS; `openid-client` additionally performs
  JWKS signature validation (harmless belt-and-braces); claim-level checks are
  ours.

### Claim mapping table

| NormalizedClaims field | Entra source | Google source | Deny when |
| --- | --- | --- | --- |
| `issuerNamespace` | `tid` | `hd` | missing (`MISSING_NAMESPACE`) |
| `subjectIdentifier` | `oid` | `sub` | missing (`MISSING_SUBJECT`) |
| issuer consistency | `iss == https://login.microsoftonline.com/{tid}/v2.0` | `iss` ∈ two fixed forms | mismatch (`ISSUER_MISMATCH`) |
| `email` | `email` claim only | `email` claim only | absent on bootstrap path (`NO_EMAIL_CLAIM`) |
| `emailVerified` | `xms_edov` (optional claim) | `email_verified` (standard) | fact only — the deny rule lives in the **provider policy layer** above |
| never read | `preferred_username`, `upn` | `name`-adjacent fields for identity | — |

### Decision layer

`decideLogin` remains **one pure function**, operating on
`AuthenticatedIdentity` + the provider policy + candidate rows. Deny-reason vocabulary generalised (`MISSING_TID` →
`MISSING_NAMESPACE`, etc. — audit consumers note the rename) plus:

- `PROVIDER_MISMATCH` — row's `identity_provider` ≠ token's provider. Checked
  **first** on both the bound-lookup (lookup keys include provider, so this is
  structural) and the email path (explicit guard before the namespace checks).

All Stage 8a decision semantics are otherwise byte-for-byte preserved,
including check order on the email path: bound-elsewhere → provider →
namespace-captured → namespace-match → email-trust (per provider policy) →
active checks.

## 5. Routes, UX, configuration

- **Entra routes preserved** (decision 5): `/api/auth/login`,
  `/api/auth/callback` continue to serve Entra (matching the registered
  redirect URIs). New: `/api/auth/google/login`, `/api/auth/google/callback`.
  `/api/auth/logout` is shared (sessions are provider-independent).
- Flow cookie gains a `provider` field; each callback verifies the cookie's
  provider matches its own route (defence against cross-flow replay).
- `/login` page: two buttons — "Sign in with Microsoft", "Sign in with Google"
  (decision 3). Deny/failure UX unchanged (uniform 403; `?error=auth` retry).
- **Config**: new **`AUTH_ENABLED_PROVIDERS`** comma-list — it expresses which
  providers are *enabled* (a set), not a single selection. Values: `entra`,
  `google`, or `placeholder`; **`placeholder` is exclusive** (combining it with
  a real provider is a fail-fast config error), keeping the dev bypass in the
  same variable without ever coexisting with real auth. Legacy
  `AUTH_PROVIDER=entra|placeholder` honoured as the equivalent single-item
  list, fail-fast if both variables are set and conflict; **alias removed in
  Stage 8d**. Each enabled provider's secrets are validated at startup
  (enabling `google` without `AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET`
  fails fast, mirroring `requirePortalAuth()`). Google redirect URI =
  `PORTAL_BASE_URL + /api/auth/google/callback`. Placeholder-in-production
  guard unchanged.
- **Rename**: `EntraIDSessionProvider` → `PortalSessionProvider` (it resolves
  cookie → session → scope and was never Entra-specific). Factory unchanged in
  shape. Sessions, `RequestScope`, `customer/queries.ts`, middleware,
  `apiError.ts`: **zero change.**

## 6. Security invariants (restated for both providers)

1. The provider authenticates; **the portal DB authorises** — unprovisioned
   identities are denied regardless of provider.
2. `issuer_namespace` is captured at provisioning, never at login.
3. First-login email matching requires the token's namespace claim to equal the
   provisioned `issuer_namespace`, the row to be unbound, and the provider to
   match. Email is never a cross-namespace or cross-provider key.
4. After binding, `(provider, namespace, subject)` is the sole login key;
   email is never consulted again.
5. Mutable identifiers are never read for identity.
6. Uniform, information-free 403 for every identity denial; every denial
   audited with `{provider, namespace, reason, emailHash}` (payload key `tid`
   → `namespace`; consumers of existing audit rows note both forms exist
   historically).
7. Session validity enforced at resolution on every request (idle + absolute +
   user/account active) — unchanged.
8. Trust anchor: back-channel TLS code exchange with the provider's token
   endpoint, plus our claim-level checks; Google additionally
   signature-validated via JWKS by `openid-client`.

## 7. Implementation stages

Two cohesive commits (extends the Stage 8a one-stage-one-commit convention):

- **Stage 8b — provider-agnostic identity model (no new provider).**
  Migration 0002 + schema.sql parity; `identity.ts` generalisation +
  `providers/entra.ts` extraction; route internals re-pointed; audit payload
  rename; `db:verify` generalisation; `PortalSessionProvider` rename; docs.
  Gate: full pure-layer suite (all 21 Stage 8a cases re-expressed +
  provider-mismatch cases), migration idempotency (including
  fresh-install no-op and the DO-block guard), **Entra real-token regression**
  — the migrated bound test row must log in via the bound path
  (`bound:false`), proving backfill correctness end-to-end.
- **Stage 8c — Google Workspace authentication.**
  `providers/google.ts` (+ `openid-client` dependency), Google routes, login
  button, `AUTH_PROVIDERS`/env additions, provisioning-runbook update
  (namespace = workspace primary domain), docs. Gate: pure-layer Google cases;
  real-token walk-through (below).

Scheduled-pipeline work (previously "8b") is re-designated **Stage 8d**
(decision 6); CLAUDE.md §10 is updated accordingly in the 8b commit.

## 8. Testing strategy

**Pure layer (tsx suite, per 8a pattern):**
- All existing Entra cases re-run against the generalised model (identical
  expected outcomes, renamed reasons).
- Google claim validation: valid token; missing `sub`; **missing `hd`
  (consumer account) ⇒ deny**; both `iss` forms accepted; foreign `iss`
  rejected; `email_verified` absent ⇒ deny; `false` ⇒ deny; nonce mismatch.
- `decideLogin`: PROVIDER_MISMATCH (google token vs entra row and vice versa);
  google wrong-`hd` (the TENANT_MISMATCH analogue); google bind + bound-path;
  all inactive/bound-elsewhere cases per provider.

**Migration:** apply on dev (one-row backfill verified: values moved, legacy
columns gone, CHECK/index live via rejected-insert probes); re-run no-op;
fresh-install simulation (schema.sql final form + 0001 + 0002 both no-op).

**Real-token walk-throughs (browser, per 8a discipline):**
- *8b regression:* Entra bound login (`bound:false`), one denial branch, logout.
- *8c Google:* provision → wrong-`hd` real-token denial (any second Workspace
  or consumer account — **easier than Entra's foreign-tenant test**, no fake
  tenant needed) → consumer-Gmail denial (`MISSING_NAMESPACE`) → first login
  bind → bound-path second login → logout. Deliberate-test audit rows
  annotated, test rows deactivated, `db:verify` after cleanup.

**Gates per commit:** `tsc --noEmit`, lint, `db:verify`, migration idempotency,
final-diff review (no instrumentation), per the 8a release checklist.

## 9. Assumptions to verify during implementation

- `hd` semantics — **PARTIALLY RESOLVED by observation (Stage 8c, 2026-07-07)**:
  on a real single-domain Workspace token, `hd` equalled the login-email domain
  (= the primary domain). Provisioning rule: capture the domain of the user's
  work email, lowercased (see docs/auth.md). **Multi-domain Workspaces remain
  unverified** — confirm with one real login when the first multi-domain
  Google client onboards (wrong guess fails closed as `NAMESPACE_MISMATCH`).
- Google OAuth consent for an **unverified external app** on non-sensitive
  scopes (`openid email profile`) is a warning, not an admin-consent-style
  block. Onboarding-doc item either way.
- A Google Workspace tenant is available for the 8c walk-through (Lynkd is
  Microsoft-based — **open question: which Workspace do we test against?**).
- **Namespace-rename failure mode (fold into the provisioning runbook at
  implementation):** a Workspace primary-domain rename changes `hd` (and an
  Entra tenant migration changes `tid`) → bound logins fail **closed** (the
  namespace no longer matches). Recovery is admin-driven: re-pin
  `issuer_namespace` out-of-band-verified, and if the subject also changed,
  follow the existing rebind runbook. Never silently permissive.

## 10. Out of scope / unchanged / deferred

Invitation-token bootstrap (decision 4 — deferred, both providers); email-based
provider discovery on /login; prior-session revocation on new login; automated
schema-parity check; Entra tenant allow-listing; the Stage 8a `NO_EMAIL_CLAIM`
real-token residual (unchanged); scheduled pipeline + session cleanup (now
Stage 8d).

### Stage 8d candidates carried from the 8b/8c reviews (recorded 2026-07-08)

- Remove legacy `AUTH_PROVIDER` compatibility alias.
- Split `auth/handlers.ts` into smaller services **if** another authentication
  provider or flow is added.
- Strengthen the bound-path provider assertion (defence in depth beyond the
  structural SQL key).
- Verify `hd` behaviour with a real multi-domain Workspace customer.
- Validate the runtime `MISSING_NAMESPACE` path using an External OAuth client
  when appropriate (the current Internal client is rejected by Google as
  `org_internal` before our callback is ever invoked).
- Review the Internal vs External Google OAuth strategy for multi-tenant
  customer onboarding (Internal pre-filters foreign identities but binds the
  client to one Workspace; External reintroduces the unverified-app consent
  screen).
