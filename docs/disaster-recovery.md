# Disaster recovery runbook (OJ-041)

Resources: Render service `srv-dbsvo2k9v7es73bpvof0`, Neon project `fragrant-recipe-39993342` (default branch `main`, `br-super-mountain-bbfqp7l4`). Use only these. Never delete `main` or a backup branch during an incident.

## Drill record — November 17, 2026

1. Backup branch `dr-drill-backup-20261117` (`br-weathered-water-bb5htp7l`) created from `main` via the Neon API (no compute; free plan).
2. Temporary restore branch `dr-drill-restore-temp-20261117` created from that backup with a **read-only** compute endpoint.
3. Render variable `DR_VERIFY_DATABASE_URL` pointed the running app (restricted `our_jam_app` login, `default_transaction_read_only=on`) at the restore endpoint; the deploy logged `dr_verification`: **56 of 56 tables matched** on row count and order-independent content digest (no stable or volatile mismatches, no extra tables). Only counts and match flags are logged.
4. The variable was deleted and **only the temporary restore branch** was deleted. Both backup branches (`dr-drill-backup-20261117`, `backup-before-028-029-20261117`) were kept.

Limit: the hosted database held 25 rows (mostly configuration), so this proves the procedure and tooling, not restore time for a large show. Media objects are not covered (no `MEDIA_*` storage is configured).

## Routine backups

- Before every migration or risky change: create a branch from `main` named `backup-before-<change>-<date>` (Neon API `POST /projects/{id}/branches` with `parent_id` = main). Neon also keeps point-in-time history for the plan's restore window.
- Rehearse the drill above after schema changes: backup branch → temporary read-only restore branch → `DR_VERIFY_DATABASE_URL` → read the `dr_verification` log → delete the variable and the temporary branch.

## Incident: database damaged or bad migration

1. **Freeze writes:** in Render set `OPERATOR_TOKEN` unchanged but suspend the service (or scale to zero) so no new votes land on the damaged data. Tell the performer to keep the local album backup and recorder running; the show can continue without the app.
2. **Pick the recovery point:** the latest backup branch, or a point in time just before the incident (Neon branch `parent_timestamp`).
3. **Restore:** create a restore branch from that point. Either (a) Neon "restore branch" onto `main` (keeps `main`'s endpoint and connection strings; Neon preserves the pre-restore state as a backup branch), or (b) promote the restore branch and update `DATABASE_URL` (pooled, `our_jam_app`) in Render.
4. **Verify** with the drill steps (digest comparison against the chosen backup), then check `/api/ready` reports 16+ migrations and the hosted smoke workflow passes.
5. **Resume:** redeploy; clients recover automatically (stream reconnect plus snapshot refresh). Paid generation jobs left `unknown` are never resubmitted automatically; reconcile them from the performer console.

## Incident: application release broken

Redeploy the last good commit in Render (`POST /v1/services/{id}/deploys` with `commitId`). Migrations are additive, so older code runs on the newer schema. Do not roll back the schema.

## Incident: credentials exposed

- `OPERATOR_TOKEN`, `ADMIN_TOKEN`/`PLATFORM_ADMIN_TOKEN`: replace in Render and redeploy; existing sessions expire (12 h / 6 h) — delete `sessions` of kind `operator` / `platform_admin_sessions` rows for immediate revocation.
- Onboarded artist keys: **Administration → Artists → Replace performer key** (revokes the key and its sessions).
- `our_jam_app` password: reset with SQL as the owner (`ALTER ROLE our_jam_app PASSWORD ...`), update `DATABASE_URL`, redeploy.
- `WEB_PUSH_*`: generate a new pair with `scripts/generate-vapid-keys.mjs`; existing browser subscriptions stop working and fans re-enable notifications.
- Stripe/Resend/provider keys: rotate at the provider, then replace in Render.

## Provider continuity

Generation stays at a $0 budget, so no provider failover is enabled. A second provider requires owner approval for rights, cost and sound; uncertain provider jobs are never duplicated (see `docs/generation-reconciliation.md`).
