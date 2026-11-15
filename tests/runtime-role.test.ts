import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { postgres } from "../apps/api/src/db.js";
import { provisionRuntimeRole } from "../apps/api/src/runtime-role.js";
import { testDatabase } from "./database.js";

// Roles are cluster-wide, so this needs a real server (CI's TEST_DATABASE_URL).
test(
  "least-privilege runtime role gets DML only and cannot migrate or create",
  { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL not set" },
  async () => {
    const db = await testDatabase();
    const role = "oj_rt_" + randomUUID().replaceAll("-", "").slice(0, 16);
    const password = randomBytes(32).toString("hex");
    const admin = postgres(process.env.TEST_DATABASE_URL!);
    try {
      assert.deepEqual(await provisionRuntimeRole(db, { role }), {
        role,
        provisioned: false,
      });
      await assert.rejects(
        provisionRuntimeRole(db, { role, password: "short'; DROP" }),
        /RUNTIME_ROLE_PASSWORD/,
      );
      await assert.rejects(provisionRuntimeRole(db, { role: "Bad-Role" }));
      const created = await provisionRuntimeRole(db, { role, password });
      assert.deepEqual(created, {
        role,
        provisioned: true,
        created: true,
        login: true,
      });
      // Idempotent re-run (as after a later migration) keeps the login.
      assert.equal((await provisionRuntimeRole(db, { role })).created, false);
      const schema = (await db.query("SELECT current_schema() AS s")).rows[0].s;
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      url.searchParams.set("options", `-csearch_path=${schema}`);
      const runtime = postgres(url.toString());
      try {
        const id = "runtime-" + randomUUID();
        await runtime.query(
          "INSERT INTO artists(id,name) VALUES($1,'Runtime')",
          [id],
        );
        await runtime.query("UPDATE artists SET name='Renamed' WHERE id=$1", [
          id,
        ]);
        await runtime.query("DELETE FROM artists WHERE id=$1", [id]);
        assert.ok(
          (
            await runtime.query(
              "SELECT count(*)::int AS n FROM schema_migrations",
            )
          ).rows[0].n > 0,
        );
        await assert.rejects(
          runtime.query("INSERT INTO schema_migrations(name) VALUES('x')"),
          /permission denied/,
        );
        await assert.rejects(
          runtime.query("CREATE TABLE runtime_should_fail(id int)"),
          /permission denied/,
        );
        await assert.rejects(
          runtime.query("DROP TABLE schema_migrations"),
          /must be owner|permission denied/,
        );
      } finally {
        await runtime.close();
      }
    } finally {
      await admin.query(`DROP OWNED BY ${role}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.close();
      await db.close();
    }
  },
);
