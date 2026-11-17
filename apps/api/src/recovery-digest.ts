import type { Database, Sql } from "./db.js";

// OJ-041 restore verification. Computes a row count and an order-independent
// content digest for every application table inside one read-only snapshot.
// Digests compare databases without exporting any row contents.
export type TableDigest = { table: string; rows: number; digest: string };

const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

export async function databaseDigest(db: Database): Promise<TableDigest[]> {
  return db.transaction(async (tx: Sql) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const tables = (
      await tx.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY table_name",
      )
    ).rows.map((r) => String(r.table_name)).filter((t) => SAFE_TABLE.test(t));
    const out: TableDigest[] = [];
    for (const table of tables) {
      const row = (
        await tx.query(
          `SELECT count(*)::integer n, COALESCE(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), md5('')) d FROM "${table}" t`,
        )
      ).rows[0];
      out.push({ table, rows: row.n, digest: row.d });
    }
    return out;
  });
}

/** Tables expected to change on a live primary after the backup point. */
export const VOLATILE_TABLES = new Set([
  "sessions",
  "platform_admin_sessions",
  "idempotency",
  "event_log",
  "playback_leases",
  "push_deliveries",
  "push_release_fanout",
  "email_dispatch_control",
]);

export function compareDigests(primary: TableDigest[], restored: TableDigest[]) {
  const byName = new Map(restored.map((t) => [t.table, t]));
  const tables = primary.map((p) => {
    const r = byName.get(p.table);
    return {
      table: p.table,
      primaryRows: p.rows,
      restoredRows: r?.rows ?? null,
      match: Boolean(r && r.rows === p.rows && r.digest === p.digest),
      volatile: VOLATILE_TABLES.has(p.table),
    };
  });
  const missing = restored.filter((r) => !primary.some((p) => p.table === r.table)).map((r) => r.table);
  return {
    tables,
    matched: tables.filter((t) => t.match).length,
    mismatchedStable: tables.filter((t) => !t.match && !t.volatile).map((t) => t.table),
    mismatchedVolatile: tables.filter((t) => !t.match && t.volatile).map((t) => t.table),
    onlyInRestore: missing,
  };
}
