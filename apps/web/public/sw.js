// Our Jam service worker: release notifications only (OJ-019). No caching.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(String(data.title || "Our Jam"), {
      body: String(data.body || "A new crowd-made track is ready."),
      icon: "/icon.svg",
      tag: String(data.tag || "our-jam"),
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list)
        if (new URL(client.url).origin === url.origin && "focus" in client) {
          client.navigate(url.href);
          return client.focus();
        }
      return self.clients.openWindow(url.href);
    }),
  );
});
