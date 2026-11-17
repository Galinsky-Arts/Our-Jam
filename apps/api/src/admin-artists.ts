import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Database, Sql } from "./db.js";
import { digest, requireThat } from "../../../packages/domain/src/index.js";
import { requirePlatformAdmin } from "./platform-admin.js";

// OJ-038 artist onboarding, quotas, usage statements and the platform
// configuration overview. Onboarding issues a one-time performer key; only its
// hash is stored. Quotas are enforced at event creation, go-live and generation.
const DEFAULT_QUOTA = { maxEvents: 50, maxLiveEvents: 1, monthlyGenerationCents: 0, suspended: false };
const artistIdInput = z.string().min(1).max(100);
export const quotaInput = z.object({
  expectedRevision: z.number().int().nonnegative(),
  maxEvents: z.number().int().min(0).max(100000),
  maxLiveEvents: z.number().int().min(0).max(100),
  monthlyGenerationCents: z.number().int().min(0).max(100000000),
  suspended: z.boolean(),
});

export async function artistQuota(db: Sql, artistId: string) {
  const row = (await db.query("SELECT * FROM artist_quotas WHERE artist_id=$1", [artistId])).rows[0];
  return row
    ? {
        maxEvents: row.max_events as number,
        maxLiveEvents: row.max_live_events as number,
        monthlyGenerationCents: row.monthly_generation_cents as number,
        suspended: row.suspended as boolean,
        revision: row.revision as number,
        configured: true,
      }
    : { ...DEFAULT_QUOTA, revision: 0, configured: false };
}

/** Called inside event creation; rejects once an artist's quota is used. */
export async function assertEventQuota(db: Sql, artistId: string) {
  const q = await artistQuota(db, artistId);
  if (!q.configured) return;
  requireThat(!q.suspended, "artist_suspended", "This artist account is paused by the platform administrator.", 403);
  const used = (await db.query("SELECT count(*)::integer n FROM events WHERE artist_id=$1", [artistId])).rows[0].n;
  requireThat(used < q.maxEvents, "event_quota_reached",
    `This account may create ${q.maxEvents} events. Ask the platform administrator to raise the limit.`, 409);
}

/** Called before an event goes live; caps simultaneous live shows per artist. */
export async function assertLiveQuota(db: Sql, artistId: string, eventId: string) {
  const q = await artistQuota(db, artistId);
  if (!q.configured) return;
  requireThat(!q.suspended, "artist_suspended", "This artist account is paused by the platform administrator.", 403);
  const live = (
    await db.query("SELECT count(*)::integer n FROM events WHERE artist_id=$1 AND state='live' AND id<>$2", [artistId, eventId])
  ).rows[0].n;
  requireThat(live < q.maxLiveEvents, "live_quota_reached",
    `This account may run ${q.maxLiveEvents} live show(s) at once. End the other show first.`, 409);
}

export async function usageStatement(db: Sql, artistId: string, month: string) {
  const start = new Date(month + "-01T00:00:00Z");
  requireThat(Number.isFinite(start.getTime()), "invalid_month", "Use a YYYY-MM month.");
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const row = (
    await db.query(
      `SELECT
        (SELECT count(*)::integer FROM events WHERE artist_id=$1 AND created_at>=$2 AND created_at<$3) events_created,
        (SELECT count(*)::integer FROM rounds r JOIN events e ON e.id=r.event_id WHERE e.artist_id=$1 AND r.opened_at>=$2 AND r.opened_at<$3) rounds,
        (SELECT count(*)::integer FROM sound_waves w JOIN rounds r ON r.id=w.round_id JOIN events e ON e.id=r.event_id WHERE e.artist_id=$1 AND w.created_at>=$2 AND w.created_at<$3) sound_waves,
        (SELECT count(DISTINCT m.participant_id)::integer FROM event_members m JOIN events e ON e.id=m.event_id WHERE e.artist_id=$1 AND m.joined_at>=$2 AND m.joined_at<$3) participants,
        (SELECT count(*)::integer FROM generation_jobs j JOIN events e ON e.id=j.event_id WHERE e.artist_id=$1 AND j.created_at>=$2 AND j.created_at<$3) generation_jobs,
        (SELECT COALESCE(sum(j.reserved_cents),0)::integer FROM generation_jobs j JOIN events e ON e.id=j.event_id WHERE e.artist_id=$1 AND j.created_at>=$2 AND j.created_at<$3) generation_reserved_cents,
        (SELECT count(*)::integer FROM releases rel JOIN events e ON e.id=rel.event_id WHERE e.artist_id=$1 AND rel.published_at>=$2 AND rel.published_at<$3) releases_published,
        (SELECT COALESCE(sum(p.amount_cents),0)::integer FROM event_purchases p WHERE p.artist_id=$1 AND p.state='paid' AND p.paid_at>=$2 AND p.paid_at<$3) event_payments_cents`,
      [artistId, start.toISOString(), end.toISOString()],
    )
  ).rows[0];
  return { artistId, month, from: start.toISOString(), to: end.toISOString(), ...row };
}

export type ConfigurationFlags = {
  operatorToken: boolean;
  adminToken: boolean;
  media: "verified" | "configured" | "not_configured";
  generation: boolean;
  email: boolean;
  commerce: boolean;
  identity: boolean;
  webPush: boolean;
};

/** What is switched on, and exactly which settings turn the rest on. */
export function configurationStatus(flags: ConfigurationFlags) {
  return {
    features: [
      { id: "performer", label: "Performer console sign-in", enabled: flags.operatorToken,
        enable: "Set OPERATOR_TOKEN (32+ random characters), or onboard artists below." },
      { id: "admin", label: "Platform administration", enabled: flags.adminToken,
        enable: "Set ADMIN_TOKEN or PLATFORM_ADMIN_TOKEN (32+ random characters)." },
      { id: "media", label: "Album upload, playback and release downloads", enabled: flags.media !== "not_configured",
        status: flags.media,
        enable: "Set MEDIA_BUCKET, MEDIA_REGION, MEDIA_ACCESS_KEY_ID, MEDIA_SECRET_ACCESS_KEY (and MEDIA_ENDPOINT for non-AWS S3) on the server, then MEDIA_PROBE_ON_START=1 to verify." },
      { id: "generation", label: "AI generation (paid providers)", enabled: flags.generation,
        enable: "Kept OFF: approved budget is $0. Needs GENERATION_ENABLED=1, provider keys (MUREKA_API_KEY / STABLE_AUDIO_KEY), GENERATION_RIGHTS_ACK, verified prices and a non-zero budget approved by the owner." },
      { id: "email", label: "Release email", enabled: flags.email,
        enable: "Set EMAIL_ENABLED=1, EMAIL_DELIVERY_ACK=approved-event-email, EMAIL_FROM, RESEND_API_KEY, RESEND_WEBHOOK_SECRET and EMAIL_DATA_KEY (64 hex characters)." },
      { id: "webpush", label: "Browser push notifications for releases", enabled: flags.webPush,
        enable: "Set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY (a VAPID key pair) and WEB_PUSH_SUBJECT (mailto: or https: contact)." },
      { id: "commerce", label: "Event payments (Stripe) and sponsor videos", enabled: flags.commerce,
        enable: "Set COMMERCE_ENABLED=1, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and PLATFORM_ADMIN_TOKEN. Live charges also need COMMERCE_LIVE_PAYMENTS_ACK." },
      { id: "identity", label: "Google and email sign-in", enabled: flags.identity,
        enable: "Enable Neon Auth with the Google provider for this project, then set IDENTITY_ENABLED=1 and NEON_AUTH_BASE_URL (optionally AUTH_SOCIAL_PROVIDERS)." },
    ],
  };
}

async function audit(db: Sql, action: string, subject: string | null, detail: Record<string, unknown> = {}) {
  await db.query("INSERT INTO platform_admin_audit(action,subject,detail) VALUES($1,$2,$3)", [action, subject, JSON.stringify(detail)]);
}

export function registerArtistAdministration(app: FastifyInstance, db: Database, flags: () => ConfigurationFlags) {
  const admin = (req: any) => requirePlatformAdmin(db, req);
  app.get("/api/admin/configuration", async (req) => {
    await admin(req);
    return configurationStatus(flags());
  });
  app.get("/api/admin/artists", async (req) => {
    await admin(req);
    const rows = (
      await db.query(
        `SELECT a.id,a.name,a.created_at,
          (SELECT count(*)::integer FROM events e WHERE e.artist_id=a.id) events,
          (SELECT count(*)::integer FROM events e WHERE e.artist_id=a.id AND e.state='live') live_events,
          (SELECT count(*)::integer FROM artist_access_keys k WHERE k.artist_id=a.id AND NOT k.revoked) active_keys
         FROM artists a ORDER BY a.created_at,a.id LIMIT 500`,
      )
    ).rows;
    return {
      artists: await Promise.all(
        rows.map(async (a) => ({
          id: a.id,
          name: a.name,
          createdAt: new Date(a.created_at).toISOString(),
          events: a.events,
          liveEvents: a.live_events,
          activeKeys: a.active_keys,
          quota: await artistQuota(db, a.id),
        })),
      ),
    };
  });
  app.post("/api/admin/artists", async (req) => {
    await admin(req);
    const v = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    requireThat(!/[<>\p{C}]/u.test(v.name), "invalid_name", "Use a plain artist name.");
    const artistId = "artist-" + randomUUID(),
      token = randomBytes(32).toString("hex");
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO artists(id,name,bio) VALUES($1,$2,'')", [artistId, v.name]);
      await tx.query("INSERT INTO artist_access_keys(token_hash,artist_id) VALUES($1,$2)", [digest(token), artistId]);
      await tx.query(
        "INSERT INTO artist_quotas(artist_id,max_events,max_live_events,monthly_generation_cents) VALUES($1,$2,$3,$4)",
        [artistId, DEFAULT_QUOTA.maxEvents, DEFAULT_QUOTA.maxLiveEvents, DEFAULT_QUOTA.monthlyGenerationCents],
      );
      await audit(tx, "artist.onboarded", artistId);
    });
    // Shown once; only the hash is stored.
    return { artistId, token };
  });
  app.post("/api/admin/artists/:id/key", async (req) => {
    await admin(req);
    const artistId = artistIdInput.parse((req.params as any).id);
    const token = randomBytes(32).toString("hex");
    await db.transaction(async (tx) => {
      const found = (await tx.query("SELECT id FROM artists WHERE id=$1 FOR UPDATE", [artistId])).rows[0];
      requireThat(found, "not_found", "Artist not found.", 404);
      requireThat(artistId !== "our-jam", "env_managed_key",
        "The original performer key is OPERATOR_TOKEN in the server environment.", 409);
      await tx.query("UPDATE artist_access_keys SET revoked=true WHERE artist_id=$1", [artistId]);
      await tx.query("INSERT INTO artist_access_keys(token_hash,artist_id) VALUES($1,$2)", [digest(token), artistId]);
      // Rotating a key also ends that artist's existing console sessions.
      await tx.query("DELETE FROM sessions WHERE kind='operator' AND artist_id=$1", [artistId]);
      await audit(tx, "artist.key_rotated", artistId);
    });
    return { artistId, token };
  });
  app.put("/api/admin/artists/:id/quota", async (req) => {
    await admin(req);
    const artistId = artistIdInput.parse((req.params as any).id);
    const v = quotaInput.parse(req.body);
    return db.transaction(async (tx) => {
      const found = (await tx.query("SELECT id FROM artists WHERE id=$1", [artistId])).rows[0];
      requireThat(found, "not_found", "Artist not found.", 404);
      const current = (await tx.query("SELECT revision FROM artist_quotas WHERE artist_id=$1 FOR UPDATE", [artistId])).rows[0];
      requireThat((current?.revision ?? 0) === v.expectedRevision, "revision_conflict", "Reload before saving.", 409);
      await tx.query(
        `INSERT INTO artist_quotas(artist_id,max_events,max_live_events,monthly_generation_cents,suspended,revision,updated_at)
         VALUES($1,$2,$3,$4,$5,1,now())
         ON CONFLICT(artist_id) DO UPDATE SET max_events=$2,max_live_events=$3,monthly_generation_cents=$4,suspended=$5,
           revision=artist_quotas.revision+1,updated_at=now()`,
        [artistId, v.maxEvents, v.maxLiveEvents, v.monthlyGenerationCents, v.suspended],
      );
      if (v.suspended) await tx.query("DELETE FROM sessions WHERE kind='operator' AND artist_id=$1", [artistId]);
      await audit(tx, "artist.quota_changed", artistId, { ...v, expectedRevision: undefined });
      return artistQuota(tx, artistId);
    });
  });
  app.get("/api/admin/artists/:id/usage", async (req) => {
    await admin(req);
    const artistId = artistIdInput.parse((req.params as any).id);
    const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .default(new Date().toISOString().slice(0, 7)).parse((req.query as any).month);
    return usageStatement(db, artistId, month);
  });
  app.get("/api/admin/audit", async (req) => {
    await admin(req);
    return {
      entries: (await db.query("SELECT action,subject,detail,created_at FROM platform_admin_audit ORDER BY id DESC LIMIT 100")).rows,
    };
  });
}
