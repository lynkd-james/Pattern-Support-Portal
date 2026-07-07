// =============================================================================
// Server-only environment / configuration module.
//
// Responsibilities:
//   * Parse and validate every environment variable the portal depends on.
//   * Group validation so each subsystem only requires the secrets it actually
//     uses (Stage 1 DB scripts need DATABASE_URL only — they must NOT require
//     ClickUp / Graph credentials).
//   * Never expose secrets to the client. This file must only ever be imported
//     from server code (API routes, scripts, server components / actions).
//
// IMPORTANT: do not import this module from any client component.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error(
    "src/server/env.ts is server-only and must never be imported into client code."
  );
}

// ---- helpers ---------------------------------------------------------------

function readString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readBool(name: string, defaultValue: boolean): boolean {
  const raw = readString(name);
  if (raw === undefined) return defaultValue;
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error(
    `Invalid boolean for ${name}: "${raw}". Use true/false (or 1/0, yes/no, on/off).`
  );
}

function readInt(name: string, defaultValue: number): number {
  const raw = readString(name);
  if (raw === undefined) return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid positive integer for ${name}: "${raw}".`);
  }
  return n;
}

class MissingEnvError extends Error {
  constructor(missing: string[], context: string) {
    super(
      `Missing required environment variable(s) for ${context}: ${missing.join(
        ", "
      )}. See .env.example.`
    );
    this.name = "MissingEnvError";
  }
}

// ---- auth provider set (Stage 8b) -------------------------------------------

export type EnabledProvider = "entra" | "google" | "placeholder";
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(["entra", "google", "placeholder"]);

/**
 * Resolve the set of enabled auth providers from AUTH_ENABLED_PROVIDERS, with
 * the legacy single-value AUTH_PROVIDER honoured as an alias (sunset: Stage
 * 8d). Rules: values must be known; 'placeholder' is exclusive; both variables
 * set => they must agree; neither set => placeholder (dev default). 'google'
 * is accepted by the vocabulary but not implemented until Stage 8c.
 */
function resolveEnabledProviders(
  listRaw: string | undefined,
  legacyRaw: string | undefined
): EnabledProvider[] {
  const parse = (raw: string): EnabledProvider[] => {
    const items = [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
    for (const item of items) {
      if (!KNOWN_PROVIDERS.has(item)) {
        throw new Error(
          `Unknown auth provider "${item}" in AUTH_ENABLED_PROVIDERS/AUTH_PROVIDER. ` +
            `Known: entra, google, placeholder.`
        );
      }
    }
    if (items.length === 0) return ["placeholder"];
    if (items.includes("placeholder") && items.length > 1) {
      throw new Error(
        `"placeholder" is exclusive and cannot be combined with real providers ` +
          `(got: ${items.join(", ")}).`
      );
    }
    if (items.includes("google")) {
      throw new Error(
        `Auth provider "google" is not implemented yet (arrives in Stage 8c).`
      );
    }
    return items as EnabledProvider[];
  };

  const fromList = listRaw !== undefined ? parse(listRaw) : null;
  const fromLegacy = legacyRaw !== undefined ? parse(legacyRaw) : null;

  if (fromList && fromLegacy) {
    const same =
      fromList.length === fromLegacy.length &&
      fromList.every((p) => fromLegacy.includes(p));
    if (!same) {
      throw new Error(
        `AUTH_ENABLED_PROVIDERS (${fromList.join(",")}) conflicts with legacy ` +
          `AUTH_PROVIDER (${fromLegacy.join(",")}). Remove AUTH_PROVIDER (deprecated).`
      );
    }
    return fromList;
  }
  return fromList ?? fromLegacy ?? ["placeholder"];
}

// ---- parsed (non-throwing) view --------------------------------------------
// Reading `env` never throws on missing secrets; use the `require*` accessors
// at the point of use so each subsystem fails fast only for what it needs.

export const env = {
  nodeEnv: readString("NODE_ENV") ?? "development",

  // Database
  databaseUrl: readString("DATABASE_URL"),
  pgPoolMax: readInt("PGPOOL_MAX", 5),
  pgDisableSsl: readBool("PG_DISABLE_SSL", false),

  // ClickUp (Stage 2+)
  clickupApiToken: readString("CLICKUP_API_TOKEN"),
  // Integration scope (REQUIRED — no fallbacks; validated via requireClickupScope()).
  clickupTeamId: readString("CLICKUP_TEAM_ID"),
  clickupSupportFolderId: readString("CLICKUP_SUPPORT_FOLDER_ID"),
  // Field names are non-secret config with safe defaults.
  clickupCustomerFieldName: readString("CLICKUP_CUSTOMER_FIELD_NAME") ?? "Customer",
  clickupSlaPriorityFieldName:
    readString("CLICKUP_SLA_PRIORITY_FIELD_NAME") ?? "SLA Priority",
  clickupSyncOverlapMs: readInt("CLICKUP_SYNC_OVERLAP_MS", 60_000),
  // Archived backfill safeguard (default ON). Set false to retrieve active only.
  clickupIncludeArchived: readBool("CLICKUP_INCLUDE_ARCHIVED", true),

  // Microsoft Graph app-only (Stage 6: Outlook acknowledgement ingestion)
  graphTenantId: readString("GRAPH_TENANT_ID"),
  graphClientId: readString("GRAPH_CLIENT_ID"),
  graphClientSecret: readString("GRAPH_CLIENT_SECRET"),
  // Shared mailbox scanned for the "ticket has been logged" acknowledgement email.
  graphSupportMailbox:
    readString("GRAPH_SUPPORT_MAILBOX") ?? "supportdesk@lynkd.co.za",
  graphSyncOverlapMs: readInt("GRAPH_SYNC_OVERLAP_MS", 60_000),

  // Publishing (Stage 5+) — safe default
  autoPublishEnabled: readBool("AUTO_PUBLISH_ENABLED", false),

  // Portal authentication (Stage 8b): AUTH_ENABLED_PROVIDERS expresses the SET
  // of enabled providers ('entra' | 'google' | 'placeholder'; comma list).
  // 'placeholder' is EXCLUSIVE (dev bypass; may not combine with a real
  // provider). Legacy AUTH_PROVIDER is honoured as a single-item alias until
  // Stage 8d (fail-fast if both are set and conflict).
  enabledProviders: resolveEnabledProviders(
    readString("AUTH_ENABLED_PROVIDERS"),
    readString("AUTH_PROVIDER")
  ),
  authEntraClientId: readString("AUTH_ENTRA_CLIENT_ID"),
  authEntraClientSecret: readString("AUTH_ENTRA_CLIENT_SECRET"),
  // Multi-tenant sign-in: any org authenticates; the portal DB authorises.
  authEntraAuthority:
    readString("AUTH_ENTRA_AUTHORITY") ??
    "https://login.microsoftonline.com/organizations",
  // Absolute base URL of the portal (redirect URI base), e.g. https://portal.example.com
  portalBaseUrl: readString("PORTAL_BASE_URL"),
  sessionIdleHours: readInt("SESSION_IDLE_HOURS", 8),
  sessionMaxHours: readInt("SESSION_MAX_HOURS", 720),
  // Explicit escape hatch: placeholder auth refuses to run in production
  // without this (see customer/session.ts factory).
  allowPlaceholderAuth: readBool("ALLOW_PLACEHOLDER_AUTH", false),
} as const;

// ---- grouped, fail-fast accessors ------------------------------------------

/** Required by the DB client and all Stage 1 scripts. */
export function requireDatabaseUrl(): string {
  if (!env.databaseUrl) throw new MissingEnvError(["DATABASE_URL"], "database");
  return env.databaseUrl;
}

/** Required from Stage 2 (ClickUp ingestion). */
export function requireClickup(): { token: string } {
  if (!env.clickupApiToken)
    throw new MissingEnvError(["CLICKUP_API_TOKEN"], "ClickUp");
  return { token: env.clickupApiToken };
}

/** Required by the ClickUp sync — fails fast if scope is not configured. */
export function requireClickupScope(): { teamId: string; folderId: string } {
  const missing: string[] = [];
  if (!env.clickupTeamId) missing.push("CLICKUP_TEAM_ID");
  if (!env.clickupSupportFolderId) missing.push("CLICKUP_SUPPORT_FOLDER_ID");
  if (missing.length) throw new MissingEnvError(missing, "ClickUp scope");
  return { teamId: env.clickupTeamId!, folderId: env.clickupSupportFolderId! };
}

/** Required from Stage 3 (Outlook / Microsoft Graph). */
export function requireGraph(): {
  tenantId: string;
  clientId: string;
  clientSecret: string;
} {
  const missing: string[] = [];
  if (!env.graphTenantId) missing.push("GRAPH_TENANT_ID");
  if (!env.graphClientId) missing.push("GRAPH_CLIENT_ID");
  if (!env.graphClientSecret) missing.push("GRAPH_CLIENT_SECRET");
  if (missing.length) throw new MissingEnvError(missing, "Microsoft Graph");
  return {
    tenantId: env.graphTenantId!,
    clientId: env.graphClientId!,
    clientSecret: env.graphClientSecret!,
  };
}

/** Required when AUTH_PROVIDER = 'entra' (Stage 8a portal sign-in). */
export function requirePortalAuth(): {
  clientId: string;
  clientSecret: string;
  authority: string;
  baseUrl: string;
} {
  const missing: string[] = [];
  if (!env.authEntraClientId) missing.push("AUTH_ENTRA_CLIENT_ID");
  if (!env.authEntraClientSecret) missing.push("AUTH_ENTRA_CLIENT_SECRET");
  if (!env.portalBaseUrl) missing.push("PORTAL_BASE_URL");
  if (missing.length) throw new MissingEnvError(missing, "portal auth (Entra)");
  return {
    clientId: env.authEntraClientId!,
    clientSecret: env.authEntraClientSecret!,
    authority: env.authEntraAuthority,
    baseUrl: env.portalBaseUrl!.replace(/\/+$/, ""),
  };
}

/**
 * Validate every known variable at once. Useful for a future `env:check` task.
 * `requireIntegrations=false` (default) validates only what Stage 1 needs, so
 * it can run without ClickUp/Graph credentials present.
 */
export function validateEnv(options: { requireIntegrations?: boolean } = {}): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!env.databaseUrl) missing.push("DATABASE_URL");
  if (options.requireIntegrations) {
    if (!env.clickupApiToken) missing.push("CLICKUP_API_TOKEN");
    if (!env.graphTenantId) missing.push("GRAPH_TENANT_ID");
    if (!env.graphClientId) missing.push("GRAPH_CLIENT_ID");
    if (!env.graphClientSecret) missing.push("GRAPH_CLIENT_SECRET");
  }
  return { ok: missing.length === 0, missing };
}

/** Secret-safe description for logging — never prints credential values. */
export function describeConfig(): Record<string, string> {
  const mask = (v: string | undefined) => (v ? "set" : "missing");
  return {
    nodeEnv: env.nodeEnv,
    DATABASE_URL: mask(env.databaseUrl),
    CLICKUP_API_TOKEN: mask(env.clickupApiToken),
    GRAPH_TENANT_ID: mask(env.graphTenantId),
    GRAPH_CLIENT_ID: mask(env.graphClientId),
    GRAPH_CLIENT_SECRET: mask(env.graphClientSecret),
    AUTH_ENABLED_PROVIDERS: env.enabledProviders.join(","),
    AUTH_ENTRA_CLIENT_ID: mask(env.authEntraClientId),
    AUTH_ENTRA_CLIENT_SECRET: mask(env.authEntraClientSecret),
    PORTAL_BASE_URL: mask(env.portalBaseUrl),
    AUTO_PUBLISH_ENABLED: String(env.autoPublishEnabled),
    PGPOOL_MAX: String(env.pgPoolMax),
    PG_DISABLE_SSL: String(env.pgDisableSsl),
  };
}
