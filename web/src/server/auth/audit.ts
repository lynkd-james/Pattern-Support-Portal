// =============================================================================
// Login auditing (server-only; provider-agnostic since Stage 8b).
//
// Every admitted AND denied login writes an audit_events row
// (change_source = 'PORTAL'). Denials record the identity provider, the
// token's issuer namespace, the internal reason code and a truncated hash of
// the claimed email — repeated denials from an unknown namespace are attack
// telemetry (Stage 8a Amendment 1). The client-facing response stays
// information-free; detail lives here and in server logs only.
//
// Payload note: Stage 8a rows used key `tid`; Stage 8b onwards uses
// `provider` + `namespace`. Historical rows retain the old key (append-only
// audit; both forms exist in history and are documented in docs/auth.md).
// =============================================================================

import { query } from "../db";
import {
  emailTelemetryHash,
  type IdentityProviderId,
  type LoginDenyReason,
} from "./identity";

/** audit_events.entity_id is NOT NULL; used when no portal user matched. */
const UNKNOWN_ENTITY = "00000000-0000-0000-0000-000000000000";

export async function auditLoginDenied(args: {
  provider: IdentityProviderId;
  namespace: string | null;
  reason: LoginDenyReason;
  claimedEmail: string | null;
  userId?: string | null;
  accountId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('portal_user', $1, $2, 'login_denied', NULL, $3::jsonb, 'PORTAL', 'portal')`,
    [
      args.userId ?? UNKNOWN_ENTITY,
      args.accountId ?? null,
      JSON.stringify({
        provider: args.provider,
        namespace: args.namespace,
        reason: args.reason,
        emailHash: emailTelemetryHash(args.claimedEmail),
      }),
    ]
  );
}

export async function auditLoginAdmitted(args: {
  userId: string;
  accountId: string;
  provider: IdentityProviderId;
  namespace: string;
  bound: boolean; // true when this login performed the first-login subject binding
}): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('portal_user', $1, $2, 'login', NULL, $3::jsonb, 'PORTAL', 'portal')`,
    [
      args.userId,
      args.accountId,
      JSON.stringify({
        provider: args.provider,
        namespace: args.namespace,
        bound: args.bound,
      }),
    ]
  );
}
