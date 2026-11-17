import { useEffect, useState } from "react";
import { api } from "./api";

type Award = { kind: string; label: string; evidence?: Record<string, unknown> };
type Contribution = {
  waveId?: string;
  receiptId?: string | null;
  receiptNamed?: boolean;
  text: string;
  createdAt: string;
  hidden: boolean;
  event: { slug: string; title: string; artistName: string; artistId: string };
  status: "voting" | "included" | "released" | "not_selected";
  rank: number | null;
  votes: number;
  supporters: number;
  release: { id: string; title: string } | null;
  awards: Award[];
  contributor?: string;
};
const STATUS: Record<Contribution["status"], string> = {
  voting: "Voting now",
  included: "Shaped the next track",
  released: "Released",
  not_selected: "Not in this track",
};

function AwardBadges({ awards }: { awards: Award[] }) {
  if (!awards.length) return null;
  return (
    <ul className="award-badges" aria-label="Recognition">
      {awards.map((a) => (
        <li key={a.kind} className="award-badge">
          {a.label}
        </li>
      ))}
    </ul>
  );
}

function ContributionCard({ c, onChange }: { c: Contribution; onChange: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(""),
    [showName, setShowName] = useState(Boolean(c.receiptNamed));
  const link = c.receiptId ? location.origin + "/receipt/" + c.receiptId : "";
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="panel contribution">
      <p className="contribution-text">“{c.text}”</p>
      <p className="tiny muted">
        <a href={`/event/${encodeURIComponent(c.event.slug)}`}>{c.event.title}</a> ·{" "}
        {c.event.artistName} · <span className={"status-chip status-" + c.status}>{STATUS[c.status]}</span>
        {c.rank ? ` · ranked #${c.rank}` : ""} · {c.supporters}{" "}
        {c.supporters === 1 ? "supporter" : "supporters"}
      </p>
      {c.release && (
        <p className="tiny">
          Heard in{" "}
          <a href={`/event/${encodeURIComponent(c.event.slug)}?track=${c.release.id}`}>{c.release.title}</a>
        </p>
      )}
      <AwardBadges awards={c.awards} />
      {c.hidden ? (
        <p className="tiny muted">Hidden by the artist’s moderators; it cannot be shared.</p>
      ) : (
        <div className="receipt-controls">
          <label className="check tiny">
            <input
              type="checkbox"
              checked={showName}
              disabled={busy}
              onChange={(e) => setShowName(e.target.checked)}
            />
            Show my display name on the shared receipt (anonymous profiles always stay anonymous)
          </label>
          <button
            type="button"
            className="ghost small"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api("/me/receipts", "POST", { waveId: c.waveId, showName });
              })
            }
          >
            {c.receiptId ? "Create a new share link" : "Create share link"}
          </button>
          {c.receiptId && (
            <>
              <button
                type="button"
                className="ghost small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setCopied("Link copied.");
                  } catch {
                    setCopied(link);
                  }
                }}
              >
                Copy link
              </button>
              <button
                type="button"
                className="ghost small"
                disabled={busy}
                onClick={() => run(() => api(`/me/receipts/${c.receiptId}`, "DELETE"))}
              >
                Stop sharing
              </button>
            </>
          )}
          {copied && (
            <p className="tiny" role="status">
              {copied}
            </p>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export function MusicJourney() {
  const [items, setItems] = useState<Contribution[] | null>(null),
    [events, setEvents] = useState<any[]>([]),
    [upcoming, setUpcoming] = useState<any[]>([]),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  async function load() {
    try {
      const [c, e, u] = await Promise.all([
        api<{ contributions: Contribution[] }>("/me/contributions"),
        api<{ events: any[] }>("/me/events"),
        api<{ events: any[] }>("/following/upcoming"),
      ]);
      setItems(c.contributions);
      setEvents(e.events);
      setUpcoming(u.events);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (error) return null;
  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (c) => !q || c.text.toLowerCase().includes(q) || c.event.title.toLowerCase().includes(q),
  );
  return (
    <>
      {upcoming.length > 0 && (
        <section className="panel" aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading">Shows from artists you follow</h2>
          <ul className="plain-list">
            {upcoming.map((e) => (
              <li key={e.slug}>
                <a href={`/event/${encodeURIComponent(e.slug)}`}>{e.title}</a> · {e.artistName}{" "}
                {e.live ? <strong className="status-chip status-voting">Live now</strong> : <span className="muted">Coming up</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="panel" aria-labelledby="contributions-heading">
        <h2 id="contributions-heading">Your Sound Waves</h2>
        <p className="tiny muted">
          Every idea you shared, what happened to it, and any recognition it earned. Share a receipt to show
          friends; nothing private (your profile, other fans or the artist’s prompt) is included.
        </p>
        {items && items.length > 5 && (
          <label>
            Find a Sound Wave or show
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {!items ? (
          <p>Loading your contributions…</p>
        ) : items.length === 0 ? (
          <p className="empty">Join a live show and share a Sound Wave to start your collection.</p>
        ) : (
          <ul className="contribution-list">
            {shown.map((c) => (
              <ContributionCard key={c.waveId} c={c} onChange={() => void load()} />
            ))}
          </ul>
        )}
      </section>
      {events.length > 0 && (
        <section className="panel" aria-labelledby="my-shows-heading">
          <h2 id="my-shows-heading">Shows you joined</h2>
          <ul className="plain-list">
            {events.map((e) => (
              <li key={e.slug}>
                <a href={`/event/${encodeURIComponent(e.slug)}`}>{e.title}</a> ·{" "}
                <a href={`/artist/${encodeURIComponent(e.artistId)}`}>{e.artistName}</a> ·{" "}
                <span className="muted">
                  {e.releases} {e.releases === 1 ? "track" : "tracks"} released · {e.myWaves} of your ideas
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function PrivacyControls() {
  const [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  if (done)
    return (
      <section className="panel" role="status">
        <h2>Your profile was erased</h2>
        <p>
          Your name, picture, follows, recovery key, sign-in link, receipts, email subscriptions and comments were
          removed. Sound Waves already used in released tracks remain, credited anonymously.
        </p>
      </section>
    );
  return (
    <section className="panel" aria-labelledby="privacy-heading">
      <h2 id="privacy-heading">Your data</h2>
      <p>
        <a className="button ghost small" href="/api/account/export" download>
          Download everything Our Jam stores about you
        </a>
      </p>
      <details>
        <summary>Erase this profile</summary>
        <p className="tiny">
          This cannot be undone. Your Sound Waves stay attached to tracks the crowd already released, but they will
          be credited to “Anonymous”. Vote totals are not changed.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/account/erase", "POST", { confirm });
              setDone(true);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Type <strong>ERASE MY PROFILE</strong> to confirm
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </label>
          <button className="danger" disabled={busy || confirm !== "ERASE MY PROFILE"}>
            Erase my profile
          </button>
        </form>
      </details>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function ReceiptPage({ id }: { id: string }) {
  const [data, setData] = useState<Contribution | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api<{ receipt: Contribution }>(`/receipts/${encodeURIComponent(id)}`)
      .then((r) => setData(r.receipt))
      .catch((e) => setError(e.message));
  }, [id]);
  return (
    <main className="artist-page receipt-page">
      <span className="eyebrow">CONTRIBUTION RECEIPT</span>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>Loading…</p>
      ) : (
        <article className="panel receipt">
          <h1>“{data.text}”</h1>
          <p>
            {data.contributor} shared this Sound Wave at{" "}
            <a href={`/event/${encodeURIComponent(data.event.slug)}`}>{data.event.title}</a> with{" "}
            <a href={`/artist/${encodeURIComponent(data.event.artistId)}`}>{data.event.artistName}</a>.
          </p>
          <p>
            <span className={"status-chip status-" + data.status}>{STATUS[data.status]}</span>
            {data.rank ? ` · ranked #${data.rank} by the crowd` : ""} · {data.supporters}{" "}
            {data.supporters === 1 ? "supporter" : "supporters"}
          </p>
          {data.release && (
            <p>
              Listen to{" "}
              <a href={`/event/${encodeURIComponent(data.event.slug)}?track=${data.release.id}`}>
                {data.release.title}
              </a>
            </p>
          )}
          <AwardBadges awards={data.awards} />
          <p className="tiny muted">Shared {new Date(data.createdAt).toLocaleDateString()} · Made with Our Jam</p>
        </article>
      )}
    </main>
  );
}

export function ReleaseAwards({ releaseId }: { releaseId: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    api(`/releases/${releaseId}/awards`)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [releaseId]);
  if (!data?.awards?.length) return null;
  return (
    <details className="credits awards">
      <summary>Recognition · {data.awards.length}</summary>
      <ul className="plain-list">
        {data.awards.map((a: any) => (
          <li key={a.kind}>
            <strong>{a.label}</strong>: “{a.text}” · {a.contributor}
          </li>
        ))}
      </ul>
      <p className="tiny muted">
        Recomputed from the stored round ({data.rules.version}); awards never change votes.{" "}
        {data.stats.waves} ideas, average {data.stats.averageVotesPerWave} votes each.
      </p>
    </details>
  );
}

export function ShowReminders({ artistId, following }: { artistId: string; following: boolean }) {
  const [on, setOn] = useState<boolean | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api(`/artists/${encodeURIComponent(artistId)}/follow`)
      .then((d) => setOn(Boolean(d.reminders)))
      .catch(() => {});
  }, [artistId, following]);
  if (!following || on === null) return null;
  return (
    <label className="check tiny">
      <input
        type="checkbox"
        checked={on}
        onChange={async (e) => {
          const enabled = e.target.checked;
          setError("");
          try {
            setOn((await api(`/artists/${encodeURIComponent(artistId)}/reminders`, "PUT", { enabled })).reminders);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      Remind me in Our Jam when this artist schedules or starts a show
      {error && <span role="alert"> {error}</span>}
    </label>
  );
}
