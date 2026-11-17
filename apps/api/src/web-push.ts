import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
  type ECDH,
} from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import { requireThat } from "../../../packages/domain/src/index.js";

// OJ-019 browser push for releases. Payloads are encrypted per RFC 8291
// (aes128gcm) and authenticated with VAPID (RFC 8292) using only node:crypto.
// Off unless a VAPID key pair is configured; the fanout gives each opted-in
// subscription at most one notification per release.
export type WebPushConfig = {
  publicKey: string; // base64url uncompressed P-256 point (65 bytes)
  privateKey: string; // base64url 32-byte scalar
  subject: string; // mailto: or https: contact
  send?: (endpoint: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;
};

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s.replace(/=+$/, ""), "base64url");

export function configuredWebPush(env: NodeJS.ProcessEnv = process.env): WebPushConfig | undefined {
  if (!env.WEB_PUSH_PUBLIC_KEY && !env.WEB_PUSH_PRIVATE_KEY) return undefined;
  const publicKey = z.string().regex(/^[A-Za-z0-9_-]{86,88}$/).parse(env.WEB_PUSH_PUBLIC_KEY);
  const privateKey = z.string().regex(/^[A-Za-z0-9_-]{42,44}$/).parse(env.WEB_PUSH_PRIVATE_KEY);
  const subject = z.string().regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/).parse(env.WEB_PUSH_SUBJECT);
  requireThat(unb64u(publicKey).length === 65 && unb64u(privateKey).length === 32,
    "invalid_vapid_keys", "WEB_PUSH keys must be a P-256 VAPID key pair.");
  return { publicKey, privateKey, subject };
}

/** Generates a VAPID key pair (used by scripts/generate-vapid-keys.mjs and tests). */
export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const d = ecdh.getPrivateKey();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(Buffer.concat([Buffer.alloc(32 - d.length), d])) };
}

function vapidKeyObject(config: WebPushConfig) {
  const pub = unb64u(config.publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(unb64u(config.privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

export function vapidAuthorization(config: WebPushConfig, endpoint: string, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: config.subject })));
  const signature = sign("sha256", Buffer.from(header + "." + claims), { key: vapidKeyObject(config), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${config.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** RFC 8291 message encryption with a single aes128gcm record. */
export function encryptPayload(payload: Buffer, uaPublicB64: string, authB64: string, salt = randomBytes(16), ephemeral?: ECDH) {
  const uaPublic = unb64u(uaPublicB64), auth = unb64u(authB64);
  requireThat(uaPublic.length === 65 && uaPublic[0] === 4 && auth.length === 16, "invalid_push_keys", "Invalid push subscription keys.");
  if (!ephemeral) {
    ephemeral = createECDH("prime256v1");
    ephemeral.generateKeys();
  }
  const asPublic = ephemeral.getPublicKey();
  const secret = ephemeral.computeSecret(uaPublic);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Only well-known browser push services may receive server requests (SSRF guard).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];
export function allowedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && !url.username && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

const subscriptionInput = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({
    p256dh: z.string().transform((s) => s.replace(/=+$/, "")).pipe(z.string().regex(/^[A-Za-z0-9_-]{86,87}$/)),
    auth: z.string().transform((s) => s.replace(/=+$/, "")).pipe(z.string().regex(/^[A-Za-z0-9_-]{22}$/)),
  }),
});

async function defaultSend(endpoint: string, init: { method: string; headers: Record<string, string>; body: Buffer }) {
  const response = await fetch(endpoint, { ...init, body: new Uint8Array(init.body), redirect: "error", signal: AbortSignal.timeout(10000) });
  await response.body?.cancel();
  return { status: response.status };
}

/** One fanout + up to 50 deliveries per tick. Safe to run on several instances. */
export async function pushTick(db: Database, config: WebPushConfig) {
  await db.transaction(async (tx) => {
    const release = (
      await tx.query(
        `SELECT r.id,r.event_id FROM releases r LEFT JOIN push_release_fanout f ON f.release_id=r.id
         WHERE r.published_at IS NOT NULL AND NOT r.hidden AND f.release_id IS NULL
         ORDER BY r.published_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
      )
    ).rows[0];
    if (!release) return;
    await tx.query(
      `INSERT INTO push_deliveries(release_id,subscription_id)
       SELECT $1,id FROM push_subscriptions WHERE event_id=$2 AND disabled_at IS NULL ON CONFLICT DO NOTHING`,
      [release.id, release.event_id],
    );
    await tx.query("INSERT INTO push_release_fanout(release_id) VALUES($1) ON CONFLICT DO NOTHING", [release.id]);
  });
  const due = await db.transaction(async (tx) => {
    const rows = (
      await tx.query(
        `SELECT d.release_id,d.subscription_id,d.attempts,s.endpoint,s.p256dh,s.auth,r.title,e.slug,e.title event_title
         FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
         JOIN releases r ON r.id=d.release_id JOIN events e ON e.id=r.event_id
         WHERE d.state='pending' AND d.next_attempt_at<=now() AND s.disabled_at IS NULL
         ORDER BY d.next_attempt_at LIMIT 50 FOR UPDATE OF d SKIP LOCKED`,
      )
    ).rows;
    for (const r of rows)
      await tx.query(
        "UPDATE push_deliveries SET attempts=attempts+1,next_attempt_at=now()+interval '2 minutes',updated_at=now() WHERE release_id=$1 AND subscription_id=$2",
        [r.release_id, r.subscription_id],
      );
    return rows;
  });
  const send = config.send ?? defaultSend;
  let sent = 0;
  for (const d of due) {
    let state: "sent" | "failed" | "gone" | "pending" = "pending";
    if (!allowedPushEndpoint(d.endpoint)) state = "gone";
    else
      try {
        const payload = Buffer.from(JSON.stringify({
          title: "New from " + d.event_title,
          body: d.title + " is ready to play and download.",
          url: "/event/" + encodeURIComponent(d.slug) + "?track=" + d.release_id,
          tag: "release-" + d.release_id,
        }));
        const response = await send(d.endpoint, {
          method: "POST",
          headers: {
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "86400",
            Urgency: "normal",
            Topic: "release" + String(d.release_id).replaceAll("-", "").slice(0, 24),
            Authorization: vapidAuthorization(config, d.endpoint),
          },
          body: encryptPayload(payload, d.p256dh, d.auth),
        });
        if (response.status >= 200 && response.status < 300) state = "sent";
        else if (response.status === 404 || response.status === 410) state = "gone";
        else if (response.status === 413 || response.status === 400 || response.status === 403) state = "failed";
        else state = d.attempts + 1 >= 5 ? "failed" : "pending";
      } catch {
        state = d.attempts + 1 >= 5 ? "failed" : "pending";
      }
    if (state === "pending") continue;
    if (state === "sent") sent++;
    await db.query("UPDATE push_deliveries SET state=$1,updated_at=now() WHERE release_id=$2 AND subscription_id=$3", [state, d.release_id, d.subscription_id]);
    if (state === "gone") await db.query("UPDATE push_subscriptions SET disabled_at=now() WHERE id=$1", [d.subscription_id]);
  }
  return { attempted: due.length, sent };
}

export function registerWebPush(app: FastifyInstance, db: Database, config: WebPushConfig | undefined) {
  const session = (app as any).ojSession as (req: any, kind: "guest", required?: boolean) => Promise<any>;
  app.get("/api/push/config", async () => ({ enabled: Boolean(config), publicKey: config?.publicKey ?? null }));
  app.get("/api/events/:id/push", async (req) => {
    const s = await session(req, "guest", false);
    const eventId = z.uuid().parse((req.params as any).id);
    if (!s) return { enabled: Boolean(config), subscribed: false };
    const n = (await db.query("SELECT count(*)::integer n FROM push_subscriptions WHERE event_id=$1 AND participant_id=$2 AND disabled_at IS NULL", [eventId, s.participant_id])).rows[0].n;
    return { enabled: Boolean(config), subscribed: n > 0 };
  });
  app.put("/api/events/:id/push", async (req) => {
    requireThat(config, "push_unconfigured", "Browser notifications are not configured on this server.", 503);
    const s = await session(req, "guest");
    const eventId = z.uuid().parse((req.params as any).id);
    const sub = subscriptionInput.parse(req.body);
    requireThat(allowedPushEndpoint(sub.endpoint), "push_endpoint_rejected", "This browser's push service is not supported.", 400);
    const member = (await db.query("SELECT 1 FROM event_members WHERE event_id=$1 AND participant_id=$2", [eventId, s.participant_id])).rows[0];
    requireThat(member, "join_required", "Join this show before turning on notifications.", 409);
    await db.query(
      `INSERT INTO push_subscriptions(id,participant_id,event_id,endpoint,p256dh,auth) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(event_id,endpoint) DO UPDATE SET participant_id=$2,p256dh=$5,auth=$6,disabled_at=NULL,failures=0`,
      [randomUUID(), s.participant_id, eventId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
    );
    return { subscribed: true };
  });
  app.delete("/api/events/:id/push", async (req) => {
    const s = await session(req, "guest");
    const eventId = z.uuid().parse((req.params as any).id);
    await db.query("UPDATE push_subscriptions SET disabled_at=now() WHERE event_id=$1 AND participant_id=$2", [eventId, s.participant_id]);
    return { subscribed: false };
  });
}
