import { useEffect, useState } from "react";
import { api } from "./api";

// OJ-019 browser notifications for this show's releases. Shown only when the
// server has a VAPID key pair; explains platform limits instead of failing silently.
function keyBytes(base64url: string) {
  const s = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
export function ReleasePush({ eventId, joined }: { eventId: string; joined: boolean }) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null } | null>(null),
    [subscribed, setSubscribed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const supported =
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  useEffect(() => {
    let alive = true;
    api("/push/config")
      .then((c) => alive && setConfig(c))
      .catch(() => {});
    api(`/events/${eventId}/push`)
      .then((s) => alive && setSubscribed(Boolean(s.subscribed)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [eventId]);
  if (!config?.enabled || !joined) return null;
  if (!supported)
    return (
      <p className="tiny muted">
        This browser cannot show Our Jam notifications. On iPhone, add Our Jam to your Home Screen first (Share → Add
        to Home Screen), then open it from there.
      </p>
    );
  async function enable() {
    setBusy(true);
    setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("Notifications are blocked for this site. You can allow them in your browser settings.");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(config!.publicKey!),
        }));
      await api(`/events/${eventId}/push`, "PUT", subscription.toJSON());
      setSubscribed(true);
      setMessage("You will get one notification when each new track from this show is ready.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="release-push">
      {subscribed ? (
        <button
          type="button"
          className="ghost small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/events/${eventId}/push`, "DELETE");
              setSubscribed(false);
              setMessage("Notifications for this show are off.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Turn off track notifications
        </button>
      ) : (
        <button type="button" className="ghost small" disabled={busy} onClick={() => void enable()}>
          Notify me when new tracks are ready
        </button>
      )}
      {message && (
        <p className="tiny" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
