// =============================================================================
// Admin realm — integration suite (Stage 10a), scratch database.
//
// Proves: (1) the admin session store round-trips; (2) REALM ISOLATION is
// structural — a customer session token never resolves in the admin store and
// an admin token never resolves in the customer store (distinct tables); (3)
// the admin query layer reads the internal layer correctly (stats, ticket
// list incl. shared flag, ticket detail, quarantine-from-sync_runs).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createScratchDb, type ScratchDb } from "../helpers/scratchDb";

let db: typeof import("@/server/db");
let adminStore: typeof import("@/server/admin/adminSessionStore");
let customerStore: typeof import("@/server/auth/sessionStore");
let adminQueries: typeof import("@/server/admin/queries");
let scratch: ScratchDb;

const ids = { account: "", bu: "", ticket: "", adminUser: "", portalUser: "" };

beforeAll(async () => {
  scratch = await createScratchDb("admin_realm");
  db = await import("@/server/db");
  adminStore = await import("@/server/admin/adminSessionStore");
  customerStore = await import("@/server/auth/sessionStore");
  adminQueries = await import("@/server/admin/queries");

  ids.account = (await db.query<{ id: string }>(
    `INSERT INTO accounts (name, slug, is_active) VALUES ('Ayana','ayn',TRUE) RETURNING id`
  )).rows[0].id;
  ids.bu = (await db.query<{ id: string }>(
    `INSERT INTO business_units (account_id, name, slug, is_active) VALUES ($1,'Ayana','AYN',TRUE) RETURNING id`,
    [ids.account]
  )).rows[0].id;
  // A shared-looking internal ticket + junction + published projection.
  ids.ticket = (await db.query<{ id: string }>(
    `INSERT INTO internal_tickets (account_id,business_unit_id,ticket_number,clickup_task_id,title_internal,priority,current_stage,clickup_raw_status,created_at,content_hash)
     VALUES ($1,$2,'PAT3-A1','cu-a1','Admin realm test','P2'::priority_level,'NEW'::portal_stage,'to do',now(),'h')
     RETURNING id`,
    [ids.account, ids.bu]
  )).rows[0].id;
  await db.query(`INSERT INTO internal_ticket_business_units (internal_ticket_id,business_unit_id) VALUES ($1,$2)`, [ids.ticket, ids.bu]);
  await db.query(
    `INSERT INTO customer_tickets (internal_ticket_id,account_id,business_unit_id,ticket_number,title,priority,stage,created_at,visibility_state,published_at)
     VALUES ($1,$2,$3,'PAT3-A1','Admin realm test','P2'::priority_level,'NEW'::portal_stage,now(),'published',now())`,
    [ids.ticket, ids.account, ids.bu]
  );
  // A clickup sync_runs row carrying a quarantine in details.
  await db.query(
    `INSERT INTO sync_runs (source_system,status,finished_at,details)
     VALUES ('clickup','SUCCESS',now(),'{"quarantines":[{"reason":"SLA_PRIORITY_MISSING","customId":"PAT3-X","detail":"no SLA"}]}'::jsonb)`
  );
  // Admin + customer users.
  ids.adminUser = (await db.query<{ id: string }>(
    `INSERT INTO admin_users (email, identity_provider, issuer_namespace, subject_identifier, role, is_active)
     VALUES ('admin@pattern.local','entra','pattern-tid','admin-sub','admin',TRUE) RETURNING id`
  )).rows[0].id;
  ids.portalUser = (await db.query<{ id: string }>(
    `INSERT INTO portal_users (account_id,email,account_wide,identity_provider,issuer_namespace,subject_identifier,is_active)
     VALUES ($1,'cust@ayn.local',TRUE,'entra','ayn-tid','cust-sub',TRUE) RETURNING id`,
    [ids.account]
  )).rows[0].id;
  // A ticket-scoped audit event (Stage 10b: entityLabel resolution).
  await db.query(
    `INSERT INTO audit_events (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
     VALUES ('internal_ticket', $1, $2, 'current_stage', '"NEW"'::jsonb, '"ACKNOWLEDGED"'::jsonb, 'SYNC', 'sync')`,
    [ids.ticket, ids.account]
  );
}, 120_000);

afterAll(async () => {
  if (db) await db.closePool();
  if (scratch) await scratch.drop();
});

describe("admin session store + realm isolation", () => {
  it("admin session round-trips", async () => {
    const { rawToken } = await adminStore.createAdminSession(ids.adminUser, { userAgent: "t", ip: null });
    const resolved = await adminStore.resolveAdminSession(rawToken);
    expect(resolved?.adminUserId).toBe(ids.adminUser);
    expect(resolved?.role).toBe("admin");
  });

  it("a CUSTOMER token never resolves in the admin store", async () => {
    const { rawToken } = await customerStore.createSession(ids.portalUser, { userAgent: "t", ip: null });
    expect(await adminStore.resolveAdminSession(rawToken)).toBeNull();
    // sanity: it DOES resolve in its own store
    expect((await customerStore.resolveSession(rawToken))?.userId).toBe(ids.portalUser);
  });

  it("an ADMIN token never resolves in the customer store", async () => {
    const { rawToken } = await adminStore.createAdminSession(ids.adminUser, { userAgent: "t", ip: null });
    expect(await customerStore.resolveSession(rawToken)).toBeNull();
    expect((await adminStore.resolveAdminSession(rawToken))?.adminUserId).toBe(ids.adminUser);
  });

  it("a deactivated admin's live session stops resolving", async () => {
    const { rawToken } = await adminStore.createAdminSession(ids.adminUser, { userAgent: "t", ip: null });
    expect(await adminStore.resolveAdminSession(rawToken)).not.toBeNull();
    await db.query(`UPDATE admin_users SET is_active=FALSE WHERE id=$1`, [ids.adminUser]);
    expect(await adminStore.resolveAdminSession(rawToken)).toBeNull();
    await db.query(`UPDATE admin_users SET is_active=TRUE WHERE id=$1`, [ids.adminUser]);
  });
});

describe("admin query layer (internal-layer reads)", () => {
  it("stats reflect the seeded ticket", async () => {
    const s = await adminQueries.getStats();
    expect(s.tickets.total).toBe(1);
    expect(s.tickets.open).toBe(1);
    expect(s.exposure.published).toBe(1);
    expect(s.quarantinedLatest).toBe(1);
  });

  it("ticket list returns the ticket with BU + published flag", async () => {
    const { data, pagination } = await adminQueries.listTickets({});
    expect(pagination.totalItems).toBe(1);
    expect(data[0].ticketNumber).toBe("PAT3-A1");
    expect(data[0].businessUnits).toEqual(["AYN"]);
    expect(data[0].published).toBe(true);
    expect(data[0].shared).toBe(false);
  });

  it("ticket detail includes timeline, projections and visibility BUs", async () => {
    const d = await adminQueries.getTicketDetail(ids.ticket);
    expect(d).not.toBeNull();
    const projections = (d as { projections: unknown[] }).projections;
    expect(projections.length).toBe(1);
  });

  it("quarantine aggregates from the latest clickup sync_runs details", async () => {
    const q = await adminQueries.getQuarantineLatest();
    expect(q.total).toBe(1);
    expect(q.byReason.SLA_PRIORITY_MISSING).toBe(1);
  });
});

// =============================================================================
// Stage 10b — additive API extensions (invariant 10b-5). Everything above
// this line is the UNMODIFIED 10a behaviour still passing; below is new.
// =============================================================================

describe("10b: stats sync summary + typed contracts", () => {
  it("stats.sync reports the latest terminal run per source", async () => {
    const s = await adminQueries.getStats();
    const clickup = s.sync.find((r) => r.sourceSystem === "clickup");
    expect(clickup?.status).toBe("SUCCESS");
    expect(s.sync.every((r) => r.status !== "RUNNING")).toBe(true);
  });

  it("sync-runs rows carry the per-run quarantined count", async () => {
    const runs = await adminQueries.listSyncRuns();
    const run = runs.find((r) => r.sourceSystem === "clickup");
    expect(run?.quarantined).toBe(1);
    expect(run?.status).toBe("SUCCESS");
  });

  it("ticket detail is the explicit camelCase DTO", async () => {
    const d = await adminQueries.getTicketDetail(ids.ticket);
    expect(d?.ticket.ticketNumber).toBe("PAT3-A1");
    expect(d?.ticket.visibilityBusinessUnits).toEqual(["AYN"]);
    expect(d?.ticket.originAccountId).toBe(ids.account);
    expect(d?.projections[0].businessUnitSlug).toBe("AYN");
    expect(d?.projections[0].visibilityState).toBe("published");
    expect(d?.audit.length).toBeGreaterThan(0);
  });
});

describe("10b: ticket list filters (server-side, additive)", () => {
  it("accountId filter matches via the visibility junction", async () => {
    const hit = await adminQueries.listTickets({ accountId: ids.account });
    expect(hit.pagination.totalItems).toBe(1);
    const miss = await adminQueries.listTickets({ accountId: "00000000-0000-0000-0000-000000000000" });
    expect(miss.pagination.totalItems).toBe(0);
  });

  it("visibility filter: state match and 'none'", async () => {
    expect((await adminQueries.listTickets({ visibility: "published" })).pagination.totalItems).toBe(1);
    expect((await adminQueries.listTickets({ visibility: "hidden_from_customer" })).pagination.totalItems).toBe(0);
    expect((await adminQueries.listTickets({ visibility: "none" })).pagination.totalItems).toBe(0);
  });

  it("received/updated date ranges bound the set; invalid dates are ignored", async () => {
    expect((await adminQueries.listTickets({ receivedFrom: "2000-01-01" })).pagination.totalItems).toBe(1);
    expect((await adminQueries.listTickets({ receivedTo: "2000-01-01" })).pagination.totalItems).toBe(0);
    expect((await adminQueries.listTickets({ updatedFrom: "2000-01-01" })).pagination.totalItems).toBe(1);
    expect((await adminQueries.listTickets({ receivedFrom: "not-a-date" })).pagination.totalItems).toBe(1);
  });

  it("sort is whitelist-only (unknown value falls back to default) and returns updatedAt", async () => {
    const res = await adminQueries.listTickets({ sort: "updatedAt:asc" });
    expect(res.data[0].updatedAt).toBeTruthy();
    const fallback = await adminQueries.listTickets({ sort: "evil; DROP TABLE--" });
    expect(fallback.pagination.totalItems).toBe(1); // executed safely as default sort
  });
});

describe("10b: audit filters + reference", () => {
  it("audit rows resolve entityLabel to the ticket number", async () => {
    const rows = await adminQueries.listAudit({ entityType: "internal_ticket" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].entityLabel).toBe("PAT3-A1");
  });

  it("audit filters: changeSource, search by ticket number, keyset beforeId", async () => {
    expect((await adminQueries.listAudit({ changeSource: "SYNC" })).length).toBeGreaterThan(0);
    expect((await adminQueries.listAudit({ changeSource: "PORTAL" })).length).toBe(0);
    const byNumber = await adminQueries.listAudit({ search: "PAT3-A1" });
    expect(byNumber.length).toBeGreaterThan(0);
    const first = (await adminQueries.listAudit({}))[0];
    const older = await adminQueries.listAudit({ beforeId: first.id });
    expect(older.every((r) => r.id < first.id)).toBe(true);
  });

  it("reference lists accounts and business units for the filter dropdowns", async () => {
    const ref = await adminQueries.getReference();
    expect(ref.accounts.some((a) => a.slug === "ayn" && a.isActive)).toBe(true);
    expect(ref.businessUnits.some((b) => b.slug === "AYN" && b.accountId === ids.account)).toBe(true);
  });
});
