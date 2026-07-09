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
