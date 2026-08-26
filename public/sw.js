const CACHE_PREFIX = "noyau-";
const SHELL = ["/manifest.webmanifest", "/icon.svg", "/favicon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"];
const NAVIGATION = "/__noyau-shell";

async function currentVersion() {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      return data.release || data.build || data.version || "dev";
    }
  } catch { /* hors ligne: on garde le cache existant */ }
  return null;
}

async function cacheName() {
  const version = await currentVersion();
  if (version) return `${CACHE_PREFIX}${version}`;
  const keys = await caches.keys();
  return keys.find((key) => key.startsWith(CACHE_PREFIX)) || `${CACHE_PREFIX}unknown`;
}

async function dropOtherCaches(keep) {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== keep).map((key) => caches.delete(key)));
}

async function purgeAll() {
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

async function openCache() {
  return caches.open(await cacheName());
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const name = await cacheName();
    const cache = await caches.open(name);
    await cache.addAll(SHELL).catch(() => {});
    try {
      const response = await fetch("/", { cache: "no-store" });
      if (response.ok && !response.redirected) {
        const html = await response.clone().text();
        const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
        if (assets.length) await cache.addAll(assets).catch(() => {});
        await cache.put(NAVIGATION, response);
      }
    } catch { /* la prochaine navigation en ligne remplira le shell */ }
    await dropOtherCaches(name);
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const name = await cacheName();
    await dropOtherCaches(name);
    await self.clients.claim();
    const windows = await clients.matchAll({ includeUncontrolled: true });
    windows.forEach((client) => client.postMessage({ type: "NOYAU_UPDATE", version: name.slice(CACHE_PREFIX.length) }));
  })());
});

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "NOYAU_PURGE") {
    event.waitUntil(purgeAll().then(() => event.source?.postMessage({ type: "NOYAU_PURGED" })));
    return;
  }
  if (type === "NOYAU_SKIP_WAITING") self.skipWaiting();
});

function cacheCopy(request, response) {
  if (!response.ok || response.redirected || response.type === "opaque") return;
  const copy = response.clone();
  openCache().then((cache) => cache.put(request, copy)).catch(() => {});
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // /api/ et /version.json ne doivent jamais etre servis depuis le cache.
  if (url.pathname.startsWith("/api/") || url.pathname === "/version.json") return;

  // Navigation: reseau d'abord, cache seulement en repli (un shell perime bloque l'app).
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && !response.redirected) {
            const copy = response.clone();
            openCache().then((cache) => cache.put(NAVIGATION, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(NAVIGATION).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Assets hashes: immuables, cache d'abord.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        cacheCopy(event.request, response);
        return response;
      })),
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        cacheCopy(event.request, response);
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || Response.error())),
  );
});

self.addEventListener("push", (event) => {
  const payload = event.data?.json() || {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title || "Noyau", {
        body: payload.body || "Nouvelle activité.",
        icon: payload.icon || "/icon-192.png",
        badge: "/icon-192.png",
        tag: payload.tag || "noyau",
        actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : [],
        data: { url: payload.url || "/", replyUrl: payload.replyUrl || payload.url || "/" },
      }),
      "setAppBadge" in self.navigator ? self.navigator.setAppBadge(1) : Promise.resolve(),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if ("clearAppBadge" in self.navigator) self.navigator.clearAppBadge();
  const destination = event.action === "reply" ? event.notification.data?.replyUrl : event.notification.data?.url;
  const target = new URL(destination || "/", self.location.origin).href;
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => client.url === target || client.url.startsWith(self.location.origin));
      if (!existing) return clients.openWindow(target);
      // iOS ignore client.navigate en mode application: on passe la destination a l'app elle-meme.
      return existing.focus().then((client) => {
        (client || existing).postMessage({ type: "NOYAU_NAVIGATE", url: target });
        return (client || existing).navigate?.(target)?.catch?.(() => {});
      });
    }),
  );
});
