import type { Database } from "./db.js";

// Least-privilege runtime login, applied with the migration-owner connection.
// Mirrors db/runtime-grants.sql but targets the connection's actual database
// and schema. Neon API-created roles join neon_superuser, so this role is
// created with SQL instead. Re-running is idempotent and re-grants new tables.
const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const PASSWORD = /^[A-Za-z0-9]{32,128}$/;
const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface RuntimeRoleResult {
  role: string;
  provisioned: boolean;
  created?: boolean;
  login?: boolean;
}

export async function provisionRuntimeRole(
  db: Database,
  options: { role?: string; password?: string } = {},
): Promise<RuntimeRoleResult> {
  const role = options.role ?? "our_jam_app";
  if (!ROLE.test(role)) throw new Error("Invalid runtime role name.");
  const password = options.password;
  if (password !== undefined && !PASSWORD.test(password))
    throw new Error(
      "RUNTIME_ROLE_PASSWORD must be 32-128 ASCII letters and digits.",
    );
  return db.transaction(async (tx) => {
    const context = (
      await tx.query(
        "SELECT current_database() AS database, current_schema() AS schema",
      )
    ).rows[0];
    const exists =
      (await tx.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows
        .length > 0;
    if (!exists && password === undefined) return { role, provisioned: false };
    // The password is validated to letters/digits above, so literal quoting is safe.
    if (!exists)
      await tx.query(
        `CREATE ROLE ${role} NOINHERIT NOCREATEDB NOCREATEROLE ${password ? `LOGIN PASSWORD '${password}'` : "NOLOGIN"}`,
      );
    else if (password)
      await tx.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    const schema = quoteIdent(context.schema);
    for (const statement of [
      `GRANT CONNECT ON DATABASE ${quoteIdent(context.database)} TO ${role}`,
      `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
      `REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${schema}.schema_migrations FROM ${role}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
    ])
      await tx.query(statement);
    const check = (
      await tx.query(
        `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication, r.rolcanlogin,
           EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid
                   WHERE m.member=r.oid AND g.rolname IN ('neon_superuser','pg_write_all_data','pg_read_all_data')) AS admin_member,
           has_schema_privilege(r.oid, $2, 'CREATE') AS schema_create,
           has_table_privilege(r.oid, $3, 'INSERT') AS migration_insert,
           EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname=$2 AND t.tableowner=r.rolname) AS owns_tables
         FROM pg_roles r WHERE r.rolname=$1`,
        [role, context.schema, `${schema}.schema_migrations`],
      )
    ).rows[0];
    for (const unsafe of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolbypassrls",
      "rolreplication",
      "admin_member",
      "schema_create",
      "migration_insert",
      "owns_tables",
    ])
      if (check[unsafe])
        throw new Error(`Runtime role ${role} is over-privileged: ${unsafe}.`);
    return {
      role,
      provisioned: true,
      created: !exists,
      login: Boolean(check.rolcanlogin),
    };
  });
}
