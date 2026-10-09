/*
 * Service worker for the installable CRM (PWA).
 *
 * Deliberately conservative: the CRM is live data (inbox, agenda), so
 * pages and API calls always go to the network. The worker only
 *   - caches hashed build assets (/_next/static, immutable) for speed,
 *   - shows /offline.html when a page can't load without connection.
 * Supabase, Meta and every other origin are never touched.
 *
 * It also shows Web Push notifications (handoff alerts, module web_push)
 * and opens the conversation when one is tapped.
 */
var VERSION = "v2";
var STATIC_CACHE = "static-" + VERSION;
var OFFLINE_CACHE = "offline-" + VERSION;
var OFFLINE_URL = "/offline.html";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then(function (cache) {
      return cache.addAll([OFFLINE_URL, "/logo-mark.png"]);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== STATIC_CACHE && key !== OFFLINE_CACHE;
          })
          .map(function (key) {
            return caches.delete(key);
          }),
      );
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") === 0) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
      }),
    );
    return;
  }

  if (url.pathname.indexOf("/_next/static/") === 0) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(function (cache) {
        return cache.match(request).then(function (hit) {
          if (hit) return hit;
          return fetch(request).then(function (response) {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        });
      }),
    );
  }
});

// ---- Web Push -------------------------------------------------------
// Payload (src/lib/push/send.ts): { title, body, url?, tag? }.
self.addEventListener("push", function (event) {
  var data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { body: event.data.text() };
    }
  }
  var title = data.title || "Agentes Sin Límite";
  var options = {
    body: data.body || "",
    icon: "/pwa-icon/192",
    badge: "/pwa-icon/192",
    data: { url: data.url || "/notifications" },
  };
  if (data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var path = (event.notification.data && event.notification.data.url) || "/";
  var target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clients) {
        for (var i = 0; i < clients.length; i++) {
          var client = clients[i];
          if (new URL(client.url).origin !== self.location.origin) continue;
          return client.focus().then(function (focused) {
            if (focused && "navigate" in focused) return focused.navigate(target);
            return focused;
          });
        }
        return self.clients.openWindow(target);
      }),
  );
});
