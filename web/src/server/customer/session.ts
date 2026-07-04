// =============================================================================
// Session abstraction (server-only).
//
//   SessionProvider                      <- the API depends ONLY on this
//     ├── PlaceholderSessionProvider     <- dev only (no real auth)
//     └── EntraIDSessionProvider         <- Stage 8a (AUTH_PROVIDER=entra)
//
// The API resolves scope/session via `getSessionProvider()` and never knows
// which concrete provider is in use. The factory switches on AUTH_PROVIDER and
// refuses to run the placeholder in production without an explicit override.
//
// Contract invariant preserved: the client NEVER sends an account id; scope is
// always resolved server-side.
// =============================================================================

import { env } from "../env";
import { query } from "../db";
import { EntraIDSessionProvider } from "./entraSession";
import type { SessionResponse } from "@/lib/types";

export interface RequestScope {
  accountId: string;
  /** null => account-wide (all business units in the account). */
  businessUnitIds: string[] | null;
}

export interface SessionProvider {
  /** Tenant scope used to filter every customer-projection read. */
  getScope(): Promise<RequestScope>;
  /** Identity + scope payload for GET /api/session. */
  getSession(): Promise<SessionResponse>;
}

// -----------------------------------------------------------------------------
// Placeholder provider — NO real authentication yet. Resolves a single,
// server-configured account (account-wide). Replaced, not edited, in Stage 8.
// -----------------------------------------------------------------------------

class PlaceholderSessionProvider implements SessionProvider {
  private readonly accountSlug = process.env.PORTAL_ACCOUNT_SLUG?.trim() || "pepkor";

  private async loadAccount(): Promise<{ id: string; name: string }> {
    const res = await query<{ id: string; name: string }>(
      "SELECT id, name FROM accounts WHERE slug = $1 AND is_active = TRUE",
      [this.accountSlug]
    );
    const account = res.rows[0];
    if (!account) {
      throw new Error(
        `Placeholder scope account "${this.accountSlug}" not found. Seed it (npm run db:seed).`
      );
    }
    return account;
  }

  async getScope(): Promise<RequestScope> {
    const account = await this.loadAccount();
    return { accountId: account.id, businessUnitIds: null };
  }

  async getSession(): Promise<SessionResponse> {
    const account = await this.loadAccount();
    const bus = await query<{ id: string; name: string }>(
      "SELECT id, name FROM business_units WHERE account_id = $1 AND is_active = TRUE ORDER BY name",
      [account.id]
    );
    return {
      user: {
        id: "dev-placeholder",
        email: "dev@pattern.local",
        displayName: "Development User (no auth)",
      },
      account: { id: account.id, name: account.name },
      accountWide: true,
      businessUnits: bus.rows.map((b) => ({ id: b.id, name: b.name })),
    };
  }
}

// -----------------------------------------------------------------------------
// Factory — the single seam the API depends on. Switches on AUTH_PROVIDER.
// -----------------------------------------------------------------------------

let provider: SessionProvider | null = null;

export function getSessionProvider(): SessionProvider {
  if (!provider) {
    if (env.authProvider === "entra") {
      provider = new EntraIDSessionProvider();
    } else if (env.authProvider === "placeholder") {
      // Fail-fast guard: the placeholder performs NO authentication and must
      // never run in production unless explicitly overridden.
      if (env.nodeEnv === "production" && !env.allowPlaceholderAuth) {
        throw new Error(
          "AUTH_PROVIDER=placeholder is not allowed in production. " +
            "Set AUTH_PROVIDER=entra (or ALLOW_PLACEHOLDER_AUTH=true to override explicitly)."
        );
      }
      provider = new PlaceholderSessionProvider();
    } else {
      throw new Error(
        `Unknown AUTH_PROVIDER "${env.authProvider}". Use "entra" or "placeholder".`
      );
    }
  }
  return provider;
}
