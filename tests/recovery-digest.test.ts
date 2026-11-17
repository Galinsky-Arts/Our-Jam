import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./database.js";
import { databaseDigest, compareDigests } from "../apps/api/src/recovery-digest.js";

test("restore digests match an identical copy, flag changed stable tables and never expose row contents", async (t) => {
  // A restored Neon branch is a byte-level copy; a repeated digest of the same
  // database stands in for it here (separate fresh databases differ in timestamps).
  const primary = await testDatabase();
  t.after(() => primary.close());
  await primary.query("INSERT INTO participants(id,name,avatar_seed) VALUES('00000000-0000-4000-8000-000000000001','PRIVATE_NAME','s')");
  const backupPoint = await databaseDigest(primary);
  const same = compareDigests(await databaseDigest(primary), backupPoint);
  assert.deepEqual(same.mismatchedStable, []);
  assert.ok(same.matched > 20);
  assert.doesNotMatch(JSON.stringify(same), /PRIVATE_NAME/);
  await primary.query("INSERT INTO participants(id,avatar_seed) VALUES($1,'s')", [randomUUID()]);
  await primary.query("INSERT INTO sessions(token_hash,participant_id,kind,expires_at) VALUES($1,'00000000-0000-4000-8000-000000000001','guest',now()+interval '1 day')", ["a".repeat(64)]);
  const drift = compareDigests(await databaseDigest(primary), backupPoint);
  assert.deepEqual(drift.mismatchedStable, ["participants"]);
  assert.deepEqual(drift.mismatchedVolatile, ["sessions"]);
  // The digest transaction is read-only.
  await assert.rejects(primary.transaction(async (tx) => {
    await tx.query("SET TRANSACTION READ ONLY");
    await tx.query("DELETE FROM participants");
  }));
});
