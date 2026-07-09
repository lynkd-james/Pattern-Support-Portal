// =============================================================================
// Provider-agnostic identity — pure unit suite (Stages 8b + 8c).
//
// Ported into the permanent regression suite during Stage 9a (previously
// session-local tsx scripts). Semantics are unchanged: Entra + Google claim
// normalisation, the central provider policy, and the pure decideLogin engine
// including the cross-provider PROVIDER_MISMATCH guard.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  decideLogin,
  emailTrustedForBootstrap,
  isIdentityDeny,
  type AuthenticatedIdentity,
  type CandidateUser,
} from "@/server/auth/identity";
import { policyFor, PROVIDER_POLICIES } from "@/server/auth/policy";
import { validateEntraClaims } from "@/server/auth/providers/entraClaims";
import { validateGoogleClaims } from "@/server/auth/providers/googleClaims";
import { parseFlowSecrets, serializeFlowSecrets } from "@/server/auth/flow";

const TID = "aaaa1111-0000-0000-0000-000000000001";
const OTHER_TID = "bbbb2222-0000-0000-0000-000000000002";
const OID = "cccc3333-0000-0000-0000-000000000003";
const NONCE = "expected-nonce";

// ---- Entra claim normalisation -----------------------------------------------

const entraRaw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nonce: NONCE,
  tid: TID,
  oid: OID,
  iss: `https://login.microsoftonline.com/${TID}/v2.0`,
  email: "Jane.Doe@Client.Example",
  name: "Jane Doe",
  ...over,
});

describe("entra claim normalisation", () => {
  it("accepts a valid token and maps claims to the neutral shape", () => {
    const r = validateEntraClaims(entraRaw(), NONCE);
    expect(isIdentityDeny(r)).toBe(false);
    if (!isIdentityDeny(r)) {
      expect(r.provider).toBe("entra");
      expect(r.issuerNamespace).toBe(TID);
      expect(r.subjectIdentifier).toBe(OID);
      expect(r.email).toBe("jane.doe@client.example");
      expect(r.emailVerified).toBeUndefined();
    }
  });

  it("denies nonce mismatch and missing nonce", () => {
    for (const raw of [entraRaw({ nonce: "wrong" }), entraRaw({ nonce: undefined })]) {
      const r = validateEntraClaims(raw, NONCE);
      expect(isIdentityDeny(r) && r.reason).toBe("NONCE_MISMATCH");
    }
  });

  it("denies missing tid -> MISSING_NAMESPACE", () => {
    const r = validateEntraClaims(entraRaw({ tid: "  " }), NONCE);
    expect(isIdentityDeny(r) && r.reason).toBe("MISSING_NAMESPACE");
  });

  it("denies missing oid -> MISSING_SUBJECT", () => {
    const r = validateEntraClaims(entraRaw({ oid: undefined }), NONCE);
    expect(isIdentityDeny(r) && r.reason).toBe("MISSING_SUBJECT");
  });

  it("denies iss/tid inconsistency", () => {
    const r = validateEntraClaims(
      entraRaw({ iss: `https://login.microsoftonline.com/${OTHER_TID}/v2.0` }),
      NONCE
    );
    expect(isIdentityDeny(r) && r.reason).toBe("ISSUER_MISMATCH");
  });

  it("carries xms_edov as an observed fact (bool + string coercion)", () => {
    const rf = validateEntraClaims(entraRaw({ xms_edov: false }), NONCE);
    expect(!isIdentityDeny(rf) && rf.emailVerified).toBe(false);
    const rs = validateEntraClaims(entraRaw({ xms_edov: "true" }), NONCE);
    expect(!isIdentityDeny(rs) && rs.emailVerified).toBe(true);
  });

  it("deny carries namespace + email telemetry (no raw-claim leak upstream)", () => {
    const r = validateEntraClaims(entraRaw({ nonce: "wrong" }), NONCE);
    expect(isIdentityDeny(r) && r.issuerNamespace).toBe(TID);
    expect(isIdentityDeny(r) && r.email).toBe("jane.doe@client.example");
  });
});

// ---- Google claim normalisation ----------------------------------------------

const HD = "411agency.com";
const SUB = "108239041857312345678";
const googleRaw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "https://accounts.google.com",
  sub: SUB,
  hd: HD,
  email: "James@411Agency.com",
  email_verified: true,
  name: "James Woolley",
  nonce: NONCE,
  aud: "client-id",
  ...over,
});

describe("google claim normalisation", () => {
  it("accepts a valid Workspace token; hd -> issuerNamespace (lowercased)", () => {
    const r = validateGoogleClaims(googleRaw(), NONCE);
    expect(isIdentityDeny(r)).toBe(false);
    if (!isIdentityDeny(r)) {
      expect(r.provider).toBe("google");
      expect(r.issuerNamespace).toBe("411agency.com");
      expect(r.subjectIdentifier).toBe(SUB);
      expect(r.email).toBe("james@411agency.com");
      expect(r.emailVerified).toBe(true);
    }
  });

  it("denies nonce mismatch", () => {
    const r = validateGoogleClaims(googleRaw({ nonce: "wrong" }), NONCE);
    expect(isIdentityDeny(r) && r.reason).toBe("NONCE_MISMATCH");
  });

  it("denies missing sub -> MISSING_SUBJECT", () => {
    const r = validateGoogleClaims(googleRaw({ sub: undefined }), NONCE);
    expect(isIdentityDeny(r) && r.reason).toBe("MISSING_SUBJECT");
  });

  it("denies consumer account (no hd) -> MISSING_NAMESPACE", () => {
    const r = validateGoogleClaims(googleRaw({ hd: undefined }), NONCE);
    expect(isIdentityDeny(r) && r.reason).toBe("MISSING_NAMESPACE");
  });

  it("accepts both documented iss forms; denies a foreign issuer", () => {
    expect(isIdentityDeny(validateGoogleClaims(googleRaw({ iss: "accounts.google.com" }), NONCE))).toBe(false);
    const bad = validateGoogleClaims(googleRaw({ iss: "https://evil.example" }), NONCE);
    expect(isIdentityDeny(bad) && bad.reason).toBe("ISSUER_MISMATCH");
  });

  it("carries email_verified as an observed fact (string + absent)", () => {
    const rs = validateGoogleClaims(googleRaw({ email_verified: "false" }), NONCE);
    expect(!isIdentityDeny(rs) && rs.emailVerified).toBe(false);
    const ra = validateGoogleClaims(googleRaw({ email_verified: undefined }), NONCE);
    expect(!isIdentityDeny(ra) && ra.emailVerified).toBeUndefined();
  });

  it("deny carries hd + email telemetry", () => {
    const r = validateGoogleClaims(googleRaw({ nonce: "wrong" }), NONCE);
    expect(isIdentityDeny(r) && r.issuerNamespace).toBe(HD);
    expect(isIdentityDeny(r) && r.email).toBe("james@411agency.com");
  });
});

// ---- provider policy layer ---------------------------------------------------

describe("provider policy (email bootstrap trust)", () => {
  it("declares the per-provider policies", () => {
    expect(PROVIDER_POLICIES.entra.emailBootstrapTrust).toBe("deny-only-if-false");
    expect(PROVIDER_POLICIES.google.emailBootstrapTrust).toBe("require-true");
  });
  it("entra tolerates absent, accepts true, denies explicit false", () => {
    expect(emailTrustedForBootstrap(policyFor("entra"), undefined)).toBe(true);
    expect(emailTrustedForBootstrap(policyFor("entra"), true)).toBe(true);
    expect(emailTrustedForBootstrap(policyFor("entra"), false)).toBe(false);
  });
  it("google requires explicit true", () => {
    expect(emailTrustedForBootstrap(policyFor("google"), true)).toBe(true);
    expect(emailTrustedForBootstrap(policyFor("google"), undefined)).toBe(false);
    expect(emailTrustedForBootstrap(policyFor("google"), false)).toBe(false);
  });
});

// ---- decideLogin (provider-neutral engine) -----------------------------------

const identity = (over: Partial<AuthenticatedIdentity> = {}): AuthenticatedIdentity => ({
  provider: "entra",
  issuerNamespace: TID,
  subjectIdentifier: OID,
  email: "jane.doe@client.example",
  emailVerified: undefined,
  displayName: "Jane Doe",
  ...over,
});
const user = (over: Partial<CandidateUser> = {}): CandidateUser => ({
  id: "user-1",
  accountId: "acct-1",
  identityProvider: "entra",
  issuerNamespace: TID,
  subjectIdentifier: null,
  userActive: true,
  accountActive: true,
  ...over,
});
const entraPolicy = policyFor("entra");

describe("decideLogin — bound path", () => {
  it("admits a bound (provider, namespace, subject) match without re-binding", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: user({ subjectIdentifier: OID }), emailUser: null });
    expect(r.kind === "admit" && r.bind).toBe(false);
  });
  it("denies bound-but-deactivated user and inactive account", () => {
    const du = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: user({ subjectIdentifier: OID, userActive: false }), emailUser: null });
    expect(du.kind === "deny" && du.reason).toBe("USER_INACTIVE");
    const da = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: user({ subjectIdentifier: OID, accountActive: false }), emailUser: null });
    expect(da.kind === "deny" && da.reason).toBe("ACCOUNT_INACTIVE");
  });
});

describe("decideLogin — first-login bootstrap path", () => {
  it("admits and binds within the pinned namespace", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user() });
    expect(r.kind === "admit" && r.bind).toBe(true);
  });
  it("denies unprovisioned identity", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: null });
    expect(r.kind === "deny" && r.reason).toBe("NOT_PROVISIONED");
  });
  it("denies correct-email-wrong-namespace (nOAuth vector)", () => {
    const r = decideLogin({ identity: identity({ issuerNamespace: OTHER_TID }), policy: entraPolicy, boundUser: null, emailUser: user() });
    expect(r.kind === "deny" && r.reason).toBe("NAMESPACE_MISMATCH");
  });
  it("denies namespace-not-captured", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user({ issuerNamespace: null }) });
    expect(r.kind === "deny" && r.reason).toBe("NAMESPACE_NOT_CAPTURED");
  });
  it("denies an email row already bound to another subject", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user({ subjectIdentifier: "different" }) });
    expect(r.kind === "deny" && r.reason).toBe("EMAIL_ALREADY_BOUND");
  });
  it("denies entra xms_edov=false at bootstrap", () => {
    const r = decideLogin({ identity: identity({ emailVerified: false }), policy: entraPolicy, boundUser: null, emailUser: user() });
    expect(r.kind === "deny" && r.reason).toBe("EMAIL_NOT_VERIFIED");
  });
  it("denies unbound + no email claim", () => {
    const r = decideLogin({ identity: identity({ email: null }), policy: entraPolicy, boundUser: null, emailUser: null });
    expect(r.kind === "deny" && r.reason).toBe("NO_EMAIL_CLAIM");
  });
  it("denies inactive user / account on the email path", () => {
    const iu = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user({ userActive: false }) });
    expect(iu.kind === "deny" && iu.reason).toBe("USER_INACTIVE");
    const ia = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user({ accountActive: false }) });
    expect(ia.kind === "deny" && ia.reason).toBe("ACCOUNT_INACTIVE");
  });
});

describe("decideLogin — cross-provider confusion guard", () => {
  it("denies entra token vs google-provisioned row", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user({ identityProvider: "google", issuerNamespace: "client.example" }) });
    expect(r.kind === "deny" && r.reason).toBe("PROVIDER_MISMATCH");
  });
  it("denies google token vs entra-provisioned row", () => {
    const g = identity({ provider: "google", issuerNamespace: "client.example", subjectIdentifier: "123", emailVerified: true });
    const r = decideLogin({ identity: g, policy: policyFor("google"), boundUser: null, emailUser: user() });
    expect(r.kind === "deny" && r.reason).toBe("PROVIDER_MISMATCH");
  });
  it("checks provider before namespace-captured", () => {
    const r = decideLogin({ identity: identity(), policy: entraPolicy, boundUser: null, emailUser: user({ identityProvider: "google", issuerNamespace: null }) });
    expect(r.kind === "deny" && r.reason).toBe("PROVIDER_MISMATCH");
  });
  it("google-shaped bootstrap: admits under require-true, denies on absent signal", () => {
    const row = user({ identityProvider: "google", issuerNamespace: "client.example" });
    const ok = decideLogin({ identity: identity({ provider: "google", issuerNamespace: "client.example", subjectIdentifier: "123", emailVerified: true }), policy: policyFor("google"), boundUser: null, emailUser: row });
    expect(ok.kind === "admit" && ok.bind).toBe(true);
    const no = decideLogin({ identity: identity({ provider: "google", issuerNamespace: "client.example", subjectIdentifier: "123", emailVerified: undefined }), policy: policyFor("google"), boundUser: null, emailUser: row });
    expect(no.kind === "deny" && no.reason).toBe("EMAIL_NOT_VERIFIED");
  });
});

// ---- flow cookie strictness --------------------------------------------------

describe("flow cookie", () => {
  it("round-trips with the realm + provider fields", () => {
    const parsed = parseFlowSecrets(serializeFlowSecrets({ realm: "admin", provider: "entra", state: "s", nonce: "n", codeVerifier: "v" }));
    expect(parsed?.realm).toBe("admin");
    expect(parsed?.provider).toBe("entra");
    expect(parsed?.state).toBe("s");
  });
  it("rejects a stale shape missing realm or provider (fails closed)", () => {
    const noRealm = Buffer.from(JSON.stringify({ provider: "entra", state: "s", nonce: "n", codeVerifier: "v" })).toString("base64url");
    const noProvider = Buffer.from(JSON.stringify({ realm: "customer", state: "s", nonce: "n", codeVerifier: "v" })).toString("base64url");
    expect(parseFlowSecrets(noRealm)).toBeNull();
    expect(parseFlowSecrets(noProvider)).toBeNull();
  });
  it("rejects an unknown realm, unknown provider, and garbage", () => {
    const badRealm = Buffer.from(JSON.stringify({ realm: "root", provider: "entra", state: "s", nonce: "n", codeVerifier: "v" })).toString("base64url");
    const badProvider = Buffer.from(JSON.stringify({ realm: "customer", provider: "okta", state: "s", nonce: "n", codeVerifier: "v" })).toString("base64url");
    expect(parseFlowSecrets(badRealm)).toBeNull();
    expect(parseFlowSecrets(badProvider)).toBeNull();
    expect(parseFlowSecrets("not-base64-json")).toBeNull();
  });
});
