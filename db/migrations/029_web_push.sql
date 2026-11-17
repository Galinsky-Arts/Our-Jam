CREATE TABLE push_subscriptions (
 id uuid PRIMARY KEY,
 participant_id uuid NOT NULL REFERENCES participants(id),
 event_id uuid NOT NULL REFERENCES events(id),
 endpoint text NOT NULL CHECK(length(endpoint) <= 1024),
 p256dh text NOT NULL CHECK(p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),
 auth text NOT NULL CHECK(auth ~ '^[A-Za-z0-9_-]{22,24}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 disabled_at timestamptz,
 failures integer NOT NULL DEFAULT 0,
 UNIQUE(event_id,endpoint)
);
CREATE INDEX push_subscriptions_participant ON push_subscriptions(participant_id);
CREATE TABLE push_deliveries (
 release_id uuid NOT NULL REFERENCES releases(id),
 subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','gone')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(release_id,subscription_id)
);
CREATE INDEX push_deliveries_due ON push_deliveries(state,next_attempt_at);
CREATE TABLE push_release_fanout (
 release_id uuid PRIMARY KEY REFERENCES releases(id), created_at timestamptz NOT NULL DEFAULT now()
);
