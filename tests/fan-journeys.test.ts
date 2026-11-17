import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./database.js";
import type { Database } from "../apps/api/src/db.js";
import { createEvent, advance, submitWave, allocate } from "../apps/api/src/service.js";
import { claimPlayback } from "../apps/api/src/playback.js";
import { generationTick, type GenerationConfig } from "../apps/api/src/generation.js";
import { eventInput } from "../packages/contracts/src/index.js";
import { computeAwards, releaseAwards } from "../apps/api/src/awards.js";
import {
  myContributions,
  createReceipt,
  publicReceipt,
  exportParticipant,
  eraseParticipant,
  setReminders,
  upcomingFromFollowed,
} from "../apps/api/src/fan-journeys.js";
import { releaseCredits } from "../apps/api/src/recognition.js";
import { createApp } from "../apps/api/src/app.js";

const ORIGIN = "http://fan.test";

async function participant(db: Database, name: string, anonymous = false) {
  const id = randomUUID();
  await db.query("INSERT INTO participants(id,name,avatar_seed,anonymous) VALUES($1,$2,$3,$4)", [id, name, "seed-" + name, anonymous]);
  return id;
}

/** One closed round with two authored waves, optionally published. */
async function closedRound(db: Database, artistId = "our-jam", publish = true) {
  const e = await createEvent(
    db,
    artistId,
    eventInput.parse({
      title: "Fan journey show",
      artistName: "Journey Artist",
      slug: "fan-" + randomUUID().slice(0, 8),
      minimumRoundSeconds: 0,
      voteMode: "single",
      sources: [{ title: "Opening song", corePrompt: "PRIVATE_CORE_SIGNATURE", durationSeconds: 60 }],
    }),
  );
  const lease = await claimPlayback(db, artistId, e.id);
  const opened = await advance(db, artistId, e.id, randomUUID(), 0, { ...lease, sequence: 1 });
  const alice = await participant(db, "Alice Named");
  const bob = await participant(db, "Bob Hidden", true);
  for (const p of [alice, bob])
    await db.query("INSERT INTO event_members(event_id,participant_id) VALUES($1,$2)", [e.id, p]);
  const a = await submitWave(db, { participantId: alice }, opened.roundId, { commandId: randomUUID(), expectedRevision: 0, text: "Warm horns" });
  await submitWave(db, { participantId: bob }, opened.roundId, { commandId: randomUUID(), expectedRevision: 0, text: "Glass bells" });
  void a;
  await advance(db, artistId, e.id, randomUUID(), 1, { ...lease, sequence: 2 });
  const job = (await db.query("SELECT id FROM generation_jobs WHERE event_id=$1", [e.id])).rows[0];
  const release = randomUUID();
  await db.query(
    "INSERT INTO releases(id,event_id,job_id,title,audio_url,download_url,duration_seconds,published_at,asset_sha256) VALUES($1,$2,$3,'Crowd take','x','x',60,$4,$5)",
    [release, e.id, job.id, publish ? new Date().toISOString() : null, "a".repeat(64)],
  );
  const waves = (await db.query("SELECT id,author_id FROM sound_waves WHERE round_id=$1", [opened.roundId])).rows;
  return { event: e, alice, bob, release, roundId: opened.roundId, aliceWave: waves.find((w) => w.author_id === alice)!.id, bobWave: waves.find((w) => w.author_id === bob)!.id };
}

test("awards replay deterministically from the stored snapshot and respect the minimum sample", () => {
  const opened = new Date("2026-11-01T20:00:00Z"), closed = new Date("2026-11-01T20:10:00Z");
  const at = (min: number) => new Date(opened.getTime() + min * 60000).toISOString();
  const selected = [
    { id: "w1", text: "Late hook", votes: 6, supporters: 6, authorId: "p1", createdAt: at(9) },
    { id: "w2", text: "First spark", votes: 4, supporters: 4, authorId: "p2", createdAt: at(1) },
    { id: "w3", text: "Middle", votes: 2, supporters: 2, authorId: "p3", createdAt: at(5) },
  ];
  const result = computeAwards({ waves: selected, selected }, opened, closed);
  assert.deepEqual(result.awards.map((a) => [a.kind, a.waveId]), [
    ["crowd_pick", "w1"],
    ["early_spark", "w2"],
    ["late_breakout", "w1"],
  ]);
  assert.deepEqual(computeAwards({ waves: selected, selected }, opened, closed), result);
  assert.equal(result.stats.averageVotesPerWave, 4);
  assert.equal(result.stats.medianVotesPerWave, 4);
  // A single supporter is below the minimum sample: only the crowd pick remains.
  const thin = [{ ...selected[1], supporters: 1, votes: 1 }];
  const sparse = computeAwards({ waves: thin, selected: thin }, opened, closed);
  assert.equal(sparse.stats.sampleSufficient, false);
  assert.deepEqual(sparse.awards.map((a) => a.kind), ["crowd_pick"]);
});

test("fans see their contributions and share revocable receipts without exposing private identity", async (t) => {
  const db = await testDatabase();
  t.after(() => db.close());
  const r = await closedRound(db);
  const mine = await myContributions(db, r.alice);
  assert.equal(mine.contributions.length, 1);
  assert.equal(mine.contributions[0].text, "Warm horns");
  assert.ok(["released", "not_selected"].includes(mine.contributions[0].status));
  assert.doesNotMatch(JSON.stringify(mine), /PRIVATE_CORE_SIGNATURE/);
  await assert.rejects(createReceipt(db, r.bob, r.aliceWave, true), { code: "not_found" });
  const unnamed = await createReceipt(db, r.alice, r.aliceWave, false);
  let shared = await publicReceipt(db, unnamed.id);
  assert.equal(shared.receipt.contributor, "A fan in the crowd");
  assert.equal(shared.receipt.event.title, "Fan journey show");
  assert.doesNotMatch(JSON.stringify(shared), new RegExp(r.alice));
  assert.doesNotMatch(JSON.stringify(shared), /waveId|PRIVATE_CORE/);
  const named = await createReceipt(db, r.alice, r.aliceWave, true);
  assert.notEqual(named.id, unnamed.id);
  await assert.rejects(publicReceipt(db, unnamed.id), { code: "not_found" });
  shared = await publicReceipt(db, named.id);
  assert.equal(shared.receipt.contributor, "Alice Named");
  // An anonymous profile never appears by name even when sharing is requested.
  const bobReceipt = await createReceipt(db, r.bob, r.bobWave, true);
  assert.equal((await publicReceipt(db, bobReceipt.id)).receipt.contributor, "A fan in the crowd");
  // Moderation hides the receipt.
  await db.query("UPDATE sound_waves SET moderated=true WHERE id=$1", [r.aliceWave]);
  await assert.rejects(publicReceipt(db, named.id), { code: "not_found" });
  const awards = await releaseAwards(db, r.release);
  assert.equal(awards.rules.version, "awards-v1");
  assert.ok(awards.awards.every((a) => !JSON.stringify(a).includes(r.bob)));
});

test("show reminders require a follow, record consent and surface only opted-in artists' shows", async (t) => {
  const db = await testDatabase();
  t.after(() => db.close());
  const r = await closedRound(db);
  await assert.rejects(setReminders(db, r.alice, "our-jam", true), { code: "follow_required" });
  await db.query("INSERT INTO artist_follows(participant_id,artist_id) VALUES($1,'our-jam')", [r.alice]);
  assert.equal((await upcomingFromFollowed(db, r.alice)).events.length, 0);
  const next = await createEvent(db, "our-jam", eventInput.parse({ title: "Next show", artistName: "Journey Artist", slug: "next-" + randomUUID().slice(0, 8), minimumRoundSeconds: 0, voteMode: "single", sources: [{ title: "N", corePrompt: "C", durationSeconds: 60 }] }));
  assert.equal((await upcomingFromFollowed(db, r.alice)).events.length, 0);
  await setReminders(db, r.alice, "our-jam", true);
  const consent = (await db.query("SELECT reminders_consent_at FROM artist_follows WHERE participant_id=$1", [r.alice])).rows[0];
  assert.ok(consent.reminders_consent_at);
  const upcoming = await upcomingFromFollowed(db, r.alice);
  assert.deepEqual(upcoming.events.map((e) => e.slug), [next.slug]);
  await setReminders(db, r.alice, "our-jam", false);
  assert.equal((await upcomingFromFollowed(db, r.alice)).events.length, 0);
});

test("personal data export is complete and erasure anonymizes credits while keeping released tracks consistent", async (t) => {
  const db = await testDatabase();
  t.after(() => db.close());
  const r = await closedRound(db);
  await db.query("INSERT INTO artist_follows(participant_id,artist_id,event_reminders) VALUES($1,'our-jam',true)", [r.alice]);
  await db.query("INSERT INTO sessions(token_hash,participant_id,kind,expires_at) VALUES($1,$2,'guest',now()+interval '1 day')", ["b".repeat(64), r.alice]);
  await db.query("INSERT INTO comments(id,release_id,participant_id,body) VALUES($1,$2,$3,'Loved the horns')", [randomUUID(), r.release, r.alice]);
  await createReceipt(db, r.alice, r.aliceWave, true);
  const data = await exportParticipant(db, r.alice);
  assert.equal((data.profile as any).name, "Alice Named");
  assert.equal(data.soundWaves.length, 1);
  assert.equal(data.comments.length, 1);
  assert.equal(data.follows.length, 1);
  assert.equal(data.receipts.length, 1);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_CORE_SIGNATURE|token_hash/);
  const totalsBefore = (await db.query("SELECT count(*)::integer n FROM allocations WHERE round_id=$1", [r.roundId])).rows[0].n;
  await eraseParticipant(db, r.alice);
  const after = (await db.query("SELECT name,anonymous,avatar_sha FROM participants WHERE id=$1", [r.alice])).rows[0];
  assert.deepEqual(after, { name: "Anonymous", anonymous: true, avatar_sha: null });
  for (const table of ["sessions", "artist_follows", "contribution_receipts", "participant_recovery"])
    assert.equal((await db.query(`SELECT count(*)::integer n FROM ${table} WHERE participant_id=$1`, [r.alice])).rows[0].n, 0, table);
  assert.equal((await db.query("SELECT body FROM comments WHERE participant_id=$1", [r.alice])).rows[0].body, "[removed by its author]");
  assert.equal((await db.query("SELECT count(*)::integer n FROM allocations WHERE round_id=$1", [r.roundId])).rows[0].n, totalsBefore);
  const credits = await releaseCredits(db, r.release);
  assert.ok(credits.credits.every((c: any) => c.name !== "Alice Named"));
  assert.equal((await db.query("SELECT count(*)::integer n FROM participant_erasures")).rows[0].n, 1);
});

test("HTTP: receipts, export and erasure require the guest's own session and same-origin writes", async (t) => {
  const db = await testDatabase();
  const app = await createApp(db, { origin: ORIGIN, secureCookies: false });
  t.after(async () => { await app.close(); await db.close(); });
  const join = await app.inject({ method: "POST", url: "/api/session", headers: { origin: ORIGIN }, payload: {} });
  assert.equal(join.statusCode, 200, join.body);
  const cookie = join.cookies.find((c) => c.name === "oj_guest")!;
  const headers = { origin: ORIGIN, cookie: "oj_guest=" + cookie.value };
  assert.equal((await app.inject({ method: "GET", url: "/api/me/contributions" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/contributions", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/receipts/not-a-receipt" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/receipts/AAAAAAAAAAAAAAAAAAAAAA" })).statusCode, 404);
  const exported = await app.inject({ method: "GET", url: "/api/account/export", headers });
  assert.equal(exported.statusCode, 200);
  assert.match(String(exported.headers["content-disposition"]), /attachment/);
  assert.equal((await app.inject({ method: "POST", url: "/api/account/erase", headers: { cookie: headers.cookie, origin: "https://evil.example" }, payload: { confirm: "ERASE MY PROFILE" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/account/erase", headers, payload: { confirm: "yes" } })).statusCode, 400);
  const erased = await app.inject({ method: "POST", url: "/api/account/erase", headers, payload: { confirm: "ERASE MY PROFILE" } });
  assert.equal(erased.statusCode, 200, erased.body);
  assert.equal((await app.inject({ method: "GET", url: "/api/me/contributions", headers })).statusCode, 401);
});

test("platform admin onboards isolated artists with quotas, usage statements, key rotation and suspension", async (t) => {
  const db = await testDatabase();
  const app = await createApp(db, { origin: ORIGIN, secureCookies: false, adminToken: "fixture-platform-admin-credential-long" });
  t.after(async () => { await app.close(); await db.close(); });
  const adminLogin = await app.inject({ method: "POST", url: "/api/admin/login", headers: { origin: ORIGIN }, payload: { token: "fixture-platform-admin-credential-long" } });
  const adminCookie = adminLogin.cookies.find((c) => c.name === "oj_platform_admin")!;
  const admin = { origin: ORIGIN, cookie: "oj_platform_admin=" + adminCookie.value };
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/artists", headers: { origin: ORIGIN }, payload: { name: "No admin" } })).statusCode, 401);
  const config = await app.inject({ method: "GET", url: "/api/admin/configuration", headers: admin });
  const media = config.json().features.find((f: any) => f.id === "media");
  assert.equal(media.enabled, false);
  assert.match(media.enable, /MEDIA_BUCKET/);
  const created = (await app.inject({ method: "POST", url: "/api/admin/artists", headers: admin, payload: { name: "Second Artist" } })).json();
  assert.match(created.token, /^[a-f0-9]{64}$/);
  const stored = (await db.query("SELECT token_hash FROM artist_access_keys WHERE artist_id=$1", [created.artistId])).rows[0];
  assert.notEqual(stored.token_hash, created.token);
  const signIn = async (token: string) => app.inject({ method: "POST", url: "/api/operator/login", headers: { origin: ORIGIN }, payload: { token } });
  const login = await signIn(created.token);
  assert.equal(login.statusCode, 200, login.body);
  const op = { origin: ORIGIN, cookie: "oj_operator=" + login.cookies.find((c) => c.name === "oj_operator")!.value };
  // The onboarded artist cannot see the original artist's events.
  const ownEvent = { title: "Second show", artistName: "Second Artist", minimumRoundSeconds: 0, voteMode: "single", sources: [{ title: "S", corePrompt: "SECOND_PRIVATE", durationSeconds: 60 }] };
  const listing = await app.inject({ method: "GET", url: "/api/admin/artists", headers: admin });
  const row = listing.json().artists.find((a: any) => a.id === created.artistId);
  assert.equal(row.quota.maxEvents, 50);
  assert.equal(row.quota.monthlyGenerationCents, 0);
  const tight = await app.inject({ method: "PUT", url: `/api/admin/artists/${created.artistId}/quota`, headers: admin, payload: { expectedRevision: 0, maxEvents: 1, maxLiveEvents: 1, monthlyGenerationCents: 0, suspended: false } });
  assert.equal(tight.statusCode, 200, tight.body);
  assert.equal((await app.inject({ method: "PUT", url: `/api/admin/artists/${created.artistId}/quota`, headers: admin, payload: { expectedRevision: 0, maxEvents: 9, maxLiveEvents: 1, monthlyGenerationCents: 0, suspended: false } })).statusCode, 409);
  const first = await app.inject({ method: "POST", url: "/api/operator/events", headers: op, payload: { ...ownEvent, slug: "second-a-" + randomUUID().slice(0, 6) } });
  assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({ method: "POST", url: "/api/operator/events", headers: op, payload: { ...ownEvent, slug: "second-b-" + randomUUID().slice(0, 6) } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "event_quota_reached");
  const usage = await app.inject({ method: "GET", url: `/api/admin/artists/${created.artistId}/usage`, headers: admin });
  assert.equal(usage.json().events_created, 1);
  const rotated = (await app.inject({ method: "POST", url: `/api/admin/artists/${created.artistId}/key`, headers: admin })).json();
  assert.equal((await app.inject({ method: "GET", url: "/api/operator/events", headers: op })).statusCode, 401);
  assert.equal((await signIn(created.token)).statusCode, 401);
  assert.equal((await signIn(rotated.token)).statusCode, 200);
  await app.inject({ method: "PUT", url: `/api/admin/artists/${created.artistId}/quota`, headers: admin, payload: { expectedRevision: 1, maxEvents: 1, maxLiveEvents: 1, monthlyGenerationCents: 0, suspended: true } });
  assert.equal((await signIn(rotated.token)).statusCode, 403);
  const audit = (await app.inject({ method: "GET", url: "/api/admin/audit", headers: admin })).json();
  assert.ok(audit.entries.some((e: any) => e.action === "artist.key_rotated"));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(rotated.token));
});

test("an onboarded artist's $0 monthly quota blocks generation without consuming another artist's budget", async (t) => {
  const db = await testDatabase();
  t.after(() => db.close());
  await db.query("INSERT INTO artists(id,name) VALUES('artist-quota','Quota Artist')");
  await db.query("INSERT INTO artist_quotas(artist_id,monthly_generation_cents) VALUES('artist-quota',0)");
  let calls = 0;
  const cfg: GenerationConfig = {
    maxJobCents: 20, eventBudgetCents: 20, totalBudgetCents: 100, durationSeconds: 60,
    provider: { name: "test", model: "test-only", generate: async () => { calls++; return { bytes: new Uint8Array([1]) }; } },
    store: { put: async () => {}, url: async () => "" },
    validate: async () => ({ durationSeconds: 60, meanDb: -12 }),
  };
  async function closed(artistId: string) {
    const e = await createEvent(db, artistId, eventInput.parse({ title: "Q", artistName: "Q", slug: "q-" + randomUUID().slice(0, 8), minimumRoundSeconds: 0, voteMode: "single", sources: [{ title: "T", corePrompt: "CORE", durationSeconds: 30 }] }));
    const lease = await claimPlayback(db, artistId, e.id);
    const opened = await advance(db, artistId, e.id, randomUUID(), 0, { ...lease, sequence: 1 }, true);
    const p = await participant(db, "Voter");
    await db.query("INSERT INTO event_members(event_id,participant_id) VALUES($1,$2)", [e.id, p]);
    await submitWave(db, { participantId: p }, opened.roundId, { commandId: randomUUID(), expectedRevision: 0, text: "Bright keys" });
    await advance(db, artistId, e.id, randomUUID(), 1, { ...lease, sequence: 2 }, true);
    return e;
  }
  const blocked = await closed("artist-quota");
  await generationTick(db, cfg);
  assert.equal(calls, 0);
  assert.equal((await db.query("SELECT reason FROM generation_jobs WHERE event_id=$1", [blocked.id])).rows[0].reason, "artist_quota_exhausted");
  const original = await closed("our-jam");
  await generationTick(db, cfg);
  assert.equal(calls, 1);
  assert.equal((await db.query("SELECT state FROM generation_jobs WHERE event_id=$1", [original.id])).rows[0].state, "published");
  void allocate;
});

test("event album export is sequenced, checksummed, credits fans and never leaks core prompts", async (t) => {
  const db = await testDatabase();
  const app = await createApp(db, { origin: ORIGIN, secureCookies: false, operatorToken: "fixture-operator-credential-long-enough-0001" });
  t.after(async () => { await app.close(); await db.close(); });
  const r = await closedRound(db);
  await db.query("UPDATE participants SET name='=HYPERLINK(\"x\")' WHERE id=$1", [r.alice]);
  const login = await app.inject({ method: "POST", url: "/api/operator/login", headers: { origin: ORIGIN }, payload: { token: "fixture-operator-credential-long-enough-0001" } });
  const op = { origin: ORIGIN, cookie: "oj_operator=" + login.cookies.find((c) => c.name === "oj_operator")!.value };
  assert.equal((await app.inject({ method: "GET", url: `/api/operator/events/${r.event.id}/export` })).statusCode, 401);
  const res = await app.inject({ method: "GET", url: `/api/operator/events/${r.event.id}/export`, headers: op });
  assert.equal(res.statusCode, 200, res.body);
  const pkg = res.json();
  assert.equal(pkg.format, "our-jam-event-album/v1");
  assert.equal(pkg.tracks.length, 1);
  assert.equal(pkg.tracks[0].position, 1);
  assert.equal(pkg.tracks[0].ai.generated, true);
  assert.equal(pkg.tracks[0].audio.available, false);
  assert.match(pkg.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(pkg.review.distributorDelivery, "manual");
  assert.doesNotMatch(res.body, /PRIVATE_CORE_SIGNATURE|Bob Hidden/);
  const csv = await app.inject({ method: "GET", url: `/api/operator/events/${r.event.id}/export?format=csv`, headers: op });
  assert.match(String(csv.headers["content-type"]), /text\/csv/);
  assert.match(csv.body, /"'=HYPERLINK/);
  // Another artist cannot export this event.
  await db.query("INSERT INTO artists(id,name) VALUES('artist-other','Other')");
  const raw = "c".repeat(64);
  const { digest } = await import("../packages/domain/src/index.js");
  await db.query("INSERT INTO sessions(token_hash,artist_id,kind,expires_at) VALUES($1,'artist-other','operator',now()+interval '1 hour')", [digest(raw)]);
  assert.equal((await app.inject({ method: "GET", url: `/api/operator/events/${r.event.id}/export`, headers: { origin: ORIGIN, cookie: "oj_operator=" + raw } })).statusCode, 404);
});
