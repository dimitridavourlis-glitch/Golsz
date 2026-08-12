// GOLSZ — service worker: handles push notifications only (no offline
// caching — this project deliberately has no build step / asset
// versioning, so an SW cache would just risk serving stale HTML).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "GOLSZ";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/assets/favicon.png",
      badge: "/assets/favicon.png",
      data: { url: data.url || "/golsz-app.html" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/golsz-app.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // The existing-client path used to call w.focus() and DROP `url` on the
      // floor. api/send-push.js deliberately sets ?page=messages for a new DM
      // and ?page=profile for a new follower, and golsz-app.html's `page`
      // state initialises from that query param — so for the common case (the
      // PWA is already open) tapping "New message" just re-focused whatever
      // tab the athlete was already on and the notification did nothing.
      // Navigate FIRST, then focus.
      for (const w of wins) {
        if (!w.url.includes("golsz-app.html")) continue;
        // `navigate` is not available in every browser/context (and rejects
        // if the client has since been discarded), so every branch still
        // ends in a focus() — a focused-but-not-navigated window is a
        // degraded outcome, a lost tap is not.
        if ("navigate" in w) {
          return w.navigate(url)
            .then((c) => ((c || w).focus ? (c || w).focus() : undefined))
            .catch(() => ("focus" in w ? w.focus() : undefined));
        }
        if ("focus" in w) return w.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
