// =============================================================================
// Scratch-database lifecycle for integration tests (Stage 9a).
//
// The proven pattern from the 8b fresh-install validation: CREATE DATABASE ->
// apply schema.sql -> DROP on teardown. Full isolation so TRUNCATE-based
// equivalence checking never touches a shared database.
//
// Design: we REPOINT process.env.DATABASE_URL at the scratch database before
// the app's db module opens its pool, so the projection engine and the test
// assertions share one connection to the same scratch DB (the engine writes
// through src/server/db.ts's global pool; the test reads through it too).
// =============================================================================

import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ssl = process.env.PG_DISABLE_SSL === "true" ? false : { rejectUnauthorized: false };

function scratchUrl(base: string, dbName: string): string {
  return base.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
}

export interface ScratchDb {
  drop: () => Promise<void>;
}

/**
 * Create + migrate a uniquely-named scratch database and repoint
 * DATABASE_URL at it. Must be called BEFORE any import that opens the app pool
 * triggers getPool(); integration tests import the engine lazily after this.
 */
export async function createScratchDb(tag: string): Promise<ScratchDb> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL required for integration tests");
  const dbName = `scratch_${tag}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, "");

  const admin = new Pool({ connectionString: base, ssl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = scratchUrl(base, dbName);
  process.env.DATABASE_URL = url;

  // Apply the authoritative schema through a throwaway pool (not the app's).
  const schemaPath = resolve(process.cwd(), process.env.SCHEMA_SQL_PATH ?? "../schema.sql");
  const setup = new Pool({ connectionString: url, ssl, max: 1 });
  await setup.query(readFileSync(schemaPath, "utf8"));
  await setup.end();

  return {
    drop: async () => {
      process.env.DATABASE_URL = base;
      const admin2 = new Pool({ connectionString: base, ssl, max: 1 });
      await admin2.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin2.end();
    },
  };
}
