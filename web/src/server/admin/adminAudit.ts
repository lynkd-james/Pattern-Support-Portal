// =============================================================================
// Admin login auditing (Stage 10a). Same append-only audit_events table and
// telemetry discipline as the customer auth audit, with entity_type
// 'admin_user' so staff sign-ins are cleanly distinguishable from customer
// ones. Denials record provider + namespace + reason + truncated email hash.
// =============================================================================

import { query } from "../db";
import {
  emailTelemetryHash,
  type IdentityProviderId,
  type LoginDenyReason,
} from "../auth/identity";

const UNKNOWN_ENTITY = "00000000-0000-0000-0000-000000000000";

export async function auditAdminLoginDenied(args: {
  provider: IdentityProviderId;
  namespace: string | null;
  reason: LoginDenyReason;
  claimedEmail: string | null;
  userId?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('admin_user', $1, NULL, 'login_denied', NULL, $2::jsonb, 'ADMIN', 'admin')`,
    [
      args.userId ?? UNKNOWN_ENTITY,
      JSON.stringify({
        provider: args.provider,
        namespace: args.namespace,
        reason: args.reason,
        emailHash: emailTelemetryHash(args.claimedEmail),
      }),
    ]
  );
}

export async function auditAdminLoginAdmitted(args: {
  userId: string;
  provider: IdentityProviderId;
  namespace: string;
  bound: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO audit_events
       (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('admin_user', $1, NULL, 'login', NULL, $2::jsonb, 'ADMIN', 'admin')`,
    [args.userId, JSON.stringify({ provider: args.provider, namespace: args.namespace, bound: args.bound })]
  );
}
