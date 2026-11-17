# OJ-040 scale validation — local-hardware evidence

**Label: LOCAL-HARDWARE EVIDENCE ONLY.** One 4-core / 15 GiB Linux sandbox ran the production build (`NODE_ENV=production`, `node dist/server/apps/api/src/main.js`), a local PostgreSQL 16 database and the load generator on the same machine over loopback. This is not hosted (Render free tier / Neon), venue Wi-Fi, mobile-network or physical-phone evidence; the 1000-contributor capacity is enabled on that basis and still needs a hosted/venue rehearsal (OJ-026/OJ-042).

## Method

`scripts/load-test.mjs` drives real HTTP only (no direct DB writes): the performer creates an event, raises contributor capacity to 1000, claims the playback lease (heartbeat every 2 s) and opens a round. Then 1000 simulated participants first read the room anonymously, then create a guest session, join, read a snapshot and hold a live stream that behaves like the browser client (debounced snapshot refresh 180 ms after every update). 300 submit a Sound Wave; all 1000 vote for three ideas (retrying revision conflicts); 500 drop and reopen their live connection. Concurrency 100 (250 for reconnects). Afterwards the operator's authoritative view is compared with the accepted writes.

Run: start the production build against a local database, then `LOAD_ORIGIN=<PUBLIC_ORIGIN> node scripts/load-test.mjs http://127.0.0.1:<port> <OPERATOR_TOKEN> 1000`. Restart the server between runs (rate-limit windows are per process).

## Bottlenecks found and fixed (November 17, 2026)

1. **Joins throttled to 120/minute per address.** Baseline: 880 of 1000 guest sessions got HTTP 429, and those fans could not join, vote or stream. A venue shares one NAT address, and behind a hosting proxy every client can share one upstream address, so this limited the whole show. Fix: `JOIN_RATE_PER_MINUTE` (default 1500, bounded 60-10000).
2. **Per-listener snapshot rebuilds after every room update.** Baseline after fix 1: 16,559 of 21,296 refreshes returned 503 `room_busy`. Fix: one room-wide snapshot shared for up to 750 ms (`ROOM_SNAPSHOT_MAX_AGE_MS`) and rebuilt (single-flight, shared by concurrent readers) on the first read after any write on that instance, plus a fresh per-listener overlay (own votes, ballot revision, reactions, membership). A unit test proves overlay + shared snapshot equals the listener's full snapshot.
3. **Anonymous viewers behind one address capped at 7200 reads/minute.** A read-only autocannon run (1000 connections, no session) received 234,585 HTTP 429 of 241,785 responses. Fans who have not joined yet read anonymously, so a venue NAT would share that budget. Fix: `ANON_READS_PER_MINUTE` (default 60000); those reads are served from the shared room snapshot. The scenario now includes 1000 anonymous viewer reads.
4. Contributor capacity raised from 100 to 1000 (API and performer UI); live-stream caps raised to 1500 per room / 3000 per instance. `DATABASE_POOL_MAX` (default 8) is configurable; 20 showed no measurable gain locally.

## Result after fixes

```
Event load-f803d90a: round open; simulating 1000 participants (concurrency 100).
join (session + event join + first snapshot): 3.5 s
anonymous viewers (1 refresh each): 0.2 s
open live streams: 0.6 s
Sound Wave submissions: 2.3 s
votes: 20.8 s
live-connection reconnects: 1.0 s
┌─────────┬─────────────────────────┬──────────┬──────┬──────┬──────┬──────┬─────────────────┐
│ (index) │ op                      │ requests │ p50  │ p95  │ p99  │ max  │ statuses        │
├─────────┼─────────────────────────┼──────────┼──────┼──────┼──────┼──────┼─────────────────┤
│ 0       │ 'guest_session'         │ 1000     │ 37   │ 188  │ 221  │ 225  │ '{"200":1000}'  │
│ 1       │ 'event_join'            │ 1000     │ 153  │ 280  │ 343  │ 519  │ '{"200":1000}'  │
│ 2       │ 'snapshot_initial'      │ 1000     │ 128  │ 204  │ 233  │ 256  │ '{"200":1000}'  │
│ 3       │ 'snapshot_anonymous'    │ 1000     │ 16   │ 28   │ 30   │ 30   │ '{"200":1000}'  │
│ 4       │ 'stream_open'           │ 1500     │ 103  │ 286  │ 303  │ 488  │ '{"200":1500}'  │
│ 5       │ 'stream_first_event'    │ 1500     │ 103  │ 286  │ 303  │ 488  │ '{"200":1500}'  │
│ 6       │ 'snapshot_refresh'      │ 25500    │ 1208 │ 1753 │ 1871 │ 2145 │ '{"200":25500}' │
│ 7       │ 'snapshot_before_write' │ 1300     │ 988  │ 1608 │ 1858 │ 2124 │ '{"200":1300}'  │
│ 8       │ 'wave_submit'           │ 300      │ 330  │ 709  │ 840  │ 843  │ '{"200":300}'   │
│ 9       │ 'vote_allocate'         │ 1000     │ 903  │ 1809 │ 2186 │ 2667 │ '{"200":1000}'  │
│ 10      │ 'snapshot_reconnect'    │ 500      │ 251  │ 357  │ 447  │ 451  │ '{"200":500}'   │
└─────────┴─────────────────────────┴──────────┴──────┴──────┴──────┴──────┴─────────────────┘
{
 "evidence": "local-hardware",
 "participants": 1000,
 "wavesAccepted": 300,
 "wavesOnServer": 300,
 "voteRequestsAccepted": 1000,
 "pointsOnServer": 3000,
 "streamRefreshes": 25500
}
PASS: no errors besides expected revision conflicts; server state matches accepted writes.
```

All 1000 joins, 1500 stream opens, 300 submissions and 1000 votes succeeded with no errors; the server holds exactly 300 Sound Waves and 3000 points (1000 × 3). Latencies are while ~880 snapshot refreshes per second are served by one Node process sharing the CPU with the load generator; p95 for votes is about 1.8 s and for refreshes about 1.75 s. Remaining risks: single-instance CPU for the refresh herd (a delta/push protocol would reduce it), Render free-tier CPU/memory, Neon latency and real radio networks.
