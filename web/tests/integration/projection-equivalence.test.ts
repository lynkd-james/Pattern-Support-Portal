// =============================================================================
// Projection equivalence — integration suite (Stage 9a), scratch database.
//
// Proves the first-class property (docs/projection.md, docs/shared-tickets.md
// invariant 5): the customer projection is a DETERMINISTIC PURE FUNCTION of
// the internal model — an incremental projection and a from-scratch rebuild
// converge to the same projection state.
//
// SCOPE OF EQUIVALENCE — published rows + their timelines (the portal-
// observable surface). See the FINDING at the bottom of this file: hidden
// TOMBSTONES are path-dependent history (they exist only where a row was once
// published and later unpublished) and therefore CANNOT be reproduced by a
// truncate-rebuild from current internal state. They are correctly excluded
// from the equivalence set; a dedicated case below demonstrates exactly that
// and asserts the tombstone/remove distinction directly.
//
// Cases: single-BU fan-out, shared fan-out, de-listed BU (hard remove),
// unpublish (tombstone), and incremental == rebuild over the published surface.
// =============================================================================

// AUTO_PUBLISH must be read as true when env.ts is first imported.
process.env.AUTO_PUBLISH_ENABLED = "true";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createScratchDb, type ScratchDb } from "../helpers/scratchDb";

// Lazily imported AFTER the scratch DB repoints DATABASE_URL.
type DB = typeof import("@/server/db");
type Projion = typeof import("@/server/projection/transform");
let db: DB;
let projection: Projion;

let scratch: ScratchDb;

// Fixture ids
const ACC = { ayana: "", refinery: "", ww: "" };
const BU = { ayn: "", rfry: "", ww: "" };

async function seedReference(): Promise<void> {
  const acc = async (name: string, slug: string) =>
    (await db.query<{ id: string }>(
      `INSERT INTO accounts (name, slug, is_active) VALUES ($1,$2,TRUE) RETURNING id`,
      [name, slug]
    )).rows[0].id;
  const bu = async (accountId: string, name: string, slug: string) =>
    (await db.query<{ id: string }>(
      `INSERT INTO business_units (account_id, name, slug, is_active) VALUES ($1,$2,$3,TRUE) RETURNING id`,
      [accountId, name, slug]
    )).rows[0].id;

  ACC.ayana = await acc("Ayana", "ayn");
  ACC.refinery = await acc("Refinery", "rfry");
  ACC.ww = await acc("Woolworths", "ww");
  BU.ayn = await bu(ACC.ayana, "Ayana", "AYN");
  BU.rfry = await bu(ACC.refinery, "Refinery", "RFRY");
  BU.ww = await bu(ACC.ww, "Woolworths", "WW");
}

/** Insert a canonical internal ticket + its visibility junction + one event. */
async function insertTicket(args: {
  number: string;
  buIds: string[];
  origin: { accountId: string; buId: string } | null;
  stage?: string;
  updatedAt?: string;
}): Promise<string> {
  const stage = args.stage ?? "NEW";
  const id = (await db.query<{ id: string }>(
    `INSERT INTO internal_tickets
       (account_id, business_unit_id, ticket_number, clickup_task_id, title_internal,
        priority, current_stage, clickup_raw_status, created_at, content_hash, updated_at)
     VALUES ($1,$2,$3,$4,$5,'P2'::priority_level,$6::portal_stage,'to do', now(), $7, COALESCE($8::timestamptz, now()))
     RETURNING id`,
    [
      args.origin?.accountId ?? null,
      args.origin?.buId ?? null,
      args.number,
      `cu-${args.number}`,
      `Ticket ${args.number}`,
      stage,
      `hash-${args.number}`,
      args.updatedAt ?? null,
    ]
  )).rows[0].id;

  for (const buId of args.buIds) {
    await db.query(
      `INSERT INTO internal_ticket_business_units (internal_ticket_id, business_unit_id) VALUES ($1,$2)`,
      [id, buId]
    );
  }
  await db.query(
    `INSERT INTO internal_ticket_events (internal_ticket_id, to_stage, changed_at, source)
     VALUES ($1,$2::portal_stage, now(), 'SYNC')`,
    [id, stage]
  );
  return id;
}

/** Normalised snapshot of the PUBLISHED projection surface (equivalence set). */
async function publishedSnapshot(): Promise<string> {
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT it.ticket_number, ct.business_unit_id, ct.account_id, ct.title, ct.description,
            ct.priority, ct.stage, ct.response_sla_state, ct.resolution_sla_state
       FROM customer_tickets ct
       JOIN internal_tickets it ON it.id = ct.internal_ticket_id
      WHERE ct.visibility_state = 'published'
      ORDER BY it.ticket_number, ct.business_unit_id`
  )).rows;
  const timelines = (await db.query<Record<string, unknown>>(
    `SELECT it.ticket_number, ct.business_unit_id, tl.stage, tl.label, tl.occurred_at
       FROM customer_ticket_timeline tl
       JOIN customer_tickets ct ON ct.id = tl.customer_ticket_id
       JOIN internal_tickets it ON it.id = ct.internal_ticket_id
      WHERE ct.visibility_state = 'published'
      ORDER BY it.ticket_number, ct.business_unit_id, tl.occurred_at, tl.stage`
  )).rows;
  return JSON.stringify({ rows, timelines });
}

beforeAll(async () => {
  scratch = await createScratchDb("proj_equiv");
  db = await import("@/server/db");
  projection = await import("@/server/projection/transform");
  await seedReference();
}, 120_000);

afterAll(async () => {
  if (db) await db.closePool();
  if (scratch) await scratch.drop();
});

describe("projection fan-out and lifecycle", () => {
  it("shared ticket fans out to one published row per visible BU; single-BU to one", async () => {
    await insertTicket({ number: "PAT3-100", buIds: [BU.ayn, BU.rfry], origin: null });
    await insertTicket({ number: "PAT3-200", buIds: [BU.ww], origin: { accountId: ACC.ww, buId: BU.ww } });
    await projection.runProjection({ mode: "incremental" });

    const shared = (await db.query<{ n: string }>(
      `SELECT count(*) n FROM customer_tickets ct JOIN internal_tickets it ON it.id=ct.internal_ticket_id
        WHERE it.ticket_number='PAT3-100' AND ct.visibility_state='published'`
    )).rows[0].n;
    const single = (await db.query<{ n: string }>(
      `SELECT count(*) n FROM customer_tickets ct JOIN internal_tickets it ON it.id=ct.internal_ticket_id
        WHERE it.ticket_number='PAT3-200' AND ct.visibility_state='published'`
    )).rows[0].n;
    expect(shared).toBe("2");
    expect(single).toBe("1");
  });

  it("de-listing a BU hard-removes only that row; the surviving row keeps its identity", async () => {
    // Capture the surviving (AYN) row id before mutation.
    const before = (await db.query<{ id: string }>(
      `SELECT ct.id FROM customer_tickets ct JOIN internal_tickets it ON it.id=ct.internal_ticket_id
        WHERE it.ticket_number='PAT3-100' AND ct.business_unit_id=$1`,
      [BU.ayn]
    )).rows[0].id;

    // De-list Refinery from PAT3-100 and bump updated_at so incremental sees it.
    const tid = (await db.query<{ id: string }>(`SELECT id FROM internal_tickets WHERE ticket_number='PAT3-100'`)).rows[0].id;
    await db.query(`DELETE FROM internal_ticket_business_units WHERE internal_ticket_id=$1 AND business_unit_id=$2`, [tid, BU.rfry]);
    await db.query(`UPDATE internal_tickets SET updated_at = now() WHERE id=$1`, [tid]);
    await projection.runProjection({ mode: "incremental" });

    const rfryRow = (await db.query<{ n: string }>(
      `SELECT count(*) n FROM customer_tickets WHERE internal_ticket_id=$1 AND business_unit_id=$2`,
      [tid, BU.rfry]
    )).rows[0].n;
    const aynRow = (await db.query<{ id: string }>(
      `SELECT id FROM customer_tickets WHERE internal_ticket_id=$1 AND business_unit_id=$2`,
      [tid, BU.ayn]
    )).rows[0];
    expect(rfryRow).toBe("0"); // hard-removed (scope gone)
    expect(aynRow.id).toBe(before); // surgical: same row, not delete-and-recreate
  });

  it("incremental state == truncate-rebuild state, over the published surface", async () => {
    const incremental = await publishedSnapshot();

    await db.query(`TRUNCATE customer_ticket_timeline, customer_tickets RESTART IDENTITY CASCADE`);
    await projection.runProjection({ mode: "rebuild" });
    const rebuilt = await publishedSnapshot();

    expect(rebuilt).toBe(incremental);
  });

  it("FINDING: a tombstone is path-dependent — present after incremental, ABSENT after truncate-rebuild", async () => {
    // Publish a fresh ticket, then unpublish it (ADMIN visibility decision).
    const tid = await insertTicket({ number: "PAT3-300", buIds: [BU.ww], origin: { accountId: ACC.ww, buId: BU.ww } });
    await projection.runProjection({ mode: "incremental" });
    // Simulate an ADMIN unpublish: force internal visibility + ADMIN-lock audit.
    await db.query(`UPDATE internal_tickets SET visibility_state='hidden_from_customer', updated_at=now() WHERE id=$1`, [tid]);
    await db.query(
      `INSERT INTO audit_events (entity_type, entity_id, account_id, field, old_value, new_value, change_source, actor)
       VALUES ('internal_ticket',$1,$2,'visibility_state','"published"','"hidden_from_customer"','ADMIN','test')`,
      [tid, ACC.ww]
    );
    await projection.runProjection({ mode: "incremental" });

    const tombstone = (await db.query<{ visibility_state: string }>(
      `SELECT visibility_state FROM customer_tickets WHERE internal_ticket_id=$1 AND business_unit_id=$2`,
      [tid, BU.ww]
    )).rows;
    // Incremental leaves a hidden tombstone (row was published, scope still exists).
    expect(tombstone.length).toBe(1);
    expect(tombstone[0].visibility_state).toBe("hidden_from_customer");

    // Truncate-rebuild cannot recreate it: from empty, an unpublished ticket
    // produces no row. This is why equivalence is defined over PUBLISHED rows.
    await db.query(`TRUNCATE customer_ticket_timeline, customer_tickets RESTART IDENTITY CASCADE`);
    await projection.runProjection({ mode: "rebuild" });
    const afterRebuild = (await db.query<{ n: string }>(
      `SELECT count(*) n FROM customer_tickets WHERE internal_ticket_id=$1`,
      [tid]
    )).rows[0].n;
    expect(afterRebuild).toBe("0");
  });
});
