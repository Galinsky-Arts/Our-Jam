import { useEffect, useState } from "react";
import { api } from "./api";

type Quota = {
  maxEvents: number;
  maxLiveEvents: number;
  monthlyGenerationCents: number;
  suspended: boolean;
  revision: number;
  configured: boolean;
};
type Artist = {
  id: string;
  name: string;
  createdAt: string;
  events: number;
  liveEvents: number;
  activeKeys: number;
  quota: Quota;
};

function AdminGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ admin: boolean; configured: boolean } | null>(null);
  useEffect(() => {
    api("/admin/session").then(setState).catch(() => setState({ admin: false, configured: false }));
  }, []);
  if (!state) return <p>Checking administrator session…</p>;
  if (!state.admin)
    return (
      <main className="artist-page">
        <p role="alert">
          Sign in as the platform administrator on <a href="/admin">Voting policy</a> first.
        </p>
      </main>
    );
  return <>{children}</>;
}

function OneTimeKey({ value, label }: { value: string; label: string }) {
  return (
    <div className="notice" role="status">
      <strong>{label}</strong>
      <p className="tiny">
        Copy it now and give it to the artist privately. It is shown once; only its hash is stored. The artist signs
        in at <code>/performer</code> with it.
      </p>
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

function QuotaForm({ artist, onSaved }: { artist: Artist; onSaved: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setError("");
        try {
          await api(`/admin/artists/${encodeURIComponent(artist.id)}/quota`, "PUT", {
            expectedRevision: artist.quota.revision,
            maxEvents: Number(f.get("maxEvents")),
            maxLiveEvents: Number(f.get("maxLiveEvents")),
            monthlyGenerationCents: Math.round(Number(f.get("monthlyDollars")) * 100),
            suspended: f.get("suspended") === "on",
          });
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Events allowed
        <input name="maxEvents" type="number" min={0} max={100000} defaultValue={artist.quota.maxEvents} required />
      </label>
      <label>
        Live shows at once
        <input name="maxLiveEvents" type="number" min={0} max={100} defaultValue={artist.quota.maxLiveEvents} required />
      </label>
      <label>
        Monthly AI generation budget (USD)
        <input
          name="monthlyDollars"
          type="number"
          min={0}
          step={0.01}
          defaultValue={(artist.quota.monthlyGenerationCents / 100).toFixed(2)}
          required
        />
        <small className="muted">
          Also bounded by the platform-wide generation budget, which is currently $0.
        </small>
      </label>
      <label className="check">
        <input name="suspended" type="checkbox" defaultChecked={artist.quota.suspended} />
        Pause this artist (signs them out and blocks sign-in)
      </label>
      <button disabled={busy}>{busy ? "Saving…" : "Save limits"}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function Usage({ artistId }: { artistId: string }) {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [data, setData] = useState<any>(null);
  useEffect(() => {
    api(`/admin/artists/${encodeURIComponent(artistId)}/usage?month=${month}`).then(setData).catch(() => setData(null));
  }, [artistId, month]);
  return (
    <div>
      <label>
        Usage statement month
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </label>
      {data && (
        <table className="usage-table">
          <tbody>
            {[
              ["Events created", data.events_created],
              ["Song rounds", data.rounds],
              ["Sound Waves", data.sound_waves],
              ["Fans who joined", data.participants],
              ["Generation jobs", data.generation_jobs],
              ["Generation reserved", "$" + (data.generation_reserved_cents / 100).toFixed(2)],
              ["Tracks released", data.releases_published],
              ["Event payments received", "$" + (data.event_payments_cents / 100).toFixed(2)],
            ].map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ArtistAdmin() {
  const [artists, setArtists] = useState<Artist[] | null>(null),
    [error, setError] = useState(""),
    [issued, setIssued] = useState<{ label: string; token: string } | null>(null),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setArtists((await api<{ artists: Artist[] }>("/admin/artists")).artists);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <AdminGate>
      <main className="artist-page admin-artists">
        <span className="eyebrow">PLATFORM ADMINISTRATION</span>
        <h1>Artists, limits and usage</h1>
        <p className="muted">
          Each artist signs in with their own key and only sees their own shows. Limits apply to event creation,
          simultaneous live shows and AI generation spend.
        </p>
        {issued && <OneTimeKey value={issued.token} label={issued.label} />}
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const name = String(new FormData(form).get("name"));
            setBusy(true);
            setError("");
            try {
              const r = await api<{ token: string }>("/admin/artists", "POST", { name });
              setIssued({ label: `Performer key for ${name}`, token: r.token });
              form.reset();
              await load();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Onboard an artist</h2>
          <label>
            Artist name
            <input name="name" required maxLength={100} />
          </label>
          <button disabled={busy}>Create artist and key</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {!artists ? (
          <p>Loading artists…</p>
        ) : (
          artists.map((a) => (
            <section className="panel" key={a.id} aria-labelledby={"artist-" + a.id}>
              <h2 id={"artist-" + a.id}>
                {a.name} {a.quota.suspended && <span className="status-chip">Paused</span>}
              </h2>
              <p className="tiny muted">
                {a.id} · {a.events} events · {a.liveEvents} live ·{" "}
                {a.id === "our-jam" ? "signs in with OPERATOR_TOKEN" : `${a.activeKeys} active key`}
              </p>
              <details>
                <summary>Limits</summary>
                <QuotaForm artist={a} onSaved={() => void load()} />
              </details>
              <details>
                <summary>Usage statement</summary>
                <Usage artistId={a.id} />
              </details>
              {a.id !== "our-jam" && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={async () => {
                    if (!confirm(`Replace ${a.name}'s key? Their current key and sessions stop working.`)) return;
                    try {
                      const r = await api<{ token: string }>(`/admin/artists/${encodeURIComponent(a.id)}/key`, "POST");
                      setIssued({ label: `New performer key for ${a.name}`, token: r.token });
                      await load();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  Replace performer key
                </button>
              )}
            </section>
          ))
        )}
      </main>
    </AdminGate>
  );
}

export function ConfigurationStatus() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    api("/admin/configuration").then(setData).catch((e) => setError(e.message));
  }, []);
  return (
    <AdminGate>
      <main className="artist-page">
        <span className="eyebrow">PLATFORM ADMINISTRATION</span>
        <h1>What is switched on</h1>
        <p className="muted">
          Features that need an outside account, credential or spending approval stay off until their settings exist
          in the server environment. Secrets are never shown here.
        </p>
        {error && <p role="alert">{error}</p>}
        {data && (
          <ul className="config-list">
            {data.features.map((f: any) => (
              <li key={f.id} className="panel">
                <strong>{f.label}</strong>{" "}
                <span className={"status-chip " + (f.enabled ? "status-released" : "status-not_selected")}>
                  {f.enabled ? (f.status === "configured" ? "On (not verified)" : "On") : "Off"}
                </span>
                {!f.enabled || f.status === "configured" ? <p className="tiny">{f.enable}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </main>
    </AdminGate>
  );
}
