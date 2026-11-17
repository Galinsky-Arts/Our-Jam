// OJ-040 local scale validation. Drives a running Our Jam server with N
// simulated participants through real HTTP: guest session, event join, live
// stream (with the browser client's debounced snapshot refresh on every
// update), Sound Wave submissions, votes and live-connection reconnects.
// LOCAL-HARDWARE EVIDENCE ONLY: one machine, loopback network, local Postgres.
// It is not hosted, venue, Wi-Fi or physical-phone evidence.
//
// Usage: node scripts/load-test.mjs http://127.0.0.1:4300 <operator-token> [participants]
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:4300";
const OPERATOR = process.argv[3] ?? process.env.OPERATOR_TOKEN;
const N = Number(process.argv[4] ?? process.env.LOAD_PARTICIPANTS ?? 1000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 100);
const WAVE_SHARE = Number(process.env.LOAD_WAVE_SHARE ?? 0.3);
const RECONNECT_SHARE = Number(process.env.LOAD_RECONNECT_SHARE ?? 0.5);
if (!OPERATOR) throw new Error("Pass the operator token.");
const ORIGIN = process.env.LOAD_ORIGIN ?? new URL(BASE).origin;

const stats = new Map();
function record(op, ms, status) {
  let s = stats.get(op);
  if (!s) stats.set(op, (s = { ms: [], statuses: {} }));
  s.ms.push(ms);
  s.statuses[status] = (s.statuses[status] ?? 0) + 1;
}
async function call(op, path, { method = "GET", body, cookie } = {}) {
  const started = performance.now();
  let status = "network_error", data = null;
  try {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { origin: ORIGIN }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    status = response.status;
    const text = await response.text();
    try { data = JSON.parse(text); } catch { data = null; }
    if (status >= 400 && data?.error) status = status + ":" + data.error;
    return { status, data, headers: response.headers };
  } catch (error) {
    status = error?.name === "TimeoutError" ? "timeout" : "network_error";
    return { status, data };
  } finally {
    record(op, performance.now() - started, status);
  }
}
async function pool(items, fn, limit = CONCURRENCY) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

// ---- Operator setup: event, capacity, playback lease, open round.
const login = await fetch(BASE + "/api/operator/login", {
  method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
  body: JSON.stringify({ token: OPERATOR }),
});
if (!login.ok) throw new Error("Operator login failed: " + login.status);
const op = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const slug = "load-" + randomUUID().slice(0, 8);
const created = await call("setup", "/api/operator/events", {
  method: "POST", cookie: op,
  body: { title: "Load test", artistName: "Load Artist", slug, minimumRoundSeconds: 0, voteMode: "single", votesPerListener: 5,
    sources: [{ title: "Song", corePrompt: "LOAD_TEST_CORE", durationSeconds: 600 }] },
});
if (created.status !== 200) throw new Error("Event creation failed: " + JSON.stringify(created.data));
const eventId = created.data.id;
let snap = await call("setup", "/api/operator/events/" + slug, { cookie: op });
const admission = await call("setup", `/api/operator/events/${eventId}/admission`, {
  method: "PATCH", cookie: op, body: { commandId: randomUUID(), expectedRevision: snap.data.event.revision, mode: "open", limit: N },
});
if (admission.status !== 200) throw new Error("Capacity change failed: " + JSON.stringify(admission.data));
const lease = (await call("setup", `/api/operator/events/${eventId}/playback/claim`, { method: "POST", cookie: op, body: {} })).data;
snap = await call("setup", "/api/operator/events/" + slug, { cookie: op });
const opened = await call("setup", `/api/operator/events/${eventId}/advance`, {
  method: "POST", cookie: op,
  body: { commandId: randomUUID(), expectedRevision: snap.data.event.revision, playback: { leaseToken: lease.leaseToken, epoch: lease.epoch, sequence: 1 } },
});
if (opened.status !== 200) throw new Error("Round open failed: " + JSON.stringify(opened.data));
const roundId = opened.data.roundId;
// The performer console keeps its playback lease alive; without it the round
// (correctly) pauses as "playback_disconnected".
let sequence = 1;
const heartbeat = setInterval(() => {
  void call("setup", `/api/operator/events/${eventId}/playback/heartbeat`, {
    method: "POST", cookie: op, body: { leaseToken: lease.leaseToken, epoch: lease.epoch, sequence: ++sequence },
  });
}, 2000);
console.log(`Event ${slug}: round open; simulating ${N} participants (concurrency ${CONCURRENCY}).`);

// ---- Live stream that behaves like useEvent(): debounce 180 ms, then refresh.
const users = Array.from({ length: N }, (_, i) => ({ i, cookie: "", stream: null, updates: 0, refreshes: 0 }));
function openStream(u) {
  const controller = new AbortController();
  const started = performance.now();
  let pending = null, firstByte = false;
  const ready = (async () => {
    try {
      const response = await fetch(BASE + `/api/events/${slug}/stream`, { headers: { cookie: u.cookie }, signal: controller.signal });
      record("stream_open", performance.now() - started, response.status);
      if (!response.ok) { await response.body?.cancel(); return false; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            if (!firstByte) { firstByte = true; record("stream_first_event", performance.now() - started, 200); }
            const updates = (text.match(/event: (update|reconnect)/g) ?? []).length;
            if (updates && !pending) {
              u.updates += updates;
              pending = setTimeout(async () => {
                pending = null;
                u.refreshes++;
                await call("snapshot_refresh", "/api/events/" + slug, { cookie: u.cookie });
              }, 180);
            }
          }
        } catch { /* aborted */ }
      })();
      return true;
    } catch {
      record("stream_open", performance.now() - started, "network_error");
      return false;
    }
  })();
  u.stream = { controller, ready, stop: () => { clearTimeout(pending); controller.abort(); } };
  return ready;
}

const phase = async (name, fn) => {
  const t = performance.now();
  await fn();
  console.log(`${name}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
};
await phase("join (session + event join + first snapshot)", () => pool(users, async (u) => {
  const s = await call("guest_session", "/api/session", { method: "POST", body: {} });
  u.cookie = (s.headers?.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  await call("event_join", `/api/events/${slug}/join`, { method: "POST", cookie: u.cookie, body: {} });
  await call("snapshot_initial", "/api/events/" + slug, { cookie: u.cookie });
}));
// Fans who have not joined yet read anonymously; at a venue they share one NAT address.
await phase("anonymous viewers (1 refresh each)", () => pool(users, () => call("snapshot_anonymous", "/api/events/" + slug)));
await phase("open live streams", () => pool(users, (u) => openStream(u), 200));
await sleep(1500);

const authors = users.slice(0, Math.round(N * WAVE_SHARE));
await phase("Sound Wave submissions", () => pool(authors, async (u) => {
  const view = await call("snapshot_before_write", "/api/events/" + slug, { cookie: u.cookie });
  await call("wave_submit", `/api/rounds/${roundId}/waves`, {
    method: "POST", cookie: u.cookie,
    body: { commandId: randomUUID(), expectedRevision: view.data?.round?.revision ?? 0, text: `idea ${u.i} ${randomUUID().slice(0, 6)}` },
  });
}));
await phase("votes", () => pool(users, async (u) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const view = await call("snapshot_before_write", "/api/events/" + slug, { cookie: u.cookie });
    const round = view.data?.round;
    if (!round) return;
    const allocations = {};
    for (const w of round.waves) if (w.mine > 0) allocations[w.id] = w.mine;
    const limit = round.voteLimit ?? 5;
    const others = round.waves.filter((w) => !allocations[w.id]);
    while (Object.keys(allocations).length < Math.min(limit, 3) && others.length)
      allocations[others.splice(Math.floor(Math.random() * others.length), 1)[0].id] = 1;
    const result = await call("vote_allocate", `/api/rounds/${roundId}/allocations`, {
      method: "PUT", cookie: u.cookie, body: { commandId: randomUUID(), expectedRevision: round.revision, allocations },
    });
    if (!String(result.status).startsWith("409")) return;
  }
}));
await sleep(3000);
const reconnecting = users.slice(0, Math.round(N * RECONNECT_SHARE));
await phase("live-connection reconnects", () => pool(reconnecting, async (u) => {
  u.stream.stop();
  await openStream(u);
  await call("snapshot_reconnect", "/api/events/" + slug, { cookie: u.cookie });
}, 250));
await sleep(3000);
for (const u of users) u.stream?.stop();
clearInterval(heartbeat);

// ---- Consistency: the operator's authoritative view after the load.
const final = await call("setup", "/api/operator/events/" + slug, { cookie: op });
const waves = final.data?.round?.waves ?? [];
const totalVotes = waves.reduce((n, w) => n + w.votes, 0);
const okVotes = stats.get("vote_allocate")?.statuses[200] ?? 0;
const okWaves = stats.get("wave_submit")?.statuses[200] ?? 0;

const rows = [...stats.entries()].filter(([k]) => k !== "setup").map(([op, s]) => {
  const sorted = [...s.ms].sort((a, b) => a - b);
  return { op, requests: sorted.length, p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)), p99: Math.round(pct(sorted, 99)), max: Math.round(sorted.at(-1) ?? 0), statuses: JSON.stringify(s.statuses) };
});
console.table(rows);
const refreshes = users.reduce((n, u) => n + u.refreshes, 0);
console.log(JSON.stringify({
  evidence: "local-hardware",
  participants: N,
  wavesAccepted: okWaves,
  wavesOnServer: waves.length,
  voteRequestsAccepted: okVotes,
  pointsOnServer: totalVotes,
  streamRefreshes: refreshes,
}, null, 1));
const failures = rows.flatMap((r) => Object.entries(JSON.parse(r.statuses)).filter(([s]) => !(s === "200" || s.startsWith("409:"))).map(([s, n]) => `${r.op} ${s}x${n}`));
if (waves.length !== okWaves) failures.push(`server has ${waves.length} waves, ${okWaves} accepted`);
if (failures.length) { console.log("FAILURES: " + failures.join(", ")); process.exitCode = 1; }
else console.log("PASS: no errors besides expected revision conflicts; server state matches accepted writes.");
