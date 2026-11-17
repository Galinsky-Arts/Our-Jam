import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createRequire } from "node:module";
const ece = createRequire(import.meta.url)("http_ece");
import { testDatabase } from "./database.js";
import {
  allowedPushEndpoint,
  configuredWebPush,
  generateVapidKeys,
  pushRequest,
  pushTick,
  type WebPushConfig,
} from "../apps/api/src/web-push.js";
import { createApp } from "../apps/api/src/app.js";

const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();

/** Independent RFC 8291 decryption acting as the browser (user agent). */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1);
}

function browser() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

// RFC 8291 Appendix A test vector.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  sharedSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const b64 = (s: string) => Buffer.from(s, "base64url");

test("RFC 8291 Appendix A vector: the web-push encryption stack reproduces the exact message and it decrypts", () => {
  const as = createECDH("prime256v1");
  as.setPrivateKey(b64(RFC.asPrivate));
  assert.equal(as.getPublicKey().toString("base64url"), RFC.asPublic);
  assert.equal(as.computeSecret(b64(RFC.uaPublic)).toString("base64url"), RFC.sharedSecret);
  // http_ece is the encryption engine web-push uses for aes128gcm.
  const body = ece.encrypt(Buffer.from(RFC.plaintext), { version: "aes128gcm", dh: b64(RFC.uaPublic), privateKey: as, salt: b64(RFC.salt), authSecret: b64(RFC.auth) });
  assert.equal(body.toString("base64url"), RFC.body);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(b64(RFC.uaPrivate));
  assert.equal(decrypt(b64(RFC.body), ua, b64(RFC.auth)).toString(), RFC.plaintext);
});

test("library-built push requests decrypt with the subscriber's keys and carry a verifiable VAPID token", () => {
  const vapid = generateVapidKeys();
  const config: WebPushConfig = { ...vapid, subject: "mailto:ops@example.com" };
  const b = browser();
  const request = pushRequest(config, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", ...b.keys }, '{"title":"hi"}', "release1");
  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(decrypt(request.body, b.ua, b.auth).toString(), '{"title":"hi"}');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.Authorization)!;
  assert.equal(k, vapid.publicKey);
  const [h, c, sig] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:ops@example.com");
  const pub = Buffer.from(vapid.publicKey, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(h + "." + c), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("push configuration is off by default and only known push services are contacted", () => {
  assert.equal(configuredWebPush({}), undefined);
  assert.throws(() => configuredWebPush({ WEB_PUSH_PUBLIC_KEY: "x" }));
  const keys = generateVapidKeys();
  assert.ok(configuredWebPush({ WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: "https://example.com" }));
  assert.ok(allowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x"));
  assert.ok(allowedPushEndpoint("https://web.push.apple.com/abc"));
  for (const bad of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x"])
    assert.equal(allowedPushEndpoint(bad), false, bad);
});

test("each release notifies each opted-in subscription once, retries transient failures and drops gone endpoints", async (t) => {
  const db = await testDatabase();
  const vapid = generateVapidKeys();
  const config: WebPushConfig = { ...vapid, subject: "mailto:ops@example.com" };
  const app = await createApp(db, { origin: "http://push.test", secureCookies: false, webPush: config });
  t.after(async () => { await app.close(); await db.close(); });
  const eventId = randomUUID();
  await db.query("INSERT INTO events(id,artist_id,slug,title,artist_name,settings) VALUES($1,'our-jam',$2,'Push show','Artist','{}')", [eventId, "push-" + eventId.slice(0, 8)]);
  const join = await app.inject({ method: "POST", url: "/api/session", headers: { origin: "http://push.test" }, payload: {} });
  const cookie = "oj_guest=" + join.cookies.find((c) => c.name === "oj_guest")!.value;
  const headers = { origin: "http://push.test", cookie };
  const participant = (await db.query("SELECT participant_id FROM sessions WHERE kind='guest' LIMIT 1")).rows[0].participant_id;
  const good = browser(), gone = browser();
  const subscribe = (endpoint: string, keys: any) => app.inject({ method: "PUT", url: `/api/events/${eventId}/push`, headers, payload: { endpoint, keys } });
  assert.equal((await subscribe("https://fcm.googleapis.com/fcm/send/good", good.keys)).statusCode, 409);
  await db.query("INSERT INTO event_members(event_id,participant_id) VALUES($1,$2)", [eventId, participant]);
  assert.equal((await subscribe("https://evil.example/push", good.keys)).statusCode, 400);
  assert.equal((await subscribe("https://fcm.googleapis.com/fcm/send/good", good.keys)).statusCode, 200);
  assert.equal((await subscribe("https://updates.push.services.mozilla.com/wpush/v2/gone", gone.keys)).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/events/${eventId}/push`, headers })).json().subscribed, true);
  // A published release with its generation job.
  const roundSource = randomUUID(), round = randomUUID(), job = randomUUID(), release = randomUUID();
  await db.query("INSERT INTO source_tracks(id,event_id,title,core_prompt,duration_seconds,ordinal) VALUES($1,$2,'S','C',60,1)", [roundSource, eventId]);
  await db.query("INSERT INTO rounds(id,event_id,source_id,state,deadline_at,seed,seed_commitment,core_prompt,settings) VALUES($1,$2,$3,'closed',now(),'s','c','C','{}')", [round, eventId, roundSource]);
  await db.query("INSERT INTO generation_jobs(id,event_id,round_id,state,snapshot,prompt,prompt_hash) VALUES($1,$2,$3,'published','{}','p','h')", [job, eventId, round]);
  await db.query("INSERT INTO releases(id,event_id,job_id,title,audio_url,download_url,duration_seconds,published_at) VALUES($1,$2,$3,'Crowd Take','x','x',60,now())", [release, eventId, job]);
  const received: string[] = [];
  let flaky = 1;
  config.send = async (endpoint, init) => {
    if (endpoint.includes("gone")) return { status: 410 };
    if (flaky-- > 0) return { status: 503 };
    assert.match(init.headers.Authorization, /^vapid t=/);
    assert.equal(init.headers["Content-Encoding"], "aes128gcm");
    received.push(decrypt(init.body, good.ua, good.auth).toString());
    return { status: 201 };
  };
  await pushTick(db, config);
  assert.equal(received.length, 0);
  await db.query("UPDATE push_deliveries SET next_attempt_at=now()");
  await pushTick(db, config);
  await pushTick(db, config);
  assert.equal(received.length, 1);
  const message = JSON.parse(received[0]);
  assert.equal(message.url, `/event/push-${eventId.slice(0, 8)}?track=${release}`);
  const states = (await db.query("SELECT state FROM push_deliveries ORDER BY state")).rows.map((r) => r.state);
  assert.deepEqual(states, ["gone", "sent"]);
  assert.equal((await db.query("SELECT count(*)::integer n FROM push_subscriptions WHERE disabled_at IS NOT NULL")).rows[0].n, 1);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/events/${eventId}/push`, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/events/${eventId}/push`, headers })).json().subscribed, false);
});
