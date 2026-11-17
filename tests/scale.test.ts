import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./database.js";
import { createEvent, advance, submitWave, allocate, snapshot, participantOverlay, personalizeSnapshot } from "../apps/api/src/service.js";
import { claimPlayback } from "../apps/api/src/playback.js";
import { eventInput } from "../packages/contracts/src/index.js";
import { RoomSnapshotCache } from "../apps/api/src/live-traffic.js";

test("a shared room snapshot plus a listener overlay equals that listener's full snapshot", async (t) => {
  const db = await testDatabase();
  t.after(() => db.close());
  const e = await createEvent(db, "our-jam", eventInput.parse({ title: "Scale", artistName: "A", slug: "scale-" + randomUUID().slice(0, 8), minimumRoundSeconds: 0, voteMode: "single", votesPerListener: 5, sources: [{ title: "S", corePrompt: "C", durationSeconds: 120 }] }));
  const lease = await claimPlayback(db, "our-jam", e.id);
  const { roundId } = await advance(db, "our-jam", e.id, randomUUID(), 0, { ...lease, sequence: 1 });
  const people = [randomUUID(), randomUUID(), randomUUID()];
  for (const p of people) {
    await db.query("INSERT INTO participants(id,avatar_seed) VALUES($1,'s')", [p]);
    await db.query("INSERT INTO event_members(event_id,participant_id) VALUES($1,$2)", [e.id, p]);
  }
  const a = await submitWave(db, { participantId: people[0] }, roundId, { commandId: randomUUID(), expectedRevision: 0, text: "Low strings" });
  await submitWave(db, { participantId: people[1] }, roundId, { commandId: randomUUID(), expectedRevision: 0, text: "Hand claps" });
  await allocate(db, { participantId: people[2] }, roundId, { commandId: randomUUID(), expectedRevision: 0, allocations: { [a.waveId]: 1 } });
  const base = await snapshot(db, e.slug);
  const strip = (s: any) => ({ ...s, serverTime: undefined });
  for (const p of [...people, randomUUID()]) {
    const full = await snapshot(db, e.slug, p);
    const merged = personalizeSnapshot(base, await participantOverlay(db, e.id, roundId, p), p);
    assert.deepEqual(strip(merged), strip(full));
  }
});

test("room snapshot cache shares one build per window, drops failures and refreshes soon after writes", async () => {
  const cache = new RoomSnapshotCache<number>(750, 500, 100);
  let builds = 0;
  const build = async () => ++builds;
  const results = await Promise.all(Array.from({ length: 1000 }, () => cache.get("room", build, 1000)));
  assert.equal(builds, 1);
  assert.ok(results.every((r) => r === 1));
  assert.equal(await cache.get("room", build, 1500), 1);
  assert.equal(await cache.get("room", build, 1800), 2);
  cache.markDirty(1810);
  assert.equal(await cache.get("room", build, 1850), 2, "a write rebuilds no more often than every 100 ms");
  assert.equal(await cache.get("room", build, 1900), 3);
  cache.clear();
  assert.equal(await cache.get("room", build, 1901), 4);
  await assert.rejects(cache.get("other", () => Promise.reject(new Error("db down")), 2000));
  assert.equal(await cache.get("other", build, 2001), 5);
});
