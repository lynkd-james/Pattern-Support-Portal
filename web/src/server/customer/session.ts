// =============================================================================
// Session abstraction (server-only).
//
//   SessionProvider                      <- the API depends ONLY on this
//     ├── PlaceholderSessionProvider     <- active now (no real auth)
//     └── EntraIDSessionProvider         <- added in Stage 8 (provider swap)
//
// The API resolves scope/session via `getSessionProvider()` and never knows which
// concrete provider is in use. Wiring real auth in Stage 8 is therefore a swap in
// the factory below — not an API rewrite.
//
// Contract invariant preserved: the client NEVER sends an account id; scope is
// always resolved server-side.
// =============================================================================

import { query } from "../db";
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
// Factory — the single seam the API depends on.
// Stage 8: return new EntraIDSessionProvider() (e.g. when AUTH_PROVIDER==='entra').
// -----------------------------------------------------------------------------

let provider: SessionProvider | null = null;

export function getSessionProvider(): SessionProvider {
  if (!provider) {
    provider = new PlaceholderSessionProvider();
  }
  return provider;
}
