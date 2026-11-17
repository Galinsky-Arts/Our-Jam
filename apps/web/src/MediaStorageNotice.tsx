// One clear explanation, reused wherever album audio or downloads depend on
// private S3-compatible storage that this server does not have configured.
export function MediaStorageNotice({
  context,
}: {
  context: "create" | "upload" | "release" | "listener";
}) {
  if (context === "listener")
    return (
      <p className="notice tiny" role="note">
        Track downloads are not available on this server yet: its private audio
        storage has not been connected.
      </p>
    );
  return (
    <div className="notice media-notice" role="note">
      <strong>Private audio storage is not connected on this server.</strong>
      {context === "create" ? (
        <p>
          You can still create the show. Your MP3/WAV files stay on this device:
          their length is measured here, and you play them from{" "}
          <em>Your local album backup</em> in the performer console. Uploading,
          server-side playback for other devices and release downloads stay off
          until storage is connected.
        </p>
      ) : context === "upload" ? (
        <p>
          Uploads are disabled and no file will be sent. Play songs from{" "}
          <em>Your local album backup</em> below instead.
        </p>
      ) : (
        <p>
          Released tracks cannot be stored or downloaded until storage is
          connected.
        </p>
      )}
      <details>
        <summary>What the server administrator must set</summary>
        <p className="tiny">
          In the hosting environment set <code>MEDIA_BUCKET</code>,{" "}
          <code>MEDIA_REGION</code>, <code>MEDIA_ACCESS_KEY_ID</code> and{" "}
          <code>MEDIA_SECRET_ACCESS_KEY</code> for a private S3-compatible
          bucket (plus <code>MEDIA_ENDPOINT</code> when it is not AWS), set{" "}
          <code>MEDIA_PROBE_ON_START=1</code> to verify read/write at startup,
          and redeploy. Platform administrators see the full status under{" "}
          <a href="/admin/configuration">Administration → Configuration</a>.
        </p>
      </details>
    </div>
  );
}
