// =============================================================================
// EntraIDSessionProvider (Stage 8a) — the real SessionProvider.
//
// Resolves the request's session cookie to a portal user via the DB-backed
// session store, then derives RequestScope from portal_users /
// portal_user_business_units. Invariant #3 holds by construction: nothing
// client-supplied is consulted except the opaque session cookie. Requests
// without a valid session throw UnauthenticatedError (mapped to 401 by the
// routes) — THIS is the security boundary; middleware is UX only.
// =============================================================================

import { cookies } from "next/headers";
import { query } from "../db";
import { SESSION_COOKIE_NAME } from "@/lib/authCookies";
import { UnauthenticatedError } from "../auth/errors";
import { resolveSession, type ResolvedSession } from "../auth/sessionStore";
import type { SessionResponse } from "@/lib/types";
import type { RequestScope, SessionProvider } from "./session";

interface BuRow {
  id: string;
  name: string;
}

export class EntraIDSessionProvider implements SessionProvider {
  private async requireSession(): Promise<ResolvedSession> {
    const rawToken = cookies().get(SESSION_COOKIE_NAME)?.value;
    if (!rawToken) throw new UnauthenticatedError();
    const session = await resolveSession(rawToken);
    if (!session) throw new UnauthenticatedError();
    return session;
  }

  /**
   * Active business units the user is scoped to (grants path). The account
   * filter is defence-in-depth: db:verify forbids cross-account grants, but
   * this layer must never emit a foreign BU id even on bad data.
   */
  private async grantedBusinessUnits(userId: string, accountId: string): Promise<BuRow[]> {
    const res = await query<BuRow>(
      `SELECT b.id, b.name
         FROM portal_user_business_units g
         JOIN business_units b ON b.id = g.business_unit_id
        WHERE g.user_id = $1 AND b.account_id = $2 AND b.is_active = TRUE
        ORDER BY b.name`,
      [userId, accountId]
    );
    return res.rows;
  }

  private async accountBusinessUnits(accountId: string): Promise<BuRow[]> {
    const res = await query<BuRow>(
      `SELECT id, name FROM business_units
        WHERE account_id = $1 AND is_active = TRUE
        ORDER BY name`,
      [accountId]
    );
    return res.rows;
  }

  async getScope(): Promise<RequestScope> {
    const s = await this.requireSession();
    if (s.accountWide) {
      return { accountId: s.accountId, businessUnitIds: null };
    }
    // Empty grants => empty list => queries match nothing (fail closed).
    const bus = await this.grantedBusinessUnits(s.userId, s.accountId);
    return { accountId: s.accountId, businessUnitIds: bus.map((b) => b.id) };
  }

  async getSession(): Promise<SessionResponse> {
    const s = await this.requireSession();
    const bus = s.accountWide
      ? await this.accountBusinessUnits(s.accountId)
      : await this.grantedBusinessUnits(s.userId, s.accountId);
    return {
      user: { id: s.userId, email: s.email, displayName: s.displayName },
      account: { id: s.accountId, name: s.accountName },
      accountWide: s.accountWide,
      businessUnits: bus.map((b) => ({ id: b.id, name: b.name })),
    };
  }
}
