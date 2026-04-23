// Ripple service worker: handles push notifications and click-to-open.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch (_) {
        data = { title: "ripple", body: "someone's here" };
      }

      // If any window is already visible, skip the notification (just a quiet ripple inside the app).
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const visibleClient = clientsList.find((c) => c.visibilityState === "visible");
      if (visibleClient) {
        visibleClient.postMessage({ type: "push-while-visible", data });
        return;
      }

      const title = data.title || "ripple";
      const body = data.body || "tap to ripple back";
      return self.registration.showNotification(title, {
        body,
        tag: data.tag || "ripple-presence",
        renotify: true,
        badge: "/icon.svg",
        icon: "/icon-192.png",
        data: { url: data.url || "/" },
        vibrate: [40, 60, 120],
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientsList) {
        if ("focus" in client) {
          client.postMessage({ type: "notification-click" });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
