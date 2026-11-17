# Deploying Our Jam

## Galinsky Arts deployment (current, November 15, 2026)

The repository moved to **GitHub `Galinsky-Arts/Our-Jam`**. The earlier `neophilism` Render project, Neon project `crimson-hat-87508124` and `our-jam-rehearsal.onrender.com` below are historical and are not used by this deployment.

| Resource | Value |
| --- | --- |
| Render workspace | `tea-dbp1vrrl550s73c3dgrg` |
| Render service | `our-jam`, `srv-dbsvo2k9v7es73bpvof0`, free web service, Docker, region virginia, branch `main`, auto-deploy on commit, health check `/api/ready` |
| Public URL | https://our-jam-fntx.onrender.com |
| Neon organization / project | `org-red-surf-69664431` / `our-jam` = `fragrant-recipe-39993342` (Postgres 17, aws-us-east-1), branch `br-super-mountain-bbfqp7l4`, database `neondb` |

Environment variable **names** (values live only in Render; never commit them):

- Set: `NODE_ENV=production`, `PORT=10000`, `PUBLIC_ORIGIN` (the URL above), `GENERATION_ENABLED=0`, `EMAIL_ENABLED=0`, `RUN_INLINE_GENERATION=0`, `RUN_MIGRATIONS`, `DATABASE_URL` (pooled, restricted `our_jam_app` login), `OPERATOR_TOKEN` and `ADMIN_TOKEN` (generated 48-character secrets; the platform admin console uses `ADMIN_TOKEN`, the performer console `OPERATOR_TOKEN`).
- Migration-only (present only while `RUN_MIGRATIONS=1`): `DATABASE_URL_UNPOOLED` (direct `neondb_owner` connection) and `RUNTIME_ROLE_PASSWORD`.
- Optional tuning (unset = defaults): `JOIN_RATE_PER_MINUTE` (1500), `ANON_READS_PER_MINUTE` (60000), `ROOM_SNAPSHOT_MAX_AGE_MS` (750), `DATABASE_POOL_MAX` (8); `DR_VERIFY_DATABASE_URL` only during a restore drill ([disaster recovery](disaster-recovery.md)).
- Generated and set (November 17, 2026): `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` (VAPID pair from `scripts/generate-vapid-keys.mjs`) and `WEB_PUSH_SUBJECT` for browser release notifications.
- Owner-supplied, not set (each feature stays off and `/admin/configuration` names what to set): `MEDIA_ENDPOINT`, `MEDIA_BUCKET`, `MEDIA_REGION`, `MEDIA_ACCESS_KEY_ID`, `MEDIA_SECRET_ACCESS_KEY`, `MEDIA_HOSTS` (private S3-compatible storage for album uploads and releases; without it shows use device-only albums); `MUREKA_API_KEY`, `STABLE_AUDIO_KEY` (generation stays at a hard $0 budget even when present); `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_DATA_KEY`, `EMAIL_DELIVERY_ACK` (release email); `OURJAM_GPU_GATEWAY_URL`, `OURJAM_GPU_GATEWAY_TOKEN` (comparison GPU gateway); `COMMERCE_ENABLED=1`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PLATFORM_ADMIN_TOKEN` (event payments and sponsor videos; live charges also need `COMMERCE_LIVE_PAYMENTS_ACK`); `IDENTITY_ENABLED=1`, `NEON_AUTH_BASE_URL` (Neon Auth with the Google provider enabled) for Google/email sign-in. Opt-in acceptance secrets for GitHub Actions: `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`, and variables `OUR_JAM_ORIGIN`, `NEON_AUTH_BASE_URL`.

### Least-privilege runtime role

Neon API-created roles join `neon_superuser`, so the runtime login is created with SQL. On the first boot the service ran with `RUN_MIGRATIONS=1`, `DATABASE_URL_UNPOOLED` and `RUNTIME_ROLE_PASSWORD`: it applied every migration through the owner connection, then `apps/api/src/runtime-role.ts` created `our_jam_app` (LOGIN, NOINHERIT, no CREATEDB/CREATEROLE) with the `db/runtime-grants.sql` privileges and verified it is not superuser, not a `neon_superuser`/`pg_write_all_data` member, cannot CREATE in the schema, cannot write `schema_migrations` and owns no tables. `DATABASE_URL` was then switched to the pooled `our_jam_app` connection; later deploys reached **live** through the `/api/ready` health check, which reads `schema_migrations` through that login.

### Applying a future migration

New migrations are not applied while `RUN_MIGRATIONS=0`. Before merging a PR that adds one: in Render, set `RUN_MIGRATIONS=1`, add `DATABASE_URL_UNPOOLED` (the direct owner connection string from the Neon console) and deploy. Startup migrates, re-grants `our_jam_app` on new tables, then serves. Afterwards set `RUN_MIGRATIONS=0` and delete `DATABASE_URL_UNPOOLED` again. Migrations must stay additive so the previous instance keeps working during the rolling deploy. Applied this way on November 17, 2026 for migrations 025-029 (PR #110), after creating the Neon backup branch `backup-before-028-029-20261117` from `main`; the deploy logged the `our_jam_app` re-grant and went live through `/api/ready`, then both settings were reverted.

### Verification available here

The build sandbox cannot reach `*.onrender.com` or Postgres directly. Evidence comes from the Render API (deploy status and application logs: `runtimeRole` provisioning, `status: listening` on port 10000, `generation: not_configured`) and the external **Hosted rehearsal readiness** workflow, which now defaults to this URL. It checks `/api/health`, `/api/ready`, the performer page, unauthenticated 401s and cross-origin 403s. Media checks default off (`OUR_JAM_REQUIRE_MEDIA=0`) until storage is configured. Real phones, owner uploads, provider generation and email remain unverified.

## Earlier deployment record (historical)

The intended grouping target is Render project `prj-db5btotckfvc739m1ck0` and Neon project `crimson-hat-87508124`. Production database branch: `br-aged-sea-b55fzq0v`. Rehearsal branch: `br-blue-unit-b5rk1hit` (`dev-our-jam-foundation`). The exact current external evidence is in [resource reconciliation](rehearsal-resource-state.md).

## Current external state

Production migrations 001-008 were successfully initialized and verified on October 12, 2026, under the owner's previously recorded and renewed authorization. The production schema matches the rehearsal schema with an empty Neon schema diff and contains no user events, participants, generation jobs or email jobs. Do not repeat initialization or tell the owner this schema approval is still missing.

The production `our_jam_app` role has restricted application DML/sequence permissions and read-only migration history. It deliberately remains NOLOGIN, with no production credential issued, until an authorized hosted destination exists. The isolated rehearsal branch has its own restricted runtime login. No credential values belong in source or documentation.

**October 16 further acceptance:** Live commit `bcbb05b` ran the opt-in private S3 2 KiB object PUT/HEAD/GET/DELETE at startup and emitted `media: verified`; the service was live after the probe. A Neon object-list readback showed no diagnostics left. PR #40 added live negative authorization/Origin checks and made verified storage required in the hosted CI. Real owner files and venue hardware remain unaccepted. **[Step-by-step hosted user rehearsal](hosted-first-rehearsal.md).**

**October 16 live update:** The earlier no-hosting status has been superseded. The dedicated free `our-jam-rehearsal` Docker service exists in the confirmed workspace and is live at `https://our-jam-rehearsal.onrender.com`, using the restricted **rehearsal** branch Neon `our_jam_app` login, exact HTTPS origin, an operator bootstrap token and zero enabled provider/email delivery. Automated externally executed `/api/health` and `/api/ready` smoke passed at main commit `0569d41`. Keep live show deployment disabled. This proves server/database readiness, not actual fan participation, real album private downloads or physical venue acceptance.

Private Neon Object Storage exists on the isolated branch, and branch-bound read/write credentials were configured in the rehearsal Render service on October 16. The user-uploaded audio workflow still needs real asset acceptance. For an independent provider-independent storage check, explicitly set `MEDIA_PROBE_ON_START=1` on this isolated rehearsal service after this source release is deployed. On startup the server creates an isolated random 2 KiB diagnostic object, checks its metadata, reads and compares exact bytes over signed S3, exercises the private signed HTTPS playback URL and rejects an unsigned GET, then deletes only that diagnostic key. Failure prevents a false readiness claim; never use the live/production branch for this rehearsal. Once its log reports `media: verified`, set `OUR_JAM_REQUIRE_MEDIA_VERIFIED=1` in the read-only hosted smoke test. This test cannot certify MP3 decoding, authenticated delivery, physical phones or capacity. Both music providers remain subject to the owner's hard $0 limit; no paid generation or real email delivery is enabled.

## Deployment procedure when the deployment action is available

1. Confirm the confirmed workspace and actual environment; use the reviewed root `render.yaml` definition and Dockerfile. The definition creates one free rehearsal web service, not a paid worker, disk, database or assumed project. Do not work around a tool denial. Grouping can be applied separately when the connector supports it; this is not permission to reuse another project's service.
2. Use the repository's Node 24, locked dependencies, non-root Docker runtime and FFmpeg/FFprobe. The existing application CI includes the actual Docker build. Keep auto-deployment off for live shows.
3. Select production or isolated rehearsal explicitly. Both currently have migrations 001-008. Before any future schema change, rehearse the exact additive migration on the isolated branch, verify the target's current history, and apply using the project-specific direct connection. Never reset or reinitialize the populated production schema. Runtime uses the restricted pooled connection; migration-on-start remains disabled.
4. Provision a strong scoped runtime credential only into the approved service secret store. Enable the prepared production runtime role only when deploying to production. Never supply a schema-owner or administrative connection to the application. Set exact `PUBLIC_ORIGIN`, or use validated `RENDER_EXTERNAL_URL` when `RENDER=true`. Keep `OPERATOR_TOKEN` private and out of URLs. The performer login exchanges it for the existing 12-hour HttpOnly session.
5. Set both generation budget limits to zero, email delivery off, and migration-on-start off for the first hosted validation. Provider keys are not required to verify audience participation and the no-call budget boundary. Do not infer runtime secrets from their presence in GitHub.
6. Verify `/api/health` and the deployed commit, `/api/ready` and migration history, exact HTTPS/cookie behavior, private projections and media access. Then use two independent browser identities to join, allocate five points, pause/resume and close one round. Do not seed user-facing demonstration activity.
7. In an isolated rehearsal event, upload the owner's real album files with correct core prompts, titles and durations; verify restart persistence and playback. Configure and test the private object store without publishing private masters. Keep an independent local album player and recorder available.
8. Only after an explicit funded allowance, verify both real provider accounts, rights/pricing, quality, latency and the complete generation-to-release/download flow. The provider toggle never authorizes spending. Retain current price/rights checks and test the declared physical hardware and attendance tier before a public show.

## Recovery and release operation

Take a project-specific recovery checkpoint before future risky migrations. Preserve event data, votes, task receipts, reservations and media when reverting application versions. Never roll back to code that cannot read active paused rounds without draining them first. Ambiguous provider jobs must not be converted to queued as a shortcut. Private generated assets and microphone chunks have different storage paths; microphone recordings remain on the recording device.

Production schema initialization and restricted-role preparation are complete; a production application connection is not. Native Simulator acceptance is separate from physical devices, TestFlight, hardware capture and qualified independent security review. Nothing in this procedure certifies full V1 or E2EESA conformance.

## Traffic behavior

Read [live traffic](live-traffic.md) before setting an attendance cap or adding instances. Bounded snapshot work and socket buffers plus deterministic crowd tests do not replace deployed venue measurements. Configure `/api/ready` as the Render health check when an authorized service exists; the direct creation action cannot set it. A free rehearsal service is not an uptime guarantee for a live show.
