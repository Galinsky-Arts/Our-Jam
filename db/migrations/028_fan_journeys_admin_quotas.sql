CREATE TABLE contribution_receipts (
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{22}$'),
 wave_id uuid NOT NULL UNIQUE REFERENCES sound_waves(id),
 participant_id uuid NOT NULL REFERENCES participants(id),
 show_name boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE INDEX contribution_receipts_owner ON contribution_receipts(participant_id);
ALTER TABLE artist_follows ADD COLUMN event_reminders boolean NOT NULL DEFAULT false;
ALTER TABLE artist_follows ADD COLUMN reminders_consent_at timestamptz;
CREATE TABLE artist_quotas (
 artist_id text PRIMARY KEY REFERENCES artists(id),
 max_events integer NOT NULL DEFAULT 50 CHECK(max_events BETWEEN 0 AND 100000),
 max_live_events integer NOT NULL DEFAULT 1 CHECK(max_live_events BETWEEN 0 AND 100),
 monthly_generation_cents integer NOT NULL DEFAULT 0 CHECK(monthly_generation_cents BETWEEN 0 AND 100000000),
 suspended boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_admin_audit (
 id bigserial PRIMARY KEY, action text NOT NULL, subject text,
 detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE participant_erasures (
 id uuid PRIMARY KEY, erased_at timestamptz NOT NULL DEFAULT now(), policy_version text NOT NULL
);
