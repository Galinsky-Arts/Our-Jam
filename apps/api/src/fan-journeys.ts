import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Database, Sql } from "./db.js";
import { requireThat } from "../../../packages/domain/src/index.js";
import { AWARD_LABELS, computeAwards, releaseAwards } from "./awards.js";

type SessionFn = (req: any, kind: "guest" | "operator", required?: boolean) => Promise<any>;
const uuid = z.uuid();
const receiptId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const ERASURE_POLICY_VERSION = "erasure-v1";

/** Every Sound Wave this participant wrote, with its outcome (OJ-031). */
export async function myContributions(db: Sql, participantId: string) {
  const rows = (
    await db.query(
      `SELECT w.id,w.text,w.created_at,w.moderated,w.round_id,r.state round_state,r.opened_at,
        COALESCE(r.closed_at,j.created_at) closed_at,e.slug,e.title event_title,e.artist_name,e.artist_id,
        j.snapshot,rel.id release_id,rel.title release_title,
        (rel.published_at IS NOT NULL AND NOT rel.hidden) release_public,
        cr.id receipt_id,cr.show_name receipt_named,
        (SELECT COALESCE(sum(points),0)::integer FROM allocations a WHERE a.wave_id=w.id AND a.round_id=w.round_id) votes,
        (SELECT count(*)::integer FROM allocations a WHERE a.wave_id=w.id AND a.round_id=w.round_id) supporters
       FROM sound_waves w JOIN rounds r ON r.id=w.round_id JOIN events e ON e.id=r.event_id
       LEFT JOIN generation_jobs j ON j.round_id=r.id
       LEFT JOIN releases rel ON rel.job_id=j.id
       LEFT JOIN contribution_receipts cr ON cr.wave_id=w.id AND cr.revoked_at IS NULL
       WHERE w.author_id=$1 ORDER BY w.created_at DESC LIMIT 200`,
      [participantId],
    )
  ).rows;
  return {
    contributions: rows.map((row) => describe(row, true)),
  };
}

function describe(row: any, owner: boolean) {
  const selected: any[] = row.snapshot?.selected ?? [];
  const index = selected.findIndex((w) => w.id === row.id);
  const awards =
    row.snapshot && row.opened_at
      ? computeAwards(row.snapshot, new Date(row.opened_at), new Date(row.closed_at ?? row.opened_at))
          .awards.filter((a) => a.waveId === row.id)
          .map((a) => ({ kind: a.kind, label: AWARD_LABELS[a.kind], evidence: a.evidence }))
      : [];
  const released = Boolean(row.release_id && row.release_public);
  return {
    ...(owner ? { waveId: row.id, receiptId: row.receipt_id ?? null, receiptNamed: Boolean(row.receipt_named) } : {}),
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
    hidden: Boolean(row.moderated),
    event: {
      slug: row.slug,
      title: row.event_title,
      artistName: row.artist_name,
      artistId: row.artist_id,
    },
    status:
      row.round_state === "open" || row.round_state === "paused"
        ? "voting"
        : index >= 0
          ? released
            ? "released"
            : "included"
          : "not_selected",
    rank: index >= 0 ? index + 1 : null,
    votes: row.votes,
    supporters: row.supporters,
    release: released ? { id: row.release_id, title: row.release_title } : null,
    awards: released ? awards : [],
  };
}

export async function createReceipt(db: Database, participantId: string, waveId: string, showName: boolean) {
  return db.transaction(async (tx) => {
    const wave = (
      await tx.query("SELECT id,moderated FROM sound_waves WHERE id=$1 AND author_id=$2", [waveId, participantId])
    ).rows[0];
    requireThat(wave, "not_found", "Only your own Sound Waves can have a receipt.", 404);
    requireThat(!wave.moderated, "wave_hidden", "A hidden Sound Wave cannot be shared.", 409);
    const existing = (
      await tx.query("SELECT id FROM contribution_receipts WHERE wave_id=$1 FOR UPDATE", [waveId])
    ).rows[0];
    const id = randomBytes(16).toString("base64url");
    if (existing)
      await tx.query(
        "UPDATE contribution_receipts SET id=$1,show_name=$2,revoked_at=NULL,created_at=now() WHERE wave_id=$3",
        [id, showName, waveId],
      );
    else
      await tx.query(
        "INSERT INTO contribution_receipts(id,wave_id,participant_id,show_name) VALUES($1,$2,$3,$4)",
        [id, waveId, participantId, showName],
      );
    return { id, path: "/receipt/" + id };
  });
}

export async function publicReceipt(db: Sql, id: string) {
  const row = (
    await db.query(
      `SELECT w.id,w.text,w.created_at,w.moderated,r.state round_state,r.opened_at,COALESCE(r.closed_at,j.created_at) closed_at,
        e.slug,e.title event_title,e.artist_name,e.artist_id,j.snapshot,rel.id release_id,rel.title release_title,
        (rel.published_at IS NOT NULL AND NOT rel.hidden) release_public,cr.show_name,p.name,p.anonymous,
        (SELECT COALESCE(sum(points),0)::integer FROM allocations a WHERE a.wave_id=w.id AND a.round_id=w.round_id) votes,
        (SELECT count(*)::integer FROM allocations a WHERE a.wave_id=w.id AND a.round_id=w.round_id) supporters
       FROM contribution_receipts cr JOIN sound_waves w ON w.id=cr.wave_id JOIN participants p ON p.id=w.author_id
       JOIN rounds r ON r.id=w.round_id JOIN events e ON e.id=r.event_id
       LEFT JOIN generation_jobs j ON j.round_id=r.id LEFT JOIN releases rel ON rel.job_id=j.id
       WHERE cr.id=$1 AND cr.revoked_at IS NULL`,
      [id],
    )
  ).rows[0];
  requireThat(row && !row.moderated, "not_found", "This receipt is no longer shared.", 404);
  return {
    receipt: {
      ...describe(row, false),
      contributor: row.show_name && !row.anonymous ? row.name : "A fan in the crowd",
    },
  };
}

/** Events this participant joined, with what came out of them (event collections). */
export async function myEvents(db: Sql, participantId: string) {
  const rows = (
    await db.query(
      `SELECT e.slug,e.title,e.artist_name,e.artist_id,e.state,m.joined_at,
        (SELECT count(*)::integer FROM releases rel WHERE rel.event_id=e.id AND rel.published_at IS NOT NULL AND NOT rel.hidden) releases,
        (SELECT count(*)::integer FROM sound_waves w JOIN rounds r ON r.id=w.round_id WHERE r.event_id=e.id AND w.author_id=$1) my_waves
       FROM event_members m JOIN events e ON e.id=m.event_id WHERE m.participant_id=$1
       ORDER BY m.joined_at DESC LIMIT 100`,
      [participantId],
    )
  ).rows;
  return {
    events: rows.map((e) => ({
      slug: e.slug,
      title: e.title,
      artistName: e.artist_name,
      artistId: e.artist_id,
      state: e.state,
      joinedAt: new Date(e.joined_at).toISOString(),
      releases: e.releases,
      myWaves: e.my_waves,
    })),
  };
}

/** Upcoming/live shows from followed artists whose reminders the fan opted into. */
export async function upcomingFromFollowed(db: Sql, participantId: string) {
  const rows = (
    await db.query(
      `SELECT e.slug,e.title,e.artist_name,e.artist_id,e.state,e.created_at
       FROM artist_follows f JOIN events e ON e.artist_id=f.artist_id
       WHERE f.participant_id=$1 AND f.event_reminders AND e.state IN ('waiting','live')
       ORDER BY (e.state='live') DESC,e.created_at DESC LIMIT 20`,
      [participantId],
    )
  ).rows;
  return {
    events: rows.map((e) => ({
      slug: e.slug,
      title: e.title,
      artistName: e.artist_name,
      artistId: e.artist_id,
      live: e.state === "live",
    })),
  };
}

export async function setReminders(db: Sql, participantId: string, artistId: string, enabled: boolean) {
  const updated = (
    await db.query(
      `UPDATE artist_follows SET event_reminders=$3,reminders_consent_at=CASE WHEN $3 THEN now() ELSE NULL END
       WHERE participant_id=$1 AND artist_id=$2 RETURNING event_reminders`,
      [participantId, artistId, enabled],
    )
  ).rows[0];
  requireThat(updated, "follow_required", "Follow this artist before turning on show reminders.", 409);
  return { reminders: updated.event_reminders as boolean };
}

/** OJ-025 subject-access export: everything stored about this participant. */
export async function exportParticipant(db: Sql, participantId: string) {
  const one = async (sql: string) => (await db.query(sql, [participantId])).rows;
  const profile = (
    await db.query(
      "SELECT id,name,anonymous,avatar_seed,avatar_sha,created_at FROM participants WHERE id=$1",
      [participantId],
    )
  ).rows[0];
  requireThat(profile, "not_found", "Profile not found.", 404);
  return {
    format: "our-jam-personal-data/v1",
    exportedAt: new Date().toISOString(),
    profile: { ...profile, hasProfilePicture: Boolean(profile.avatar_sha), avatar_sha: undefined },
    events: await one(
      "SELECT e.slug,e.title,e.artist_name,m.joined_at,m.venue_admitted FROM event_members m JOIN events e ON e.id=m.event_id WHERE m.participant_id=$1 ORDER BY m.joined_at",
    ),
    soundWaves: await one(
      "SELECT w.id,w.text,w.created_at,w.moderated hidden_by_moderation,e.slug event FROM sound_waves w JOIN rounds r ON r.id=w.round_id JOIN events e ON e.id=r.event_id WHERE w.author_id=$1 ORDER BY w.created_at",
    ),
    votes: await one(
      "SELECT a.round_id,a.wave_id,a.points FROM allocations a WHERE a.participant_id=$1",
    ),
    reactions: await one("SELECT release_id,value,updated_at FROM reactions WHERE participant_id=$1"),
    comments: await one("SELECT id,release_id,body,hidden,created_at FROM comments WHERE participant_id=$1"),
    reports: await one("SELECT comment_id,reason,created_at FROM reports WHERE participant_id=$1"),
    listening: await one(
      "SELECT release_id,seconds,qualified,completed,updated_at FROM listening WHERE participant_id=$1",
    ),
    follows: await one(
      "SELECT artist_id,created_at,event_reminders,reminders_consent_at FROM artist_follows WHERE participant_id=$1",
    ),
    emailSubscriptions: await one(
      "SELECT e.slug event,s.state,s.consent_at,s.consent_version,s.verified_at FROM email_subscriptions s JOIN events e ON e.id=s.event_id WHERE s.participant_id=$1",
    ),
    pushNotifications: await one(
      "SELECT e.slug event,s.created_at,s.disabled_at FROM push_subscriptions s JOIN events e ON e.id=s.event_id WHERE s.participant_id=$1",
    ),
    receipts: await one(
      "SELECT id,wave_id,show_name,created_at,revoked_at FROM contribution_receipts WHERE participant_id=$1",
    ),
    recoveryKey: (await one("SELECT created_at,last_used_at FROM participant_recovery WHERE participant_id=$1"))[0] ?? null,
    signIn: (await one("SELECT issuer,created_at FROM app_identities WHERE participant_id=$1"))[0] ?? null,
    notes: [
      "Email addresses are stored only as a keyed hash plus encrypted contact data and are not included in plain text.",
      "Released tracks keep the Sound Wave text that shaped them; erasing your profile anonymizes your credit.",
    ],
  };
}

/**
 * OJ-025 erasure. Contact data, sessions, follows, receipts, recovery and
 * sign-in links are deleted; comments are removed; the profile becomes an
 * anonymous placeholder so published tracks and vote totals stay consistent.
 */
export async function eraseParticipant(db: Database, participantId: string) {
  return db.transaction(async (tx) => {
    const found = (
      await tx.query("SELECT id FROM participants WHERE id=$1 FOR UPDATE", [participantId])
    ).rows[0];
    requireThat(found, "not_found", "Profile not found.", 404);
    const identities = (
      await tx.query("SELECT id FROM app_identities WHERE participant_id=$1", [participantId])
    ).rows.map((r) => r.id);
    await tx.query("DELETE FROM sessions WHERE participant_id=$1 OR identity_id=ANY($2::uuid[])", [
      participantId,
      identities,
    ]);
    await tx.query(
      "DELETE FROM native_identity_handoffs WHERE participant_id=$1 OR identity_id=ANY($2::uuid[])",
      [participantId, identities],
    );
    await tx.query("DELETE FROM app_identities WHERE participant_id=$1", [participantId]);
    await tx.query("DELETE FROM participant_recovery WHERE participant_id=$1", [participantId]);
    await tx.query("DELETE FROM artist_follows WHERE participant_id=$1", [participantId]);
    await tx.query("DELETE FROM contribution_receipts WHERE participant_id=$1", [participantId]);
    await tx.query("DELETE FROM push_subscriptions WHERE participant_id=$1", [participantId]);
    await tx.query(
      "UPDATE email_subscriptions SET state='unsubscribed',contact_ciphertext=NULL,verify_hash=NULL WHERE participant_id=$1",
      [participantId],
    );
    await tx.query(
      "UPDATE comments SET body='[removed by its author]',hidden=true WHERE participant_id=$1",
      [participantId],
    );
    await tx.query(
      "UPDATE participants SET name='Anonymous',anonymous=true,avatar_png=NULL,avatar_sha=NULL,avatar_seed=$2 WHERE id=$1",
      [participantId, "erased-" + randomUUID()],
    );
    await tx.query("INSERT INTO participant_erasures(id,policy_version) VALUES($1,$2)", [
      randomUUID(),
      ERASURE_POLICY_VERSION,
    ]);
    return { erased: true, policy: ERASURE_POLICY_VERSION };
  });
}

export function registerFanJourneys(app: FastifyInstance, db: Database) {
  const session = (app as any).ojSession as SessionFn;
  app.get("/api/me/contributions", async (req) => {
    const s = await session(req, "guest");
    return myContributions(db, s.participant_id);
  });
  app.get("/api/me/events", async (req) => {
    const s = await session(req, "guest");
    return myEvents(db, s.participant_id);
  });
  app.post("/api/me/receipts", async (req) => {
    const s = await session(req, "guest");
    const v = z.object({ waveId: uuid, showName: z.boolean().default(false) }).parse(req.body);
    return createReceipt(db, s.participant_id, v.waveId, v.showName);
  });
  app.delete("/api/me/receipts/:id", async (req) => {
    const s = await session(req, "guest");
    const rid = receiptId.parse((req.params as any).id);
    const row = (
      await db.query(
        "UPDATE contribution_receipts SET revoked_at=now() WHERE id=$1 AND participant_id=$2 AND revoked_at IS NULL RETURNING id",
        [rid, s.participant_id],
      )
    ).rows[0];
    requireThat(row, "not_found", "Receipt not found.", 404);
    return { revoked: true };
  });
  app.get("/api/receipts/:id", async (req) => publicReceipt(db, receiptId.parse((req.params as any).id)));
  app.get("/api/releases/:id/awards", async (req) => releaseAwards(db, uuid.parse((req.params as any).id)));
  app.put("/api/artists/:id/reminders", async (req) => {
    const s = await session(req, "guest");
    const artistId = z.string().min(1).max(100).parse((req.params as any).id);
    const v = z.object({ enabled: z.boolean() }).parse(req.body);
    return setReminders(db, s.participant_id, artistId, v.enabled);
  });
  app.get("/api/following/upcoming", async (req) => {
    const s = await session(req, "guest");
    return upcomingFromFollowed(db, s.participant_id);
  });
  app.get("/api/account/export", async (req, reply) => {
    const s = await session(req, "guest");
    const data = await exportParticipant(db, s.participant_id);
    return reply
      .header("Content-Disposition", 'attachment; filename="our-jam-personal-data.json"')
      .send(data);
  });
  app.post("/api/account/erase", async (req, reply) => {
    const s = await session(req, "guest");
    z.object({ confirm: z.literal("ERASE MY PROFILE") }).parse(req.body);
    const result = await eraseParticipant(db, s.participant_id);
    reply.clearCookie("oj_guest", { path: "/" });
    return result;
  });
}
